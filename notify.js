const { execFile } = require('child_process');

// Guarded require: node-notifier bundles native helper binaries and is only used
// for a cosmetic end-of-run banner, so a missing/broken install must degrade to
// the native fallback rather than crash the whole CLI at module-load time.
let notifier = null;
try {
  notifier = require('node-notifier');
} catch (err) {
  notifier = null;
}

/**
 * Show a desktop notification banner (macOS / Windows / Linux).
 *
 * A notification is a "nice to have" at the end of a long run, so every failure
 * is swallowed: it must never crash a finished recording session.
 *
 * @param {object}  opts
 * @param {string}  opts.title    Banner title.
 * @param {string}  opts.message  Banner body text.
 * @param {boolean} [opts.sound]  Play the default system sound (default: true).
 * @returns {Promise<void>} Resolves once the banner has been dispatched.
 */
function notify({ title, message, sound = true }) {
  if (!notifier) return nativeFallback({ title, message, sound });

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    // node-notifier's completion callback only fires when the OS toast is
    // dismissed or times out (~10 s), but the banner is dispatched almost
    // immediately and the helper process survives our process.exit(). So we
    // resolve after a short grace window instead of blocking on that callback.
    const grace = setTimeout(finish, 800);
    if (grace.unref) grace.unref();

    try {
      notifier.notify({ title, message, sound, timeout: 5 }, (err) => {
        // Real failures (missing helper binary, unsupported OS) are reported
        // here asynchronously — fall back to the native command when they occur.
        if (err) {
          clearTimeout(grace);
          nativeFallback({ title, message, sound }).finally(finish);
        }
        // On success the grace timer resolves us; the banner is already shown.
      });
    } catch (err) {
      clearTimeout(grace);
      nativeFallback({ title, message, sound }).finally(finish);
    }
  });
}

/**
 * Best-effort native fallback used if node-notifier is unavailable or fails.
 * Currently covers macOS (osascript); other platforms resolve silently.
 */
function nativeFallback({ title, message, sound }) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve();
    const escape = (s) => String(s).replace(/["\\]/g, '\\$&');
    const soundClause = sound ? ' sound name "Glass"' : '';
    const script = `display notification "${escape(message)}" with title "${escape(title)}"${soundClause}`;
    execFile('osascript', ['-e', script], () => resolve());
  });
}

module.exports = { notify };
