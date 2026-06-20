let recorder = null;
let chunks = [];

// Report capture status back to the service worker, which relays it to the page
// so the CLI can fail fast (and see the real error) instead of recording into
// the void for the whole movie duration.
function report(status, extra = {}) {
  chrome.runtime.sendMessage({ type: 'CAPTURE_STATUS', status, ...extra }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'START_CAPTURE') {
    startCapture(msg.streamId);
  } else if (msg.type === 'STOP_CAPTURE') {
    stopCapture();
  } else if (msg.type === 'CLEANUP_OFFSCREEN') {
    window.close();
  }
});

// Tell the service worker the listener above is live, so it can safely send
// START_CAPTURE without racing this document's startup.
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});

async function startCapture(streamId) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });

    // getUserMedia succeeded — distinguishes a capture-permission failure from a
    // "stream obtained but no data flowing" problem.
    report('stream-ok');

    // Record using default available codec (usually VP8/VP9) at a high bitrate
    recorder = new MediaRecorder(stream, {
      mimeType: 'video/webm',
      videoBitsPerSecond: 8000000
    });

    chunks = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        // First real chunk means capture is genuinely running — confirm it.
        if (chunks.length === 0) report('active');
        chunks.push(e.data);
      }
    };

    recorder.onerror = (e) => {
      report('error', { error: String((e && e.error) || 'MediaRecorder error') });
    };

    recorder.onstop = async () => {
      // Stop all media tracks to release the tab capture
      stream.getTracks().forEach(track => track.stop());

      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);

      // Send the object URL back to the service worker to trigger download
      await chrome.runtime.sendMessage({ type: 'SAVE_RECORDING', url });

      // Keep this document (and the blob URL) alive until the download has been
      // saved — otherwise closing here revokes the blob mid-download. The CLI
      // sends CLEANUP_OFFSCREEN once saveAs() completes; the timeout is a safety
      // net for the manual path (large files can take a while to flush to disk).
      setTimeout(() => window.close(), 600000);
    };

    // 1s timeslice so data flows continuously, enabling the early 'active' signal
    // above (and leaving usable data if the browser is interrupted).
    recorder.start(1000);
  } catch (error) {
    report('error', { error: String((error && error.message) || error) });
    console.error('Error starting capture in offscreen:', error);
  }
}

function stopCapture() {
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
  }
}
