const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cliProgress = require('cli-progress');
const { notify } = require('./notify');

const USAGE = `RTS DRM Recorder — batch CLI

Usage:
  node download.js <url> [<url> ...] [options]
  node download.js --file urls.txt [options]

Options:
  -f, --file <path>   Read targets from a file (one per line). Blank lines and
                      lines starting with "#" are ignored. An optional custom
                      output name can follow the URL after a "|":
                          https://www.rts.ch/play/...  |  My Movie
  -o, --out <dir>     Directory to save recordings into (default: Downloads).
  -t, --test [sec]    Record only the first N seconds of each video (default 20)
                      to quickly verify the whole capture/download chain works.
      --no-sound      Show the completion notification without a sound.
      --no-notify     Do not show a desktop notification when finished.
  -h, --help          Show this help.

You can mix several URLs and a --file; everything is recorded sequentially in a
single browser session. Output names are derived from each video's page title
unless overridden in the --file list.`;

/**
 * Parse argv into a list of targets and options.
 * @returns {{ targets: {url: string, name: string|null}[], outDir: string, sound: boolean, notifyOnDone: boolean }}
 */
/** The OS "Downloads" folder if it exists, otherwise the current directory. */
function defaultOutDir() {
  const home = os.homedir();
  if (home) {
    const downloads = path.join(home, 'Downloads');
    if (fs.existsSync(downloads)) return downloads;
  }
  return process.cwd();
}

function parseArgs(argv) {
  const targets = [];
  let outDir = defaultOutDir();
  let sound = true;
  let notifyOnDone = true;
  let testSeconds = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
        break;
      case '-f':
      case '--file': {
        const file = argv[++i];
        if (!file || file.startsWith('-')) throw new Error(`${arg} requires a path`);
        targets.push(...readUrlList(file));
        break;
      }
      case '-o':
      case '--out': {
        const dir = argv[++i];
        if (!dir || dir.startsWith('-')) throw new Error(`${arg} requires a directory`);
        outDir = path.resolve(dir);
        break;
      }
      case '-t':
      case '--test': {
        // Optional numeric value; defaults to 20s if the next arg isn't a number.
        const next = argv[i + 1];
        if (next !== undefined && /^\d+$/.test(next)) {
          testSeconds = parseInt(next, 10);
          i++;
        } else {
          testSeconds = 20;
        }
        if (testSeconds < 1) throw new Error('--test requires a positive number of seconds');
        break;
      }
      case '--no-sound':
        sound = false;
        break;
      case '--no-notify':
        notifyOnDone = false;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        targets.push({ url: arg, name: null });
    }
  }

  return { targets, outDir, sound, notifyOnDone, testSeconds };
}

/**
 * Read a newline-delimited list of targets from a file.
 * Each line is "<url>" or "<url> | <custom name>".
 */
function readUrlList(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const sep = line.indexOf('|');
      if (sep === -1) return { url: line, name: null };
      return {
        url: line.slice(0, sep).trim(),
        name: line.slice(sep + 1).trim() || null,
      };
    })
    .filter((target) => target.url); // drop lines like "| name" with no URL
}

