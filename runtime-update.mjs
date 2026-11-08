// Self-update for the runtime bundle: check the published release manifest,
// fetch only the runtime core files, verify their hashes, then hand them to the
// existing atomic deploy path. Nothing is fetched or written unless the remote
// version is newer than the local one.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const RUNTIME_FILES = ['runtime.mjs', 'runtime-hook.mjs', 'runtime-update.mjs', 'runtime-launcher.mjs',
  'supported-runtimes.json', 'kct.js'];
// The Windows loader ships its own files, so it needs its own manifest: the
// macOS one deliberately carries only the five files that entry deploys, and a
// Windows install that downloaded those would replace the macOS loader without
// touching the one it actually runs.
export const WINDOWS_RUNTIME_FILES = ['runtime-windows.mjs', 'runtime.mjs', 'runtime-hook.mjs',
  'runtime-update.mjs', 'windows-bridge.ps1', 'supported-windows-runtimes.json',
  'supported-runtimes.json', 'kct.js'];
export const DEFAULT_MANIFEST = 'https://raw.githubusercontent.com/wssz527/kimi-cot-translate/main/runtime-manifest.json';
export const DEFAULT_WINDOWS_MANIFEST = 'https://raw.githubusercontent.com/wssz527/kimi-cot-translate/main/runtime-manifest-windows.json';
// raw.githubusercontent.com is unreachable from a plain China Telecom /
// Unicom / Mobile connection: TCP 443 connects but the TLS request times out.
//
// The fallbacks deliberately avoid jsDelivr. It caches by URL, including the
// branch ref, so `@main/runtime-manifest.json` keeps answering with an old
// manifest long after the branch moved — and a stale manifest is worse than no
// manifest, because the hashes it lists no longer match the files. These two
// proxies pass the current content through instead.
const MAIN_PREFIX = 'https://raw.githubusercontent.com/wssz527/kimi-cot-translate/main/';
export const MANIFEST_MIRRORS = {
  [`${MAIN_PREFIX}runtime-manifest.json`]: [
    'https://cdn.statically.io/gh/wssz527/kimi-cot-translate/main/runtime-manifest.json',
    'https://ghproxy.net/https://raw.githubusercontent.com/wssz527/kimi-cot-translate/main/runtime-manifest.json',
  ],
  [`${MAIN_PREFIX}runtime-manifest-windows.json`]: [
    'https://cdn.statically.io/gh/wssz527/kimi-cot-translate/main/runtime-manifest-windows.json',
    'https://ghproxy.net/https://raw.githubusercontent.com/wssz527/kimi-cot-translate/main/runtime-manifest-windows.json',
  ],
};
const RAW_PREFIX = 'https://raw.githubusercontent.com/wssz527/kimi-cot-translate/';

export function versionedManifestUrl(version) {
  return `${RAW_PREFIX}v${version}/runtime-manifest.json`;
}

// Rewrites a raw.githubusercontent.com URL onto a passthrough proxy, keeping the
// ref and the path, so a downloaded bundle can come from whichever host answers.
// Tag refs are immutable, so any of these serve the same bytes.
export function mirrorUrl(url) {
  if (!url.startsWith(RAW_PREFIX)) return null;
  return 'https://cdn.statically.io/gh/wssz527/kimi-cot-translate/' + url.slice(RAW_PREFIX.length);
}
const HASH_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function parseVersion(text) {
  if (!VERSION_RE.test(text ?? '')) return null;
  return text.split('.').map(Number);
}

export function isNewer(remote, local) {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function validateManifest(manifest, required = RUNTIME_FILES) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Update manifest is not an object');
  if (!parseVersion(manifest.version)) throw new Error('Update manifest has no valid version');
  if (!manifest.files || typeof manifest.files !== 'object') {
    throw new Error('Update manifest has no file list');
  }
  for (const name of required) {
    const digest = manifest.files[name];
    if (!HASH_RE.test(digest ?? '')) throw new Error(`Update manifest lacks a valid hash for ${name}`);
  }
  if (typeof manifest.base !== 'string' || !/^https:\/\//.test(manifest.base)) {
    throw new Error('Update manifest has no https base URL');
  }
  return manifest;
}

async function fetchWithMirrors(url, { fetchImpl, timeoutMs, mirrors = [] }) {
  const attempts = [url, ...(mirrors.length ? mirrors : [mirrorUrl(url)]).filter(Boolean)];
  let last;
  for (const target of attempts) {
    try {
      const response = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      if (!response.ok) throw new Error(`request failed with ${response.status}`);
      return response;
    } catch (error) { last = error; }
  }
  throw last;
}

export async function fetchManifest(url = DEFAULT_MANIFEST,
  { fetchImpl = fetch, timeoutMs = 10000, files = RUNTIME_FILES, mirrors, validate = true } = {}) {
  const response = await fetchWithMirrors(url, {
    fetchImpl, timeoutMs, mirrors: mirrors ?? MANIFEST_MIRRORS[url] ?? [],
  });
  const manifest = await response.json();
  return validate ? validateManifest(manifest, files) : manifest;
}

export async function downloadBundle(manifest,
  { fetchImpl = fetch, timeoutMs = 30000, required = RUNTIME_FILES, cacheDir } = {}) {
  validateManifest(manifest, required);
  const files = new Map();
  if (cacheDir) {
    const key = hashBytes(JSON.stringify({ version: manifest.version, files: manifest.files }));
    const previous = await readFile(join(cacheDir, '.manifest'), 'utf8').catch(() => '');
    if (previous !== key) {
      await rm(cacheDir, { recursive: true, force: true });
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      await writeFile(join(cacheDir, '.manifest'), key, { mode: 0o600 });
    }
  }
  for (const name of required) {
    const cached = cacheDir && await readFile(join(cacheDir, name)).catch(() => null);
    if (cached && hashBytes(cached) === manifest.files[name]) {
      files.set(name, cached);
      continue;
    }
    const url = `${manifest.base.replace(/\/$/, '')}/${name}`;
    const response = await fetchWithMirrors(url, { fetchImpl, timeoutMs });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hashBytes(bytes) !== manifest.files[name]) {
      throw new Error(`Update download hash mismatch for ${name}; the release is left untouched`);
    }
    if (cacheDir) {
      const temp = join(cacheDir, `.${name}.${randomUUID()}.next`);
      try {
        await writeFile(temp, bytes, { mode: 0o600 });
        await rename(temp, join(cacheDir, name));
      } finally { await rm(temp, { force: true }).catch(() => {}); }
    }
    files.set(name, bytes);
  }
  return files;
}

// The deployed bundle has no package.json, so the version travels inside this
// file. scripts/version-sync.mjs keeps it aligned with the root manifest, and a
// self-update replaces this file wholesale, carrying the new version with it.
export const RUNTIME_VERSION = '0.3.0';

export async function localVersion() {
  return RUNTIME_VERSION;
}

export async function resolveUpdate({
  current,
  manifestUrl = DEFAULT_MANIFEST,
  fetchImpl = fetch,
  files = RUNTIME_FILES,
} = {}) {
  const from = current ?? await localVersion();
  // Compare versions before requiring the full file list: an older published
  // manifest that predates a file must not make an already-current client fail
  // its update check. A genuinely newer manifest is still validated in full.
  const manifest = await fetchManifest(manifestUrl, { fetchImpl, files, validate: false });
  if (!isNewer(manifest.version, from)) return { available: false, current: from, remote: manifest.version };
  validateManifest(manifest, files);
  return { available: true, current: from, remote: manifest.version, manifest };
}
