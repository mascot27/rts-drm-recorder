# RTS DRM Recorder

A minimal Chrome Extension to bypass Widevine/PlayReady DRM black screens by directly capturing the active tab's media output stream using the `chrome.tabCapture` API. Originally designed to download offline copies of films from RTS Play.

## How it Works
Traditional downloaders like `yt-dlp` cannot decrypt DRM-encrypted HLS and DASH streams without private keys. Instead of trying to decrypt the stream, this extension acts as an isolated screen recorder. It grabs the uncompressed video and audio stream directly from Chrome's render pipeline as the video plays, and saves it into a high-quality `.webm` file.

## ⚠️ Disclaimer
**This tool is provided for educational purposes and personal use only** (e.g., creating offline backups of media you have legally licensed for viewing while traveling, in accordance with local private copy laws). This tool does not strip, crack, or bypass DRM cryptography; it utilizes native browser APIs to record the output stream. Do not use this extension to pirate, redistribute, or infringe upon the copyrights of content owners.

## Installation & Usage

### 1. Disable Hardware Acceleration (Crucial Step)
If you skip this step, Widevine DRM will block the capture and your recording will result in a black screen.
1. Go to `chrome://settings/system` in your Chrome address bar.
2. Toggle **OFF** "Use graphics acceleration when available".
3. Click the **Relaunch** button that appears.

### 2. Load the Extension
1. Open Chrome and navigate to `chrome://extensions/`.
2. Turn on **Developer mode** (toggle switch in the top right corner).
3. Click the **Load unpacked** button.
4. Select the root folder of this repository.

### 3. Record a Movie (Manual Mode)
1. Navigate to the video you want to record.
2. Start playing the video to ensure the stream loads.
3. Click the **"RTS DRM Recorder" extension icon** in your Chrome toolbar.
4. A red **`REC`** badge will appear. Chrome will show a blue rectangle around the tab indicating it is being captured.
5. Let the movie play through. You can move the Chrome window to another virtual desktop, but **do not minimize the window**, as macOS will pause video rendering for minimized windows.
6. When finished, click the extension icon again. The file `RTS_Recording.webm` will automatically download.

### 4. Record a Movie (Automated CLI Mode)
If you prefer not to click manually, you can use the automated CLI script built with Node.js and Playwright. It will automatically launch Chrome, inject the extension, click play, wait for the exact duration of the movie, and save the final file.

1. Install dependencies:
   ```bash
   npm install
   npx playwright install chromium
   ```
2. Run the script with your target URL:
   ```bash
   node download.js "https://www.rts.ch/play/tv/film/video/007-spectre?urn=urn:rts:video:..."
   ```
3. A progress bar will show the remaining time. Leave the automated browser window open on a separate desktop.

## Technical Details (Manifest V3)
With Manifest V3, background Service Workers cannot use the `MediaRecorder` API. To get around this, the extension's background worker intercepts the active tab's `streamId` and spawns a hidden `offscreen.html` document. This offscreen document receives the stream, records it, and passes the resulting Blob URL back to the Service Worker for download.

For the CLI automation, Playwright injects a `content.js` script that acts as a bridge, allowing Playwright to send programmatic "Start" and "Stop" signals directly to the extension's background worker!
