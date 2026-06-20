#!/usr/bin/env node
// Stage a self-contained distribution of the CLI + extension into <destDir>.
// Run on each target OS (so node_modules carries the right native helpers) and
// then zipped by the release workflow. The bundle still requires Node.js and
// Google Chrome on the target machine — it packages the app, not its runtimes.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// App files needed at runtime (CLI + the unpacked extension it loads).
const APP_FILES = [
  'download.js',
  'notify.js',
  'background.js',
  'content.js',
  'offscreen.js',
  'offscreen.html',
  'manifest.json',
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  'urls.example.txt',
];

const WIN_LAUNCHER = `@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found.
  echo Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
if "%~1"=="" (
  if exist urls.txt (
    node download.js --file urls.txt
  ) else (
    echo Put one video URL per line in urls.txt and double-click this file,
    echo or run from a terminal:  run.cmd "https://www.rts.ch/play/..."
  )
) else (
  node download.js %*
)
pause
`;

const UNIX_LAUNCHER = `#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found."
  echo "Install it from https://nodejs.org and try again."
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi
if [ "$#" -eq 0 ]; then
  if [ -f urls.txt ]; then
    node download.js --file urls.txt
  else
    echo "Put one video URL per line in urls.txt and double-click this file,"
    echo "or run from a terminal:  ./run.command \\"https://www.rts.ch/play/...\\""
  fi
else
  node download.js "$@"
fi
`;

const USAGE_TXT = `RTS DRM Recorder
================

Requirements on this machine:
  1. Google Chrome (the real Chrome — used for Widevine/DRM playback).
  2. Node.js 18+  (https://nodejs.org).
  3. In Chrome, turn OFF "Use graphics acceleration when available"
     (chrome://settings/system), otherwise recordings are black.

Quick start:
  - Put one video URL per line in a file named "urls.txt", then
    double-click run.command (macOS) / run.cmd (Windows).
  - Or from a terminal in this folder:
        node download.js "https://www.rts.ch/play/..."
        node download.js --file urls.txt
        node download.js --test "https://www.rts.ch/play/..."   (20s check)

A desktop notification appears when the whole batch is finished.
Recordings are saved as .webm files in your Downloads folder by
default (use --out <dir> to change that). See README.md for all options.
`;

function main() {
  const dest = process.argv[2];
  if (!dest) {
    console.error('Usage: node scripts/build-bundle.js <destDir>');
    process.exit(1);
  }
  const destDir = path.resolve(dest);

  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  for (const file of APP_FILES) {
    const src = path.join(ROOT, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(destDir, file));
    else console.warn(`warn: missing ${file}, skipping`);
  }

  // Bundle production dependencies so the app runs offline (only Node + Chrome
  // are external requirements). SKIP_NODE_MODULES is for fast local smoke tests.
  if (!process.env.SKIP_NODE_MODULES) {
    const nm = path.join(ROOT, 'node_modules');
    if (!fs.existsSync(nm)) {
      console.error('error: node_modules not found — run `npm ci --omit=dev` first');
      process.exit(1);
    }
    fs.cpSync(nm, path.join(destDir, 'node_modules'), { recursive: true });
  }

  // OS-appropriate double-click launcher.
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    fs.writeFileSync(path.join(destDir, 'run.cmd'), WIN_LAUNCHER);
  } else {
    const launcher = path.join(destDir, 'run.command');
    fs.writeFileSync(launcher, UNIX_LAUNCHER);
    fs.chmodSync(launcher, 0o755);
  }

  fs.writeFileSync(path.join(destDir, 'USAGE.txt'), USAGE_TXT);

  console.log(`Bundle staged at ${destDir} (${isWindows ? 'Windows' : 'macOS'} launcher)`);
}

main();
