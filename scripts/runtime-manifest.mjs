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
// One manifest per entry point. They deploy different file sets, so a single
// shared list would either short-change the Windows bundle or hand the macOS
// loader files it never installs.
const MANIFESTS = [
  { out: 'runtime-manifest.json',
    files: ['runtime.mjs', 'runtime-hook.mjs', 'runtime-update.mjs', 'supported-runtimes.json', 'kct.js'] },
  { out: 'runtime-manifest-windows.json',
    files: ['runtime-windows.mjs', 'runtime.mjs', 'runtime-hook.mjs', 'runtime-update.mjs',
      'windows-bridge.ps1', 'supported-windows-runtimes.json', 'supported-runtimes.json', 'kct.js'] },
];
const check = process.argv.includes('--check');

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

for (const { out, files: names } of MANIFESTS) {
  const files = {};
  for (const name of names) {
    const bytes = await readFile(join(root, name));
    files[name] = createHash('sha256').update(bytes).digest('hex');
  }
  const manifest = {
    version: pkg.version,
    base: `https://raw.githubusercontent.com/wssz527/kimi-cot-translate/v${pkg.version}`,
    files,
  };
  const OUT = join(root, out);
  if (check) {
    const current = JSON.parse(await readFile(OUT, 'utf8').catch(() => '{}'));
    const same = current.version === manifest.version
      && current.base === manifest.base
      && JSON.stringify(current.files) === JSON.stringify(manifest.files);
    if (!same) {
      console.error(`${out} is stale; run: node scripts/runtime-manifest.mjs`);
      process.exitCode = 1;
    } else {
      console.log(`${out} matches ${pkg.version}`);
    }
  } else {
    await writeFile(OUT, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote ${out} for ${pkg.version}`);
  }
}
