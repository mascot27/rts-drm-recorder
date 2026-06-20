// Resolves once a freshly created offscreen document reports that its message
// listener is live (see offscreen.js). createDocument() resolving does NOT
// guarantee that, so without this handshake START_CAPTURE can be dispatched to a
// document that isn't listening yet and is silently dropped.
let resolveOffscreenReady = null;
function offscreenReadySignal() {
  return new Promise((resolve) => {
    resolveOffscreenReady = resolve;
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'OFFSCREEN_READY' && resolveOffscreenReady) {
    resolveOffscreenReady();
    resolveOffscreenReady = null;
  }
});

async function setupOffscreenDocument(path) {
  const offscreenUrl = chrome.runtime.getURL(path);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) {
    return; // already created and listening
  }

  // Arm the readiness wait BEFORE creating the document so the signal can't be missed.
  const ready = offscreenReadySignal();
  await chrome.offscreen.createDocument({
    url: path,
    reasons: ['USER_MEDIA'],
    justification: 'Recording the active tab for offline viewing'
  });
  // Time-boxed so a missed signal degrades to the old behaviour instead of hanging.
  await Promise.race([ready, new Promise((r) => setTimeout(r, 3000))]);
}

chrome.action.onClicked.addListener(async (tab) => {
  const { recordingState = 'idle' } = await chrome.storage.session.get('recordingState');

  if (recordingState === 'starting' || recordingState === 'stopping') return;

  if (recordingState === 'idle') {
    await chrome.storage.session.set({ recordingState: 'starting' });
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      
      await setupOffscreenDocument('offscreen.html');
      
      await chrome.runtime.sendMessage({ 
        type: 'START_CAPTURE', 
        streamId: streamId 
      });
      
      await chrome.storage.session.set({ recordingState: 'recording' });
      await chrome.action.setBadgeText({ text: 'REC' });
      await chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });
    } catch (err) {
      console.error('Failed to start recording:', err);
      await chrome.storage.session.set({ recordingState: 'idle' });
      await chrome.action.setBadgeText({ text: 'ERR' });
    }
  } else if (recordingState === 'recording') {
    await chrome.storage.session.set({ recordingState: 'stopping' });
    try { 
      await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
    } finally {
      await chrome.storage.session.set({ recordingState: 'idle' });
      await chrome.action.setBadgeText({ text: '' });
    }
  }
});

// Programmatic control for CLI
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CLI_START_CAPTURE' && sender.tab) {
    (async () => {
      await chrome.storage.session.set({ recordingState: 'starting' });
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: sender.tab.id });
      await setupOffscreenDocument('offscreen.html');
      await chrome.runtime.sendMessage({ type: 'START_CAPTURE', streamId: streamId });
      await chrome.storage.session.set({ recordingState: 'recording' });
      await chrome.action.setBadgeText({ text: 'REC' });
      await chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });
    })();
  } else if (msg.type === 'CLI_STOP_CAPTURE') {
    (async () => {
      await chrome.storage.session.set({ recordingState: 'stopping' });
      await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
      await chrome.storage.session.set({ recordingState: 'idle' });
      await chrome.action.setBadgeText({ text: '' });
    })();
  }
});

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'SAVE_RECORDING') {
    // Check if we are running from CLI by checking storage
    // If from CLI, we send the URL to the active tab to trigger a page download
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'TRIGGER_DOWNLOAD', url: msg.url });
    } else {
      chrome.downloads.download({
        url: msg.url,
        filename: 'RTS_Recording.webm',
        saveAs: true
      });
    }
  }
});
