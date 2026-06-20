// Listen for commands from Playwright
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'PLAYWRIGHT_START_CAPTURE') {
    chrome.runtime.sendMessage({ type: 'CLI_START_CAPTURE' });
  } else if (event.data && event.data.type === 'PLAYWRIGHT_STOP_CAPTURE') {
    chrome.runtime.sendMessage({ type: 'CLI_STOP_CAPTURE' });
  } else if (event.data && event.data.type === 'PLAYWRIGHT_CLEANUP') {
    chrome.runtime.sendMessage({ type: 'CLI_CLEANUP' });
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TRIGGER_DOWNLOAD') {
    const a = document.createElement('a');
    a.href = msg.url;
    a.download = 'RTS_Recording.webm';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } else if (msg.type === 'EXT_STATUS') {
    // Relay extension capture status to the page so Playwright (the CLI) can read it.
    window.postMessage({ type: 'EXT_STATUS', status: msg.status, error: msg.error }, '*');
  }
});
