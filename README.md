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

#### Pre-built bundles (Windows / Apple Silicon)
The easiest way to get the CLI is from the [Releases page](../../releases): download `rts-drm-recorder-windows-x64.zip` or `rts-drm-recorder-macos-arm64.zip`, unzip it, and double-click `run.cmd` (Windows) or `run.command` (macOS). These bundles include the extension, the CLI, and its dependencies — you only need **Google Chrome** and **Node.js** installed, plus hardware acceleration turned off (see step 1). See `USAGE.txt` inside the bundle for a quick start.

> Maintainers: a release is built automatically when a `vX.Y.Z` tag is pushed (see [.github/workflows/release.yml](.github/workflows/release.yml)).

#### From source
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

### 5. Record Several Movies in a Batch
You can pass multiple URLs, or a file listing them, and they will be recorded one after another in a single browser session. Each video shows its own progress bar and an `[i/N]` counter, and a **desktop notification** (with sound) fires when the whole batch is finished.

Pass URLs directly:
```bash
node download.js "https://www.rts.ch/play/...one" "https://www.rts.ch/play/...two"
```

Or list them in a file (one per line; blank lines and `#` comments are ignored, and an optional output name can follow a `|`):
```bash
cp urls.example.txt urls.txt   # then edit urls.txt
node download.js --file urls.txt
```

Each recording is named after the video's page title (or the custom name from the list) and saved as a `.webm` file.

**Options**

| Option | Description |
| --- | --- |
| `-f, --file <path>` | Read targets from a newline-delimited file. |
| `-o, --out <dir>` | Directory to save recordings into (default: your **Downloads** folder). |
| `-t, --test [sec]` | Record only the first N seconds (default 20) of each video — a quick way to verify the capture/download chain without waiting for a full movie. |
| `--no-sound` | Show the completion notification silently. |
| `--no-notify` | Disable the completion notification entirely. |
| `-h, --help` | Show usage. |

> **Tip:** before kicking off a 2-hour recording, sanity-check your setup with `node download.js --test "<url>"`. The CLI also fails fast (within ~20s) with a clear message if the recorder never actually starts, instead of recording silence for the whole duration.

> The completion banner uses [`node-notifier`](https://github.com/mikaelbr/node-notifier), which works on macOS, Windows, and Linux out of the box.

## Technical Details (Manifest V3)
With Manifest V3, background Service Workers cannot use the `MediaRecorder` API. To get around this, the extension's background worker intercepts the active tab's `streamId` and spawns a hidden `offscreen.html` document. This offscreen document receives the stream, records it, and passes the resulting Blob URL back to the Service Worker for download.

For the CLI automation, Playwright injects a `content.js` script that acts as a bridge, allowing Playwright to send programmatic "Start" and "Stop" signals directly to the extension's background worker!
