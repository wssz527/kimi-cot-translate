// Self-update for the runtime bundle: check the published release manifest,
// fetch only the runtime core files, verify their hashes, then hand them to the
// existing atomic deploy path. Nothing is fetched or written unless the remote
// version is newer than the local one.
import { createHash } from 'node:crypto';

export const RUNTIME_FILES = ['runtime.mjs', 'runtime-hook.mjs', 'runtime-update.mjs', 'supported-runtimes.json', 'kct.js'];
export const DEFAULT_MANIFEST = 'https://raw.githubusercontent.com/wssz527/kimi-cot-translate/main/runtime-manifest.json';
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

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Update manifest is not an object');
  if (!parseVersion(manifest.version)) throw new Error('Update manifest has no valid version');
  if (!manifest.files || typeof manifest.files !== 'object') {
    throw new Error('Update manifest has no file list');
  }
  for (const name of RUNTIME_FILES) {
    const digest = manifest.files[name];
    if (!HASH_RE.test(digest ?? '')) throw new Error(`Update manifest lacks a valid hash for ${name}`);
  }
  if (typeof manifest.base !== 'string' || !/^https:\/\//.test(manifest.base)) {
    throw new Error('Update manifest has no https base URL');
  }
  return manifest;
}

export async function fetchManifest(url = DEFAULT_MANIFEST, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!response.ok) throw new Error(`Update manifest request failed with ${response.status}`);
  return validateManifest(await response.json());
}

export async function downloadBundle(manifest, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const files = new Map();
  for (const name of RUNTIME_FILES) {
    const url = `${manifest.base.replace(/\/$/, '')}/${name}`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!response.ok) throw new Error(`Update download failed for ${name}: ${response.status}`);
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
export const RUNTIME_VERSION = '0.2.1';

export async function localVersion() {
  return RUNTIME_VERSION;
}

export async function resolveUpdate({
  current,
  manifestUrl = DEFAULT_MANIFEST,
  fetchImpl = fetch,
} = {}) {
  const from = current ?? await localVersion();
  const manifest = await fetchManifest(manifestUrl, { fetchImpl });
  if (!isNewer(manifest.version, from)) return { available: false, current: from, remote: manifest.version };
  return { available: true, current: from, remote: manifest.version, manifest };
}
