# kimi-cot-translate (kct)

[![Tests](https://github.com/wssz527/kimi-cot-translate/actions/workflows/tests.yml/badge.svg)](https://github.com/wssz527/kimi-cot-translate/actions/workflows/tests.yml)

**[中文](README.md)**

> **Unofficial community project.** Not affiliated with, endorsed by, or sponsored by Moonshot AI, Microsoft, or Google. "Kimi" and "Kimi Code" are trademarks of their respective owners; they are used here only to describe interoperability targets.

Display-layer translation for the visible thinking (reasoning) content of Kimi Code: embedded in the desktop app, plus an ACP translation terminal, a browser extension, and a VS Code copy-and-preview pane. On desktop, you pick a target language on first expand; afterwards thinking is translated automatically and you can toggle original / translated in place. Session files and the model context always keep the original text.

This is an unofficial, experimental runtime extension. It does not modify or re-sign the official app, and it does not take over the official updater. This repository contains no Kimi Code binaries, no session data, no keys, and no translation caches.

| Platform | Status | Currently verified against |
| --- | --- | --- |
| Desktop macOS Apple Silicon | Real translation, launch recovery and page-reload recovery verified | Kimi Code 1.1.2 / 1.1.1 / Electron 43.1.1 |
| Desktop Windows x64 | Preview; attachment and safe disable verified on CI runner | same as above |
| CLI / browser extension / VS Code | Preview (per-entry verification below) | CLI 2.1.1 / Chromium MV3 |

**Provided as-is, without any warranty; it may stop working after a host update.** See [Disclaimer](#disclaimer) and [Known limitations](#known-limitations).

## Contents

- [Demo](#demo)
- [Download and install](#download-and-install)
  - [Desktop macOS](#macos)
  - [Desktop Windows (preview)](#windows-preview)
  - [Other entries (CLI / browser / VS Code)](#other-entries-preview)
- [Usage and privacy (desktop)](#usage-and-privacy-desktop)
- [What leaves your machine](#what-leaves-your-machine)
- [Check, disable and uninstall](#check-disable-and-uninstall)
- [After Kimi updates](#after-kimi-updates)
- [Known limitations](#known-limitations)
- [Disclaimer](#disclaimer)
- [Local checks](#local-checks)

## Demo

On first expand you pick a target language and confirm with "开始使用" (Get started). Simplified Chinese, English, Japanese, Korean, Spanish, French, German and Russian are supported; change it later in Settings.

![Choosing the target language on first use](docs/screenshots/language-choice.png)

Mixed-language thinking is translated only where needed; Chinese text, code blocks and paragraph spacing are preserved. Click "原文" (Original) anytime to see the source.

![Embedded translation with original toggle](docs/screenshots/embedded-translation.png)

The screenshots above show a synthetic demo page (`docs/demo.html`, SYNTHETIC DEMO) running the real extension script with mocked translation responses. They are not screenshots of the official app and contain no real user sessions.

## Download and install

Download `kimi-cot-translate-v*.zip` from [GitHub Releases](https://github.com/wssz527/kimi-cot-translate/releases), then verify before unpacking:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

You can also `git clone` this repository; the browser extension and VS Code artifacts then need `npm ci && npm run build:browser && npm run build:vscode` (the Release attachments already contain prebuilt artifacts).

Installation only sets up the extension's background loader. It does not force-quit or restart Kimi, and it does not modify the official installation package. The first install loads the translation layer into any already-running process that passes verification. When the extension is updated, pages that already loaded an older script pick up the new one on their next normal refresh or reopen; the installer never refreshes pages on its own.

Node.js 24 for your architecture is required. Before running the installer, consider reading the verification flow in `runtime.mjs` (signature → kernel hash → inspector fuse → renderer structure).

### macOS

In a system terminal, enter this directory, confirm `node --version` prints `v24.x`, then run:

```sh
node runtime.mjs --install
```

The installer verifies the official app and copies four runtime files into the current user's persistent directory:

```text
~/Library/Application Support/kimi-cot-translate/
```

The background task lives at:

```text
~/Library/LaunchAgents/com.user.kimi-cot-translate.runtime.plist
```

It checks for existing processes at login and every 10 seconds. After opening Kimi Code normally, attachment usually completes within a dozen seconds. When Kimi is not running it simply waits; the loader never starts or quits Kimi, and never creates a second Kimi instance.

The installed copy is independent of this directory — moving the source afterwards does not affect it. The background task uses the absolute path of the Node that installed it; if you remove or move that Node, run the install command again.

### Windows (preview)

In PowerShell, enter this repository directory and run:

```powershell
node runtime-windows.mjs --install
```

See [Windows adaptation notes](docs/windows.md) for static evidence, dynamic tests and runtime constraints. The background login scheduled task observes existing instances and never starts Kimi itself; disabling waits for the current attachment to finish without terminating Kimi. Reinstalling keeps only the current and previous complete copies of the extension.

The test environment is a GitHub Windows runner; it cannot replace acceptance on real Windows 10/11 desktops, administrator-rights combinations, or official upgrades.

## Other entries (preview)

| Entry | What it provides | Verification scope |
| --- | --- | --- |
| Kimi Code CLI | Standalone translation terminal on top of the official `kimi acp`; interactive or one-shot | macOS CLI 2.1.1, real model and Bing translation; confirmed translations never enter official sessions; clean exit and cancellation |
| Kimi Code Web | Browser extension shows translations after expanded thinking bodies | Official 2.1.1 real sessions, Chromium MV3, real model and Bing Chinese/Japanese translation, session navigation |
| kimi.com chat page | Browser extension with that product's own thinking selectors | Public front-end structure and synthetic pages only; **not yet verified in a logged-in session** |
| VS Code | After the user copies thinking text, a separate preview pane offers language choice, translation and original toggle | Shared engine, Chromium messaging and CSP tests, VSIX packaging; not yet verified inside a real extension host |

CLI:

```sh
node cli.mjs --target zh
# one-shot:
node cli.mjs --target zh --prompt "Explain the current project; do not modify files yet."
```

The CLI terminal does not modify the native full-screen TUI; tool approvals are shown and wait for your choice, and non-interactive runs never auto-approve. See [CLI runtime and data notes](docs/cli.md).

Browser (the Release attachment `kct-browser-v*.zip` is prebuilt, so you can skip the build):

```sh
npm run build:browser
```

In your Chromium browser's extension page, enable developer mode, choose "Load unpacked" and point to `browser/dist/`. Expand a thinking section, choose and confirm a target language, then click translate. Kimi Code Web (the local `kimi web` UI) and kimi.com (the general chat page) are two different products with separate structural adaptations; text is not sent automatically by default. See [browser install and verification notes](docs/browser.md).

VS Code (the Release attachment `kct-copied-thinking-*.vsix` can be installed directly):

```sh
npm run build:vscode
code --extensionDevelopmentPath="$PWD/vscode"
```

Copy the thinking you want translated, open the command palette and run `KCT: Preview and Translate Copied Thinking`, review in the preview, then confirm and translate. The official Kimi extension exposes no public thinking-panel hook, so this entry does not follow the official panel automatically. This extension is not published to the VS Code Marketplace; it is distributed only as a VSIX via Releases. See [VS Code install, packaging and interface notes](docs/vscode.md).

All preview entries share the same translation engine and support eight target languages. The CLI offers Bing or Google; the browser and VS Code previews currently use Bing. Each entry's settings and storage boundaries are documented separately.

## Usage and privacy (desktop)

- On first expand of a thinking block you choose and confirm a target language; no translation request is sent before confirmation. Older "follow the Kimi UI" settings also prompt once; users who already chose a language keep their setting.
- Click "原文 / 译文" to toggle; click "设置" (Settings) for target language, service and auto-translate.
- Collapsed blocks are never translated; on failure the original stays and you can click "重试" (Retry).
- Streaming content is translated incrementally by completed paragraphs; sentences and paragraphs locally recognised as already being in the target language are skipped. Code blocks, inline code and URLs are kept as-is and never sent.
- When nothing needs translation, the original display node is kept — the original is not hidden or duplicated. The same applies when the service returns the text unchanged, so text never jumps.

Language detection runs locally and downloads no models. Chinese, Japanese and Korean use character features; English, Spanish, French, German and Russian also compare common words. Short or mixed-language text that cannot be classified confidently is still sent to the chosen service, to avoid wrongly skipping foreign-language content. This is not a full language-identification model and cannot guarantee that every same-language short sentence avoids a request.

The default service is Bing. Both Bing and Google are online services — translation does not run locally: thinking text to be translated is sent to the corresponding third-party endpoint. Bing uses batched requests, at most 3 concurrent requests and a 15-second timeout. Google's public endpoint may be limited by browser CORS rules and is not the default service.

**Sharing this extension never shares the author's account or permissions.** Bing and Google require no author account or API key; requests explicitly set `credentials: 'omit'` and carry no browser cookies or login credentials. Other users install it on their own machines, use their own networks, and keep their own settings and caches. Public endpoints may still be rate-limited, and current availability does not imply a stable official extension interface.

Settings and translation caches are stored in Kimi's localStorage. A custom OpenAI-compatible service requires you to enter the endpoint and API key yourself; the key is sent only to that endpoint and is stored unencrypted in local localStorage. Share this repository or a clean source archive — never share your whole Kimi user-data directory or these stored data.

**Before you enable it**: thinking chains often contain code, paths, internal identifiers and even credentials. Do not enable auto-translate in sessions containing secrets, customer data or confidential content; confirm yourself that the content may leave your machine.

### Will the cache grow forever?

The translation cache is bounded by all of the following — whichever is hit first triggers cleanup:

- At most 500 entries; least-recently-used entries are evicted beyond that.
- Serialized JSON at most 2 MiB, counted in UTF-16 bytes including keys and timestamps.
- Entries expire after 7 days unused; a single expiry timer cleans up while the page runs, and reads/writes also check.

The cache is keyed by text hash and is not bound to a session. Leaving a session does not immediately delete its translated entries, but idle entries expire and both count and size stay bounded. Legacy timestamp-less entries start their 7-day window at first migration; corrupted or over-budget legacy caches are cleared.

When you leave a session, collapse a block, or the thinking content is replaced, stale queued jobs are cancelled. Requests already sent may run to completion or the 15-second timeout, but stale results are never written back. After "清空缓存" (Clear cache) in Settings, requests sent before the clear will not repopulate the cache.

Only translation-layer text and temporary tasks are touched — Kimi's chat history, originals and settings are never deleted. The limits above are the translation cache budget, not a memory cap for the whole Kimi process.

## What leaves your machine

| Content | Sent to | When | How to turn off |
| --- | --- | --- | --- |
| Thinking text to be translated (excluding code blocks/URLs) | The translation endpoint you chose (default `edge.microsoft.com`) | After language confirmation, when expanding thinking or clicking translate | Disable auto-translate / don't click translate / `--disable` |
| Custom-service API key | Only the endpoint you entered (`Authorization: Bearer`) | Only when translating via a custom service | Clear the key in Settings |
| Settings and translation cache | Nowhere (localStorage) | — | "Clear cache" in Settings |

Diagnostic records (`runtime-state.json`, `runtime.log`) contain no session text or service keys. The browser extension never stores `#token=` and never reads any session API.

## Check, disable and uninstall

macOS:

```sh
node "$HOME/Library/Application Support/kimi-cot-translate/runtime.mjs" --check
```

Windows, in this repository directory:

```powershell
node runtime-windows.mjs --check
```

The status is the record of the most recent background check:

- `active`, `loaded: 1`, `inspectorClosed: true`: the recorded PID finished attachment and the debugging interface is closed.
- `waiting`: waiting for a normal instance to start, or for conditions such as multiple instances or a busy port to clear.
- `error`: verification or attachment failed — read `detail`. Transient failures retry automatically with backoff; permanent incompatibility (unknown hash / signature mismatch) is never retried.
- `blocked-inspector`: the debugging interface could not be confirmed closed — quit Kimi normally and check the log.

Status is stored in `runtime-state.json` under the per-user data directory (macOS also has `runtime.log`). The Windows data directory is `%LOCALAPPDATA%\kimi-cot-translate\windows`. These diagnostic records contain no session text or service keys.

To stop future auto-loading (the runtime part of uninstalling):

```sh
# macOS
node "$HOME/Library/Application Support/kimi-cot-translate/runtime.mjs" --disable
```

```powershell
# Windows, in this repository directory
node runtime-windows.mjs --disable
```

The already-loaded translation layer disappears the next time Kimi quits normally. Disabling never force-ends a session; run the install command again to re-enable. Full uninstall: after `--disable`, delete the persistent directory and the LaunchAgent / scheduled task above. The official app is never modified, so no reinstall is needed.

## After Kimi updates

The extension files live outside the official app, so a normal app update never overwrites them. After a new process starts, the background task re-checks the signature, the actually running files, the verified Electron kernel hashes, the inspector fuse and the thinking-block structure before attaching again.

Compatible updates need no manual reinstall. If an official update changes the Electron kernel, disables the relevant debugging capability, or changes the thinking-block structure, translation stops and waits for the extension to catch up. **Never bypass verification by hand-adding unknown hashes** — file a "compatibility report" issue on GitHub (with old and new version numbers); adaptations ship as verified commits in this repository.

Symptom cheat sheet:

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Translation gone after update; `--check` shows `error` with `New Electron runtime` in detail | New kernel not yet verified | File a compatibility report and wait for an adaptation release |
| detail mentions signature or structure verification failure | Official package structure changed | Same as above; never bypass manually |
| `blocked-inspector` | Debugging interface not confirmed closed | Quit Kimi normally, then read the log |

This is not an officially supported stable extension API, and compatibility with future versions cannot be guaranteed. Only normal-restart recovery and page-refresh recovery have been verified so far; real cross-version upgrade acceptance has not been done. Static structure checks cannot prove that every interaction of a new version stays compatible.

During attachment, a localhost-only Node inspector is opened briefly (about 12 seconds at most, and the port is confirmed closed afterwards); after verifying the owning PID, an in-memory hook is installed. Unknown kernels never receive the signal that opens the inspector.

## Known limitations

- Kimi Code 1.1.1 and 1.1.2 / Electron 43.1.1 are verified; cross-version upgrades, sleep/wake and long-running sessions are not yet accepted.
- The Kimi desktop app (Kimi.app, com.moonshot.kimichat) is not supported: the official Electron binary ships with the Node inspector fuse disabled, so this project's runtime injection mechanism cannot attach, and this project will not patch official binaries to work around it. Kimi web (kimi.com) users should use the browser extension entry instead.
- The kimi.com general chat page has not been verified in a logged-in session; the VS Code entry has not been verified inside a real extension host.
- Translation uses public unauthenticated endpoints (Bing / Google) with no SLA; they may be rate-limited, change, or be governed by the providers' terms. For heavy or long-term use, prefer a custom service with your own credentials.
- Custom-service API keys are stored unencrypted in local localStorage.
- Windows adaptation has only been verified on a GitHub runner, not across real Windows 10/11 desktop environments.

## Disclaimer

This extension is provided "as is", without warranty of any kind, express or implied (the MIT License contains the full legal text — see `LICENSE`). Installing and using it means you accept the risk yourself; the authors are not liable for breakage, data, sessions or account issues caused by host updates. This project is not affiliated with, endorsed by, or sponsored by Kimi Code, Moonshot AI, Microsoft, or Google; Kimi, Kimi Code and other names are trademarks of their respective owners. See `NOTICE.md` for third-party attribution and sources.

## Local checks

Development tests use a locked Playwright version; installing and running the extension itself does not need these dependencies:

```sh
npm ci
npx playwright install chromium
npm test
npm run test:browser
npm run test:vscode
npm run test:windows
# additionally on macOS:
npm run test:macos
```

Regenerate the demo screenshots above (synthetic content and mocked responses only; no real translation service is called):

```sh
node docs/create-screenshots.mjs
```

GitHub Actions runs the shared UI, hook, ACP protocol, browser, VS Code preview and Windows loader simulated regressions; macOS additionally runs the system loader unit tests. The test environments versus each entry's real install support are listed in the tables above.

The manually triggered [Windows official-app smoke](https://github.com/wssz527/kimi-cot-translate/actions/workflows/windows-live.yml) covers real signature verification, debug triggering, two cold-started processes, attachment, interface closure, scheduled-task install without restart, and safe disable. By design this workflow fails once the official installer changes (a hash circuit-breaker); the hash is updated only after a manual offline compatibility review — **a failure there does not mean this repository's code is broken**. It uses a fresh, logged-out environment and does not verify Bing translation in real user sessions or official upgrades. CI success cannot replace those missing acceptance steps.

The 2026-10-21 macOS deployment acceptance covered real Bing translation, original-toggle, auto-loading after normal launch, page-refresh recovery, and unchanged official signature and resource hashes. Real upgrades, sleep/wake and long-running sessions remain unverified.

## License and contributing

MIT License (see `LICENSE`). Read `CONTRIBUTING.md` before contributing; for security issues see `SECURITY.md`. This project is not distributed via npm — the `private: true` in `package.json` is intentional.
