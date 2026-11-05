// Self-update for the runtime bundle: check the published release manifest,
// fetch only the runtime core files, verify their hashes, then hand them to the
// existing atomic deploy path. Nothing is fetched or written unless the remote
// version is newer than the local one.
import { createHash } from 'node:crypto';

export const RUNTIME_FILES = ['runtime.mjs', 'runtime-hook.mjs', 'runtime-update.mjs', 'supported-runtimes.json', 'kct.js'];
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
// jsDelivr serves the same tagged files and does resolve, so the updater tries
// the canonical host first and falls back to the CDN rather than leaving those
// users stranded on whatever version they installed.
export const MANIFEST_MIRRORS = {
  'https://raw.githubusercontent.com/wssz527/kimi-cot-translate/main/runtime-manifest.json':
    ['https://cdn.jsdelivr.net/gh/wssz527/kimi-cot-translate@main/runtime-manifest.json'],
  'https://raw.githubusercontent.com/wssz527/kimi-cot-translate/main/runtime-manifest-windows.json':
    ['https://cdn.jsdelivr.net/gh/wssz527/kimi-cot-translate@main/runtime-manifest-windows.json'],
};
const RAW_PREFIX = 'https://raw.githubusercontent.com/wssz527/kimi-cot-translate/';
const CDN_PREFIX = 'https://cdn.jsdelivr.net/gh/wssz527/kimi-cot-translate@';

// Rewrites a raw.githubusercontent.com URL onto the CDN, keeping the ref and the
// path, so a downloaded bundle can come from whichever host answers.
export function mirrorUrl(url) {
  if (!url.startsWith(RAW_PREFIX)) return null;
  return CDN_PREFIX + url.slice(RAW_PREFIX.length);
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
  { fetchImpl = fetch, timeoutMs = 10000, files = RUNTIME_FILES, mirrors } = {}) {
  const response = await fetchWithMirrors(url, {
    fetchImpl, timeoutMs, mirrors: mirrors ?? MANIFEST_MIRRORS[url] ?? [],
  });
  return validateManifest(await response.json(), files);
}

export async function downloadBundle(manifest,
  { fetchImpl = fetch, timeoutMs = 30000, required = RUNTIME_FILES } = {}) {
  const files = new Map();
  for (const name of required) {
    const url = `${manifest.base.replace(/\/$/, '')}/${name}`;
    const response = await fetchWithMirrors(url, { fetchImpl, timeoutMs });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hashBytes(bytes) !== manifest.files[name]) {
      throw new Error(`Update download hash mismatch for ${name}; the release is left untouched`);
    }
    files.set(name, bytes);
  }
  return files;
}

// The deployed bundle has no package.json, so the version travels inside this
// file. scripts/version-sync.mjs keeps it aligned with the root manifest, and a
// self-update replaces this file wholesale, carrying the new version with it.
export const RUNTIME_VERSION = '0.2.8';

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
  const manifest = await fetchManifest(manifestUrl, { fetchImpl, files });
  if (!isNewer(manifest.version, from)) return { available: false, current: from, remote: manifest.version };
  return { available: true, current: from, remote: manifest.version, manifest };
}
