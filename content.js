// Content-script bridge between Playwright (page window messages) and the
// extension's service worker. Logs are prefixed "RTSREC:" so the CLI can surface
// them via Playwright's console capture — a channel that does not depend on the
// service worker being able to message back into the tab.
console.log('RTSREC: content script loaded');

// Listen for commands from Playwright
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'PLAYWRIGHT_START_CAPTURE') {
    console.log('RTSREC: relaying START_CAPTURE to service worker');
    chrome.runtime.sendMessage({ type: 'CLI_START_CAPTURE' });
  } else if (event.data && event.data.type === 'PLAYWRIGHT_STOP_CAPTURE') {
    console.log('RTSREC: relaying STOP_CAPTURE to service worker');
    chrome.runtime.sendMessage({ type: 'CLI_STOP_CAPTURE' });
  } else if (event.data && event.data.type === 'PLAYWRIGHT_CLEANUP') {
    chrome.runtime.sendMessage({ type: 'CLI_CLEANUP' });
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TRIGGER_DOWNLOAD') {
    console.log('RTSREC: TRIGGER_DOWNLOAD received');
    const a = document.createElement('a');
    a.href = msg.url;
    a.download = 'RTS_Recording.webm';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } else if (msg.type === 'EXT_STATUS') {
    console.log(`RTSREC: status=${msg.status}${msg.error ? ' error=' + msg.error : ''}`);
    // Relay extension capture status to the page so Playwright (the CLI) can read it.
    window.postMessage({ type: 'EXT_STATUS', status: msg.status, error: msg.error }, '*');
  }
});
