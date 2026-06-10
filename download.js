const { chromium } = require('playwright');
const path = require('path');
const cliProgress = require('cli-progress');

const url = process.argv[2];

if (!url) {
  console.error("Please provide a URL to download.");
  process.exit(1);
}

const extensionPath = path.join(__dirname); // The root directory contains manifest.json

(async () => {
  console.log(`Starting automated browser...`);
  
  // Launch Playwright with a persistent data directory so Widevine has time to initialize
  // If we use an empty string (''), Chrome creates a temporary profile and Widevine fails to load in time.
  const userDataDir = path.join(__dirname, '.chrome-profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // Chrome extensions only work reliably in headful mode for tabCapture
    channel: 'chrome', // CRITICAL: Use the real Google Chrome to ensure Widevine DRM is included
    ignoreDefaultArgs: ['--disable-component-update'], // CRITICAL: Playwright blocks component updates by default, which breaks Widevine!
    args: [
      `--enable-widevine`,
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      `--disable-gpu`, // Critical for bypassing Widevine black screen
      // We don't minimize to avoid macOS App Nap pausing the video render.
      // We recommend putting the browser window on a separate virtual desktop.
    ]
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  console.log(`Navigating to ${url}...`);
  await page.goto(url);

  console.log(`Waiting for video player...`);
  // Wait for the video element to appear
  await page.waitForSelector('video', { timeout: 30000 });
  
  // Attempt to play the video if it hasn't auto-started
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video && video.paused) {
      video.play().catch(e => console.error("Could not auto-play:", e));
    }
  });

  // Wait a few seconds for the video metadata to load (duration)
  await page.waitForTimeout(5000);

  const duration = await page.evaluate(() => {
    const video = document.querySelector('video');
    return video ? video.duration : null;
  });

  if (!duration || isNaN(duration)) {
    console.error("Could not determine video duration. Exiting.");
    await context.close();
    process.exit(1);
  }

  const durationMs = Math.ceil(duration * 1000);
  console.log(`Video duration is ${Math.ceil(duration / 60)} minutes. Starting capture...`);

  // Start capture via content script bridge
  await page.evaluate(() => {
    window.postMessage({ type: 'PLAYWRIGHT_START_CAPTURE' }, '*');
  });

  // Setup Progress Bar
  const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  bar.start(durationMs, 0);

  // Wait for the duration while updating progress bar
  const updateInterval = 1000;
  let elapsed = 0;
  const timer = setInterval(() => {
    elapsed += updateInterval;
    if (elapsed <= durationMs) {
      bar.update(elapsed);
    }
  }, updateInterval);

  await page.waitForTimeout(durationMs + 5000); // Wait full duration + 5 seconds buffer

  clearInterval(timer);
  bar.update(durationMs);
  bar.stop();

  console.log('Movie finished. Stopping capture and waiting for download to process...');

  // Setup download interceptor BEFORE sending stop command
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });

  // Stop capture
  await page.evaluate(() => {
    window.postMessage({ type: 'PLAYWRIGHT_STOP_CAPTURE' }, '*');
  });

  try {
    const download = await downloadPromise;
    const finalPath = path.join(process.cwd(), 'RTS_Recording.webm');
    await download.saveAs(finalPath);
    console.log(`\n✅ Success! Saved recording to: ${finalPath}`);
  } catch (err) {
    console.error("\n❌ Failed to intercept download:", err);
  }

  await context.close();
})();
