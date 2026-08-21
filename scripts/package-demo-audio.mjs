#!/usr/bin/env node
/**
 * Package public/demo-audio/{zh,en} into public/demo-audio/demo-audio.zip
 * for the one-click download on the demo-audio listing page.
 *
 * Uses the system `zip` command (macOS/Linux; GitHub Actions has it too).
 * Usage: node scripts/package-demo-audio.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIR = resolve(ROOT, 'public/demo-audio');
const OUT = resolve(DIR, 'demo-audio.zip');

for (const sub of ['zh', 'en']) {
  if (!existsSync(resolve(DIR, sub))) {
    console.error(`missing ${sub}/ — run scripts/generate-demo-audio.mjs first`);
    process.exit(1);
  }
}

execFileSync('rm', ['-f', OUT]);
execFileSync('zip', ['-r', '-q', 'demo-audio.zip', 'zh', 'en'], { cwd: DIR });
const { statSync } = await import('node:fs');
console.log(`packaged → public/demo-audio/demo-audio.zip (${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`);
