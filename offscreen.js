let recorder = null;
let chunks = [];

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'START_CAPTURE') {
    startCapture(msg.streamId);
  } else if (msg.type === 'STOP_CAPTURE') {
    stopCapture();
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

    // Record using default available codec (usually VP8/VP9) at a high bitrate
    recorder = new MediaRecorder(stream, { 
      mimeType: 'video/webm',
      videoBitsPerSecond: 8000000 
    });

    chunks = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    recorder.onstop = async () => {
      // Stop all media tracks to release the tab capture
      stream.getTracks().forEach(track => track.stop());
      
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      
      // Send the object URL back to the service worker to trigger download
      await chrome.runtime.sendMessage({ type: 'SAVE_RECORDING', url });
      
      // Close the offscreen document to clean up
      window.close();
    };

    recorder.start();
  } catch (error) {
    console.error('Error starting capture in offscreen:', error);
  }
}

function stopCapture() {
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
  }
}
