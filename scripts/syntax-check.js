#!/usr/bin/env node
// Lightweight CI check: byte-compile every .js file and parse every .json file.
// Zero extra dependencies — proportionate to a small project, and enough to
// catch syntax errors and broken config before they reach main.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IGNORE = new Set(['node_modules', '.git', '.chrome-profile']);

/** Recursively collect files under `dir`, skipping ignored directories. */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORE.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name)));
    } else {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = walk(ROOT);
let failures = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file);
  if (file.endsWith('.js')) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      console.log(`ok   ${rel}`);
    } catch (err) {
      failures++;
      console.error(`FAIL ${rel}\n${err.stderr ? err.stderr.toString() : err.message}`);
    }
  } else if (file.endsWith('.json')) {
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
      console.log(`ok   ${rel}`);
    } catch (err) {
      failures++;
      console.error(`FAIL ${rel}\n${err.message}`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} file(s) failed validation.`);
  process.exit(1);
}
console.log('\nAll files passed validation.');
