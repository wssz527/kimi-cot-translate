#!/usr/bin/env node
// Emit runtime-manifest.json for the self-updater. The manifest is committed and
// tagged with the release, so installed clients can compare versions and fetch
// the runtime files from an immutable tag URL without touching the GitHub API.
//
// Run with --check in CI to fail when the committed manifest is stale.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['runtime.mjs', 'runtime-hook.mjs', 'runtime-update.mjs', 'supported-runtimes.json', 'kct.js'];
const OUT = join(root, 'runtime-manifest.json');
const check = process.argv.includes('--check');

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const files = {};
for (const name of FILES) {
  const bytes = await readFile(join(root, name));
  files[name] = createHash('sha256').update(bytes).digest('hex');
}

const manifest = {
  version: pkg.version,
  base: `https://raw.githubusercontent.com/wssz527/kimi-cot-translate/v${pkg.version}`,
  files,
};

if (check) {
  const current = JSON.parse(await readFile(OUT, 'utf8').catch(() => '{}'));
  const same = current.version === manifest.version
    && current.base === manifest.base
    && JSON.stringify(current.files) === JSON.stringify(manifest.files);
  if (!same) {
    console.error('runtime-manifest.json is stale; run: node scripts/runtime-manifest.mjs');
    process.exitCode = 1;
  } else {
    console.log(`runtime-manifest.json matches ${pkg.version}`);
  }
} else {
  await writeFile(OUT, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote runtime-manifest.json for ${pkg.version}`);
}
