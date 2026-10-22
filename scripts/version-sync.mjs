#!/usr/bin/env node
// Sync the version from the root package.json into every published manifest.
// Root package.json is the single source of truth (see CONTRIBUTING.md).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(await readFile(join(root, '..', 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Root version "${version}" must be plain semver (browser manifest requires 1-4 integer parts)`);
}

const targets = [
  join(root, '..', 'vscode', 'package.json'),
  join(root, '..', 'browser', 'manifest.json'),
];
for (const target of targets) {
  const json = JSON.parse(await readFile(target, 'utf8'));
  if (json.version === version) continue;
  json.version = version;
  await writeFile(target, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`synced ${target} -> ${version}`);
}

const cli = join(root, '..', 'cli.mjs');
const source = await readFile(cli, 'utf8');
const next = source.replace(/(clientInfo:\s*\{[^}]*?version:\s*')[^']+(')/s, `$1${version}$2`);
if (next !== source) {
  await writeFile(cli, next);
  console.log(`synced cli.mjs clientInfo -> ${version}`);
}
