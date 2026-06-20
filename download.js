const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
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
      --no-mute       Don't mute the system output while recording (audio plays
                      out loud; by default the speakers are muted on macOS).
      --no-sound      Show the completion notification without a sound.
      --no-notify     Do not show a desktop notification when finished.
  -h, --help          Show this help.

You can mix several URLs and a --file; everything is recorded sequentially in a
single browser session. Output names are derived from each video's page title
unless overridden in the --file list.`;

/** The OS "Downloads" folder if it exists, otherwise the current directory. */
function defaultOutDir() {
  const home = os.homedir();
  if (home) {
    const downloads = path.join(home, 'Downloads');
    if (fs.existsSync(downloads)) return downloads;
  }
  return process.cwd();
}

/**
 * Parse argv into a list of targets and options.
 */
function parseArgs(argv) {
  const targets = [];
  let outDir = defaultOutDir();
  let sound = true;
  let notifyOnDone = true;
  let testSeconds = null;
  let muteSpeakers = true;

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
      case '--no-mute':
        muteSpeakers = false;
        break;
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

  return { targets, outDir, sound, notifyOnDone, testSeconds, muteSpeakers };
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
 * Mute/restore the OS output so a long recording doesn't play out loud. The
 * captured tab audio is taken inside Chrome, before the OS output, so muting the
 * speakers does NOT silence the recording. macOS only; a no-op elsewhere.
 */
function createSpeakerMuter(enabled) {
  if (!enabled || process.platform !== 'darwin') {
    return { mute() {}, restore() {} };
  }
  let saved = null;
  return {
    mute() {
      try {
        saved = execSync("osascript -e 'output volume of (get volume settings)'").toString().trim();
        execSync("osascript -e 'set volume output volume 0'");
      } catch (err) {
        saved = null;
      }
    },
    restore() {
      if (saved == null) return;
      try {
        execSync(`osascript -e 'set volume output volume ${saved}'`);
      } catch (err) {
        /* best effort */
      }
      saved = null;
    },
  };
}

/**
 * Record a single target into outDir by capturing the tab with getDisplayMedia
 * and streaming the MediaRecorder output to disk.
 *
 * @param {import('playwright').Page} page
 * @param {{stream: fs.WriteStream|null, bytes: number, doneResolve: (() => void)|null}} sink
 * @returns {Promise<{ ok: boolean, file?: string, error?: string }>}
 */
async function recordOne(page, sink, target, index, total, outDir, testSeconds) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[${index}/${total}] ${target.url}`);

  console.log('Navigating…');
  await page.goto(target.url, { waitUntil: 'domcontentloaded' });

  console.log('Waiting for video player…');
  await page.waitForSelector('video', { timeout: 45000 });

  // Nudge the player into playing if it didn't auto-start.
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video && video.paused) video.play().catch(() => {});
  });

  // Give the player a few seconds to expose real metadata (duration).
  await page.waitForTimeout(8000);

  const meta = await page.evaluate(() => {
    const video = document.querySelector('video');
    return { duration: video ? video.duration : null, title: document.title };
  });

  if (!meta.duration || isNaN(meta.duration) || !isFinite(meta.duration)) {
    return {
      ok: false,
      error: 'Could not determine video duration (player not loaded — accept the cookie banner once in this profile?).',
    };
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

  // Open the output stream; chunks arrive via the exposed __rtsWriteChunk binding.
  sink.stream = fs.createWriteStream(finalPath);
  sink.bytes = 0;
  const finished = new Promise((resolve) => {
    sink.doneResolve = resolve;
  });

  const closeSink = async () => {
    if (!sink.stream) return;
    const stream = sink.stream;
    sink.stream = null;
    sink.doneResolve = null;
    await new Promise((resolve) => stream.end(resolve));
  };

  // Inject an in-page recorder. We capture the tab with getDisplayMedia
  // (auto-accepted via --auto-accept-this-tab-capture) rather than a Chrome
  // extension: Chrome 137+ no longer loads unpacked extensions from the command
  // line, and tabCapture needs a user gesture the CLI cannot provide.
  // getDisplayMedia itself requires a gesture, so we click an injected button.
  await page.evaluate(() => {
    window.__rtsRec = { recording: false, error: null };
    const abToB64 = (ab) => {
      const bytes = new Uint8Array(ab);
      let binary = '';
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      }
      return btoa(binary);
    };
    const btn = document.createElement('button');
    btn.id = '__rtsrec_btn';
    btn.textContent = '●';
    Object.assign(btn.style, {
      position: 'fixed', top: '0', left: '0', width: '40px', height: '28px',
      opacity: '0.01', zIndex: '2147483647',
    });
    btn.onclick = async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true, audio: true, preferCurrentTab: true,
        });
        btn.remove(); // keep the capture button out of the recording
        const rec = new MediaRecorder(stream, { mimeType: 'video/webm', videoBitsPerSecond: 8000000 });
        // Serialize chunk conversion+writes so the file is assembled in order.
        let chain = Promise.resolve();
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            const part = e.data;
            chain = chain.then(async () => {
              const ab = await part.arrayBuffer();
              await window.__rtsWriteChunk(abToB64(ab));
            });
          }
        };
        rec.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          chain = chain.then(() => window.__rtsDone());
        };
        window.__rtsStop = () => { if (rec.state !== 'inactive') rec.stop(); };
        rec.start(1000); // 1s timeslice → continuous streaming + early confirmation
        window.__rtsRec.recording = true;
      } catch (e) {
        window.__rtsRec.error = String((e && e.message) || e);
      }
    };
    document.body.appendChild(btn);
  });

  // The click provides the user gesture getDisplayMedia requires.
  await page.click('#__rtsrec_btn', { force: true });

  // Fail fast: confirm capture actually started instead of recording nothing.
  try {
    await page.waitForFunction(() => window.__rtsRec.recording || window.__rtsRec.error, { timeout: 20000 });
  } catch (err) {
    await closeSink();
    fs.rmSync(finalPath, { force: true });
    return { ok: false, error: 'Capture never started within 20s (getDisplayMedia did not respond).' };
  }
  const recErr = await page.evaluate(() => window.__rtsRec.error);
  if (recErr) {
    await closeSink();
    fs.rmSync(finalPath, { force: true });
    return { ok: false, error: `Capture failed: ${recErr}` };
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
    await page.waitForTimeout(recordMs);
    bar.update(recordSec);
    bar.stop();
    clearInterval(timer);

    // Stop the recorder; the page flushes remaining chunks then calls __rtsDone.
    await page.evaluate(() => window.__rtsStop && window.__rtsStop());
    await Promise.race([
      finished,
      new Promise((_, reject) => setTimeout(() => reject(new Error('flush timed out')), 120000)),
    ]);
    await closeSink();

    const size = fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0;
    if (size === 0) {
      fs.rmSync(finalPath, { force: true });
      return { ok: false, error: 'Recording produced an empty file.' };
    }
    console.log(`✅ Saved: ${finalPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    return { ok: true, file: finalPath };
  } catch (err) {
    clearInterval(timer);
    bar.stop();
    try { await page.evaluate(() => window.__rtsStop && window.__rtsStop()); } catch (e) { /* ignore */ }
    await closeSink();
    return { ok: false, error: `Recording failed: ${err.message}` };
  } finally {
    clearInterval(timer);
    bar.stop();
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

  const { targets, outDir, sound, notifyOnDone, testSeconds, muteSpeakers } = options;

  if (targets.length === 0) {
    console.error('Error: no video URLs provided.\n');
    console.error(USAGE);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Starting automated browser for ${targets.length} video(s)…`);

  // Persistent profile so Widevine has time to initialize and the RTS cookie
  // consent is remembered (a temp profile re-triggers both every run).
  const userDataDir = path.join(__dirname, '.chrome-profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // capture/Widevine only work in headful Chrome
    channel: 'chrome', // real Chrome ships the Widevine DRM module
    ignoreDefaultArgs: ['--disable-component-update'], // let Chrome fetch/refresh Widevine
    args: [
      '--enable-widevine',
      '--disable-gpu', // avoids the Widevine black-screen issue
      '--auto-accept-this-tab-capture', // auto-accept getDisplayMedia({preferCurrentTab})
    ],
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  // Disk sink shared with the page: the recorder streams base64 chunks here so a
  // multi-hour recording never has to live entirely in memory.
  const sink = { stream: null, bytes: 0, doneResolve: null };
  await page.exposeFunction('__rtsWriteChunk', (b64) => {
    if (!sink.stream) return;
    const buf = Buffer.from(b64, 'base64');
    sink.bytes += buf.length;
    sink.stream.write(buf);
  });
  await page.exposeFunction('__rtsDone', () => {
    if (sink.doneResolve) sink.doneResolve();
  });

  const muter = createSpeakerMuter(muteSpeakers);
  const restore = () => muter.restore();
  process.once('exit', restore);
  process.once('SIGINT', () => { restore(); process.exit(130); });
  process.once('SIGTERM', () => { restore(); process.exit(143); });

  const results = [];
  muter.mute();
  try {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      try {
        const result = await recordOne(page, sink, target, i + 1, targets.length, outDir, testSeconds);
        results.push({ target, ...result });
        if (!result.ok) console.error(`❌ ${target.url} — ${result.error}`);
      } catch (err) {
        console.error(`❌ ${target.url} — ${err.message}`);
        results.push({ target, ok: false, error: err.message });
      }
    }
  } finally {
    muter.restore(); // restore before the notification so its sound is audible
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
