import { spawn } from 'node:child_process';

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const has = (value, key) => Object.hasOwn(value, key);
const validId = (id) => id === null || typeof id === 'string' || (
  typeof id === 'number' && Number.isFinite(id)
);

export class AcpClient {
  #options;
  #child;
  #started = false;
  #closing = false;
  #finished = false;
  #failure;
  #nextId = 0;
  #pending = new Map();
  #parts = [];
  #bytes = 0;
  #killTimer;
  #closeTimer;
  #resolveClosed;
  #rejectClosed;

  constructor({
    command = 'kimi',
    args = ['acp'],
    cwd,
    env,
    onUpdate = () => {},
    onPermission = async () => ({ outcome: { outcome: 'cancelled' } }),
    stderr = process.stderr,
  } = {}) {
    this.#options = { command, args, cwd, env, onUpdate, onPermission, stderr };
    this.closed = new Promise((resolve, reject) => {
      this.#resolveClosed = resolve;
      this.#rejectClosed = reject;
    });
    // Consumers may attach their closed handler after an early spawn failure.
    this.closed.catch(() => {});
  }

  start() {
    if (this.#closing || this.#finished) throw new Error('ACP client closed');
    if (this.#started) return this;
    this.#started = true;
    const { command, args, cwd, env, stderr } = this.#options;
    try {
      const child = this.#child = spawn(command, args, {
        cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.once('close', (code, signal) => this.#finish(code, signal));
      child.on('error', (error) => this.#fail(error));
      child.stdin.on('error', (error) => this.#fail(error));
      child.stdout.on('error', (error) => this.#fail(error));
      child.stderr.on('error', (error) => this.#fail(error));
      child.stdout.on('data', (chunk) => this.#read(chunk));
      child.stdout.once('end', () => {
        if (!this.#closing && this.#bytes) this.#line();
      });
      if (stderr) child.stderr.pipe(stderr, { end: false });
      else child.stderr.resume();
    } catch (error) {
      this.#fail(error);
    }
    return this;
  }

  async request(method, params, { timeoutMs = 30000 } = {}) {
    this.#assertOpen();
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) {
      throw new TypeError('Invalid ACP request timeout');
    }
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === 0 ? undefined : setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('ACP request timed out'));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.#assertOpen();
    this.#send({ method, params });
  }

  close() {
    if (this.#closing || this.#finished) return this.closed;
    this.#closing = true;
    this.#rejectPending(this.#failure ?? new Error('ACP client closed'));
    this.#closeTimer = setTimeout(() => this.#finish(null, null), 2000);
    this.#closeTimer.unref();
    if (!this.#child) {
      this.#finish(null, null);
    } else {
      const child = this.#child;
      this.#killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, 1000);
      child.stdin.end();
    }
    return this.closed;
  }

  #assertOpen() {
    if (this.#closing || this.#finished) {
      throw this.#failure ?? new Error('ACP client closed');
    }
    if (!this.#started) throw new Error('ACP client not started');
  }

  #send(message) {
    this.#assertOpen();
    if (has(message, 'method') && typeof message.method !== 'string') {
      throw new TypeError('Invalid ACP method');
    }
    const line = JSON.stringify({ jsonrpc: '2.0', ...message });
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      throw new Error('ACP line exceeds 2 MiB');
    }
    this.#child.stdin.write(`${line}\n`, (error) => {
      if (error) this.#fail(error);
    });
  }

  #read(chunk) {
    if (this.#closing) return;
    let offset = 0;
    while (offset < chunk.length && !this.#closing) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      this.#bytes += end - offset;
      if (this.#bytes > MAX_LINE_BYTES) {
        this.#fail(new Error('ACP line exceeds 2 MiB'));
        return;
      }
      if (end > offset) this.#parts.push(chunk.subarray(offset, end));
      if (newline === -1) return;
      this.#line();
      offset = newline + 1;
    }
  }

  #line() {
    const bytes = Buffer.concat(this.#parts, this.#bytes);
    this.#parts = [];
    this.#bytes = 0;
    let message;
    try {
      const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!line.trim()) return;
      message = JSON.parse(line);
    } catch {
      // JSON.parse diagnostics can quote private prompt or reasoning text.
      this.#fail(new Error('Invalid or incomplete ACP JSON'));
      return;
    }
    try {
      this.#dispatch(message);
    } catch {
      this.#fail(new Error('Invalid ACP JSON-RPC message'));
    }
  }

  #dispatch(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || message.jsonrpc !== '2.0') throw new Error();
    if (has(message, 'method')) {
      if (typeof message.method !== 'string'
        || (has(message, 'id') && !validId(message.id))
        || (has(message, 'params') && (!message.params || typeof message.params !== 'object'))) {
        throw new Error();
      }
      if (has(message, 'id')) {
        if (message.method === 'session/request_permission') {
          // Reverse RPC must not hold up responses or further permissions.
          void this.#permission(message);
        } else {
          this.#send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
        }
      } else if (message.method === 'session/update') {
        try {
          this.#options.onUpdate(message.params);
        } catch {
          this.#fail(new Error('ACP session/update callback failed'));
        }
      }
      return;
    }
    if (!has(message, 'id') || !validId(message.id)
      || has(message, 'result') === has(message, 'error')) throw new Error();
    if (has(message, 'error') && (!message.error
      || !Number.isInteger(message.error.code)
      || typeof message.error.message !== 'string')) throw new Error();
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (has(message, 'error')) {
      const { message: text, code, data } = message.error;
      pending.reject(Object.assign(new Error(text), { code, data }));
    } else {
      pending.resolve(message.result);
    }
  }

  async #permission(message) {
    let response;
    try {
      response = { result: await this.#options.onPermission(message.params) };
      if (response.result === undefined) throw new Error();
    } catch {
      response = { error: { code: -32603, message: 'Permission callback failed' } };
    }
    if (!this.#closing) {
      try {
        this.#send({ id: message.id, ...response });
      } catch {
        if (!this.#closing) this.#fail(new Error('ACP permission response failed'));
      }
    }
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #fail(error) {
    if (this.#finished || this.#closing) return;
    this.#failure = error;
    this.#closing = true;
    this.#rejectPending(error);
    clearTimeout(this.#killTimer);
    this.#child?.kill('SIGKILL');
    this.#finish(undefined, 'error');
  }

  #finish(code, signal) {
    if (this.#finished) return;
    this.#finished = true;
    clearTimeout(this.#killTimer);
    clearTimeout(this.#closeTimer);
    this.#child?.stdout.destroy();
    this.#child?.stderr.destroy();
    this.#parts = [];
    this.#bytes = 0;
    this.#rejectPending(this.#failure ?? new Error(
      `ACP agent exited (code ${code}, signal ${signal})`,
    ));
    if (this.#failure) this.#rejectClosed(this.#failure);
    else this.#resolveClosed({ code, signal });
  }
}
