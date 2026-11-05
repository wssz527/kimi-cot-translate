#!/usr/bin/env node
// Emit runtime-manifest.json for the self-updater. The manifest is committed and
// tagged with the release, so installed clients can compare versions and fetch
// the runtime files from an immutable tag URL without touching the GitHub API.
//
// Run with --check in CI to fail when the committed manifest is stale.
//
// Every manifest is pinned to the tag of the version it describes, so a tag must
// never be moved once published: jsDelivr caches by URL, and a moved tag leaves
// clients reading a manifest that describes files the same URL no longer serves.
// Bump the version and cut a new tag instead.
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
    // The pin has to name this version: pointing at an older tag is how a
    // manifest ends up describing files that URL never served.
    if (manifest.base !== `https://raw.githubusercontent.com/wssz527/kimi-cot-translate/v${pkg.version}`) {
      console.error(`${out} is pinned to ${manifest.base}, not v${pkg.version}`);
      process.exitCode = 1;
    }
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