/** Turn an arbitrary string into a safe-ish file name (without extension). */
function sanitizeFilename(name) {
  return name
    .replace(/[/\\?%*:|"<>]/g, '') // characters illegal on common filesystems
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Return a non-colliding absolute path for `<dir>/<base>.webm`. */
function uniquePath(dir, base) {
  let candidate = path.join(dir, `${base}.webm`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n}).webm`);
    n++;
  }
  return candidate;
}

const formatHMS = (t) => {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
};

/**
 * Record a single target into outDir.
 * @returns {Promise<{ ok: boolean, file?: string, error?: string }>}
 */
async function recordOne(page, target, index, total, outDir, testSeconds) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[${index}/${total}] ${target.url}`);

  console.log('Navigating…');
  await page.goto(target.url, { waitUntil: 'domcontentloaded' });

  console.log('Waiting for video player…');
  await page.waitForSelector('video', { timeout: 30000 });

  // Nudge the player into playing if it didn't auto-start.
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video && video.paused) {
      video.play().catch((e) => console.error('Could not auto-play:', e));
    }
  });

  // Give the player a few seconds to expose real metadata (duration).
  await page.waitForTimeout(5000);

  const meta = await page.evaluate(() => {
    const video = document.querySelector('video');
    return { duration: video ? video.duration : null, title: document.title };
  });

  if (!meta.duration || isNaN(meta.duration) || !isFinite(meta.duration)) {
    return { ok: false, error: 'Could not determine video duration' };
  }

  const durationSec = Math.ceil(meta.duration);
  const recordSec = testSeconds ? Math.min(testSeconds, durationSec) : durationSec;
  const recordMs = recordSec * 1000;
  const base = sanitizeFilename(target.name || meta.title) || `RTS_Recording_${index}`;
  const finalPath = uniquePath(outDir, base);

  console.log(
    `Video: "${base}" — ${Math.ceil(meta.duration / 60)} min` +
      (testSeconds ? ` (test mode: recording ${recordSec}s only)` : '')
  );

  // Send STOP at most once, but guarantee it runs even on a mid-recording
  // failure — otherwise a still-running recorder corrupts the next video.
  let stopSent = false;
  const stopCapture = async () => {
    if (stopSent) return;
    stopSent = true;
    try {
      await page.evaluate(() => window.postMessage({ type: 'PLAYWRIGHT_STOP_CAPTURE' }, '*'));
    } catch (err) {
      // Best-effort: the page may already be gone.
    }
  };

  // Start listening for the extension's capture-status relay BEFORE starting, so
  // the 'active'/'error' signal can't be missed.
  await page.evaluate(() => {
    window.__rtsStatuses = [];
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'EXT_STATUS') window.__rtsStatuses.push(e.data);
    });
  });

  // Tell the extension (via the content-script bridge) to start capturing.
  await page.evaluate(() => window.postMessage({ type: 'PLAYWRIGHT_START_CAPTURE' }, '*'));

  // Fail fast: wait for a terminal signal ('active' = recording confirmed, or
  // 'error') rather than discovering a silent failure only after the whole movie
  // duration has elapsed.
  try {
    await page.waitForFunction(
      () => window.__rtsStatuses.some((s) => s.status === 'active' || s.status === 'error'),
      { timeout: 20000 }
    );
  } catch (err) {
    await stopCapture();
    const seen = await page.evaluate(() => window.__rtsStatuses || []);
    const trail = seen.length
      ? ` Signals seen: ${seen.map((s) => s.status + (s.error ? ` (${s.error})` : '')).join(', ')}.`
      : ' No signals received at all.';
    return {
      ok: false,
      error:
        'Capture never started within 20s.' +
        trail +
        ' Check that Chrome hardware acceleration is OFF and that Widevine is enabled.',
    };
  }
  const terminal = await page.evaluate(
    () => window.__rtsStatuses.find((s) => s.status === 'active' || s.status === 'error')
  );
  if (terminal.status === 'error') {
    await stopCapture();
    return { ok: false, error: `Recorder error: ${terminal.error || 'unknown'}` };
  }

  const bar = new cliProgress.SingleBar(
    {
      format: 'Recording [{bar}] {percentage}% | ETA: {eta_formatted} | Elapsed: {duration_formatted}',
      formatTime: formatHMS,
    },
    cliProgress.Presets.shades_classic
  );
  bar.start(recordSec, 0);

  let elapsedSec = 0;
  const timer = setInterval(() => {
    elapsedSec += 1;
    if (elapsedSec <= recordSec) bar.update(elapsedSec);
  }, 1000);

  try {
    await page.waitForTimeout(recordMs + 5000); // record window + buffer
    bar.update(recordSec);
    bar.stop();
    clearInterval(timer);

    // Arm the download interceptor BEFORE asking the extension to stop/flush.
    const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
    await stopCapture();
    const download = await downloadPromise;
    await download.saveAs(finalPath);
    // The file is on disk — let the offscreen doc release the blob now.
    await page.evaluate(() => window.postMessage({ type: 'PLAYWRIGHT_CLEANUP' }, '*'));
    console.log(`✅ Saved: ${finalPath}`);
    return { ok: true, file: finalPath };
  } catch (err) {
    return { ok: false, error: `Recording failed: ${err.message}` };
  } finally {
    clearInterval(timer);
    bar.stop();
    await stopCapture();
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}\n`);
    console.error(USAGE);
    process.exit(1);
  }

  const { targets, outDir, sound, notifyOnDone, testSeconds } = options;

  if (targets.length === 0) {
    console.error('Error: no video URLs provided.\n');
    console.error(USAGE);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Starting automated browser for ${targets.length} video(s)…`);

  const extensionPath = path.join(__dirname); // root contains manifest.json
  // Persistent profile so Widevine has time to initialize (a temp profile
  // makes Chrome create a fresh CDM that fails to load in time).
  const userDataDir = path.join(__dirname, '.chrome-profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // tabCapture only works reliably in headful Chrome
    channel: 'chrome', // real Chrome ensures Widevine DRM is present
    ignoreDefaultArgs: ['--disable-component-update'], // Playwright blocks component updates → breaks Widevine
    args: [
      '--enable-widevine',
      '--mute-audio', // silence local speakers; tabCapture still records audio
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--disable-gpu', // avoids the Widevine black-screen issue
    ],
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    try {
      const result = await recordOne(page, target, i + 1, targets.length, outDir, testSeconds);
      results.push({ target, ...result });
      if (!result.ok) console.error(`❌ ${target.url} — ${result.error}`);
    } catch (err) {
      console.error(`❌ ${target.url} — ${err.message}`);
      results.push({ target, ok: false, error: err.message });
    }
  }

  await context.close();

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Done. ${succeeded.length} succeeded, ${failed.length} failed.`);
  for (const r of results) {
    if (r.ok) console.log(`  ✅ ${path.basename(r.file)}`);
    else console.log(`  ❌ ${r.target.url} — ${r.error}`);
  }

  if (notifyOnDone) {
    const title = failed.length === 0 ? 'RTS Recorder — all done' : 'RTS Recorder — finished with errors';
    const message =
      targets.length === 1 && succeeded.length === 1
        ? `Saved ${path.basename(succeeded[0].file)}`
        : `${succeeded.length}/${targets.length} recordings saved` +
          (failed.length ? `, ${failed.length} failed` : '');
    await notify({ title, message, sound });
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

module.exports = { parseArgs, readUrlList, sanitizeFilename, uniquePath, formatHMS, defaultOutDir };

if (require.main === module) {
  main();
}
