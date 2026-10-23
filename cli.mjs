#!/usr/bin/env node
// A terminal ACP client; the official CLI and its saved messages stay unchanged.
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stripVTControlCharacters } from 'node:util';
import { pathToFileURL } from 'node:url';
import { AcpClient } from './cli-acp.mjs';

const { state, translateText, TARGET_LANGUAGES, prunePending } = createRequire(import.meta.url)('./kct.js');
const BUFFER_LIMIT = 128 * 1024;
const LANGUAGES = ['简体中文', 'English', '日本語', '한국어', 'Español', 'Français', 'Deutsch', 'Русский'];
const safe = (text) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');

export function parseArgs(args) {
  const options = { provider: undefined, target: undefined, prompt: undefined, command: 'kimi', original: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--original') options.original = true;
    else if (['--target', '--provider', '--prompt', '-p', '--kimi'].includes(arg)) {
      if (i + 1 >= args.length) throw new Error(`Missing value: ${arg}`);
      const value = args[++i];
      options[({ '--target': 'target', '--provider': 'provider', '--prompt': 'prompt', '-p': 'prompt', '--kimi': 'command' })[arg]] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.target && !TARGET_LANGUAGES.includes(options.target)) throw new Error('Unsupported target language');
  if (options.provider && !['bing', 'google'].includes(options.provider)) throw new Error('Use bing or google');
  if (options.prompt !== undefined && !options.prompt.trim()) throw new Error('Empty prompt');
  if (!options.command.trim()) throw new Error('Empty Kimi executable path');
  return options;
}

export function settingsPath(env = process.env, platform = process.platform, home = homedir()) {
  const root = platform === 'win32'
    ? env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    : env.XDG_CONFIG_HOME || join(home, '.config');
  return join(root, 'kimi-cot-translate', 'cli.json');
}

export class TerminalRenderer {
  constructor({ target, provider = 'bing', original = false, write = (text) => process.stdout.write(text),
    warn = (text) => process.stderr.write(text), translate = translateText } = {}) {
    Object.assign(this, { target, provider, original, write, warn, translate });
    this.buffer = '';
    this.pending = 0;
    this.tail = Promise.resolve();
    this.live = true;
    this.kind = '';
    this.jobs = 0;
    this.lastJob = null;
  }

  push(update) {
    const kind = update?.sessionUpdate;
    const content = update?.content;
    if (kind === 'agent_thought_chunk' && content?.type === 'text' && typeof content.text === 'string') {
      if (this.buffer.length + this.pending + content.text.length > BUFFER_LIMIT) {
        throw new Error('Terminal display exceeds 128 Ki characters; cancel this turn and use the saved Kimi session.');
      }
      this.buffer += content.text;
      while (this.buffer.length) {
        const boundary = this.buffer.indexOf('\n\n');
        let end = boundary >= 0 && boundary < 1500 ? boundary + 2 : this.buffer.length >= 1500 ? 1500 : 0;
        if (!end) break;
        if (/[\uD800-\uDBFF]/.test(this.buffer[end - 1])) end--;
        this.enqueue('thought', this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end);
      }
    } else if (kind === 'agent_message_chunk' && content?.type === 'text' && typeof content.text === 'string') {
      this.flush();
      this.enqueue('answer', content.text);
    } else if (kind === 'tool_call') {
      this.flush();
      this.enqueue('tool', `\n[工具] ${String(update.title || update.toolCallId || '')}\n`);
    }
  }

  flush() {
    if (!this.buffer) return;
    this.enqueue('thought', this.buffer);
    this.buffer = '';
  }

  enqueue(kind, text) {
    if (this.pending + text.length > BUFFER_LIMIT) throw new Error('Terminal output queue exceeds 128 Ki characters');
    const previous = this.lastJob;
    if (previous?.kind === kind && !previous.started) {
      previous.text += text;
      this.pending += text.length;
      return;
    }
    if (this.jobs >= 256) throw new Error('Terminal output queue exceeds 256 groups');
    const job = { kind, text, started: false };
    this.lastJob = job;
    this.jobs++;
    this.pending += text.length;
    this.tail = this.tail.then(async () => {
      job.started = true;
      const text = job.text;
      if (!this.live) return;
      let output = text;
      if (kind === 'thought') {
        try {
          output = await this.translate(text, this.target, () => {}, { ...state.settings, provider: this.provider },
            () => this.live);
        } catch {
          if (!this.live) return;
          this.warn('[kct] 翻译失败，保留原文。\n');
        }
        if (!this.live) return;
        if (this.original && output !== text) this.write(`\n[思考原文]\n${safe(text)}\n[译文]\n`);
        else if (this.kind !== 'thought') this.write(`\n[思考 · ${this.target}]\n`);
      } else if (kind === 'answer' && this.kind !== 'answer') this.write('\n[回答]\n');
      if (!this.live) return;
      this.write(safe(output));
      this.kind = kind;
    }).finally(() => {
      this.pending -= job.text.length;
      this.jobs--;
      if (this.lastJob === job) this.lastJob = null;
    });
    // Observe the rejection immediately while finish() still reports it.
    this.tail.catch(() => {});
  }

  async finish() {
    this.flush();
    await this.tail;
  }

  cancel() {
    this.live = false;
    this.buffer = '';
    prunePending();
  }
}

export async function permissionResponse(params, question) {
  const options = Array.isArray(params?.options) ? params.options : [];
  if (!question || !options.length) return { outcome: { outcome: 'cancelled' } };
  const title = safe(String(params.toolCall?.title || '工具操作'));
  const input = params.toolCall?.rawInput;
  const detail = input === undefined ? '' : `\n${safe(JSON.stringify(input)).slice(0, 8000)}\n`;
  const list = options.map((option, i) => `${i + 1}. ${safe(String(option.name))}`).join('\n');
  let answer;
  try { answer = await question(`\n需要授权：${title}${detail}\n${list}\n选择编号（直接回车拒绝）：`); }
  catch { return { outcome: { outcome: 'cancelled' } }; }
  const index = Number(answer.trim()) - 1;
  const selected = Number.isInteger(index) && options[index];
  return selected
    ? { outcome: { outcome: 'selected', optionId: selected.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

async function chooseSettings(options, question, file) {
  let stored = {};
  try { stored = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read CLI translation settings; inspect cli.json'); }
  let target = options.target || stored?.targetLanguage;
  const provider = options.provider || stored?.provider || 'bing';
  if (!['bing', 'google'].includes(provider)) throw new Error('Invalid stored translation provider');
  if (!TARGET_LANGUAGES.includes(target)) {
    if (!question) throw new Error('First use requires --target zh (or en/ja/ko/es/fr/de/ru). No translation was sent.');
    const list = TARGET_LANGUAGES.map((code, i) => `${i + 1}. ${LANGUAGES[i]} (${code})`).join('\n');
    const answer = (await question(`选择思考翻译语言：\n${list}\n语言代码或编号：`)).trim();
    target = TARGET_LANGUAGES.includes(answer) ? answer : TARGET_LANGUAGES[Number(answer) - 1];
    if (!target) throw new Error('No valid target language selected; no translation was sent');
  }
  if (target !== stored?.targetLanguage || provider !== stored?.provider) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const next = `${file}.${process.pid}.next`;
    await writeFile(next, JSON.stringify({ targetLanguage: target, provider }) + '\n', { mode: 0o600 });
    await rename(next, file);
  }
  return { target, provider };
}

export async function run(options, { input = process.stdin, output = process.stdout, error = process.stderr,
  env = process.env, cwd = process.cwd(), Client = AcpClient, configFile = settingsPath(env) } = {}) {
  const interactive = !!input.isTTY && !!output.isTTY;
  if (!interactive && options.prompt === undefined) throw new Error('Use --prompt in a non-interactive terminal');
  const readline = interactive ? createInterface({ input, output }) : null;
  const questionAbort = new AbortController();
  let questionTail = Promise.resolve();
  const question = readline ? (text) => {
    const answer = questionTail.then(() => {
      if (questionAbort.signal.aborted) throw questionAbort.signal.reason;
      return readline.question(text, { signal: questionAbort.signal });
    });
    questionTail = answer.catch(() => {});
    return answer;
  } : undefined;
  let client;
  let renderer;
  let sessionId;
  let stopped = false;
  let fatal;
  let closing = false;
  let cancelTimer;
  const cancel = () => {
    stopped = true;
    renderer?.cancel();
    if (sessionId) {
      try { client?.notify('session/cancel', { sessionId }); } catch { /* already closed */ }
    }
    if (client && !cancelTimer) cancelTimer = setTimeout(() => { void client.close().catch(() => {}); }, 2000);
    questionAbort.abort();
    readline?.close();
  };
  readline?.on('SIGINT', cancel);
  readline?.once('close', () => { if (!closing && !stopped) cancel(); });
  try {
    const settings = await chooseSettings(options, question, configFile);
    error.write(`[kct] ACP 翻译终端，目标 ${settings.target}；待译思考会发送到 ${settings.provider}。\n`);
    client = new Client({
      command: options.command, args: ['acp'], cwd, env, stderr: error,
      onUpdate: (params) => {
        if (params.sessionId !== sessionId || !renderer || fatal) return;
        try { renderer.push(params.update); }
        catch (cause) { fatal = cause; cancel(); }
      },
      onPermission: (params) => permissionResponse(params, question),
    });
    await client.start();
    void client.closed?.then(({ code, signal }) => {
      if (!closing && !stopped) {
        fatal = new Error(`Kimi ACP exited (code ${code}, signal ${signal})`);
        cancel();
      }
    }, (cause) => {
      if (!closing && !stopped) { fatal = cause; cancel(); }
    });
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    const initialized = await client.request('initialize', {
      protocolVersion: 1, clientInfo: { name: 'kimi-cot-translate', version: '0.2.2' },
      clientCapabilities: {},
    });
    if (initialized?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
    const session = await client.request('session/new', { cwd: resolve(cwd), mcpServers: [] });
    if (typeof session?.sessionId !== 'string') throw new Error('Kimi did not return an ACP session');
    sessionId = session.sessionId;
    error.write(`[kct] 会话 ${safe(sessionId)}；命令 /exit 退出。\n`);
    let prompt = options.prompt;
    while (!stopped) {
      if (prompt === undefined) prompt = await question('你：');
      if (prompt.trim() === '/exit') break;
      if (!prompt.trim()) { prompt = undefined; continue; }
      renderer = new TerminalRenderer({
        ...settings, original: options.original,
        write: (text) => output.write(text), warn: (text) => error.write(text),
      });
      const result = await client.request('session/prompt', {
        sessionId, prompt: [{ type: 'text', text: prompt }],
      }, { timeoutMs: 0 });
      await renderer.finish();
      if (fatal) throw fatal;
      output.write('\n');
      if (result?.stopReason && result.stopReason !== 'end_turn') error.write(`[kct] ${safe(result.stopReason)}\n`);
      if (options.prompt !== undefined) break;
      prompt = undefined;
    }
    if (fatal) throw fatal;
    return stopped ? 130 : 0;
  } catch (cause) {
    if (fatal) throw fatal;
    if (stopped) return 130;
    throw cause;
  } finally {
    closing = true;
    clearTimeout(cancelTimer);
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    questionAbort.abort();
    readline?.close();
    renderer?.cancel();
    await client?.close().catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Kimi Code ACP 翻译终端（需要 Node 24 和 kimi acp）\n' +
      'node cli.mjs [--target zh|en|ja|ko|es|fr|de|ru] [--provider bing|google]\n' +
      '             [--prompt "问题"] [--original] [--kimi /path/to/kimi]\n' +
      '不加 --prompt 时交互输入；非交互运行时，工具授权请求会拒绝。\n' +
      '这是独立 ACP 客户端，不会修改原生 kimi TUI 或安装包。');
    return;
  }
  if (!/^24\./.test(process.versions.node)) throw new Error('Use Node.js 24');
  process.exitCode = await run(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[kct] ${safe(error.message || String(error))}`);
    process.exitCode = 1;
  });
}
