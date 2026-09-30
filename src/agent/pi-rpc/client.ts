import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { killProcessGroup, spawnProcess, mergeProcessEnv } from '../../platform/spawn';
import { log } from '../../core/logger';
import type { PiRecord } from './event-map';

// PiRecord is defined and exported by event-map.ts so the protocol shape has a
// single source of truth. Re-export it here for callers that only need the RPC
// client seam.
export type { PiRecord } from './event-map';

export interface PiRpcClientOptions {
  /** pi executable (or an executable test fixture). */
  bin: string;
  cwd: string;
  /** Arguments appended after `--mode rpc`. Never contains credentials. */
  args?: readonly string[];
  /**
   * Replace the normal RPC mode arguments. This is useful for a fixture whose
   * command is a Node script (`node fixture.mjs`) rather than a pi executable.
   * Production callers leave this unset.
   */
  modeArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  /** Test seam; production uses the shared platform wrapper. */
  spawn?: typeof spawnProcess;
}

export interface PiRpcClientLike {
  request<T = PiRecord>(type: string, fields?: PiRecord, timeoutMs?: number): Promise<T>;
  write(record: PiRecord): Promise<void>;
  onRecord(listener: (record: PiRecord) => void): () => void;
  onExit(listener: (error?: Error) => void): () => void;
  isAlive(): boolean;
  lastActivity(): number;
  close(graceMs?: number): Promise<void>;
  readonly pid?: number;
}

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  command: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_CLOSE_GRACE_MS = 4_000;

/**
 * Small, dependency-free JSONL client for `pi --mode rpc`.
 *
 * It deliberately does not use readline: Node's readline treats U+2028 and
 * U+2029 as line separators even when they are valid JSON string contents.
 * TextDecoder keeps a UTF-8 code point split across two stdout chunks intact.
 */
export class PiRpcClient implements PiRpcClientLike {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, Pending<unknown>>();
  private readonly recordListeners = new Set<(record: PiRecord) => void>();
  private readonly exitListeners = new Set<(error?: Error) => void>();
  private readonly requestTimeoutMs: number;
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private buffer = '';
  private nextRequest = 0;
  private closed = false;
  private exited = false;
  private exitError: Error | undefined;
  private closePromise: Promise<void> | undefined;
  private activityAt = Date.now();

  constructor(options: PiRpcClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const args = options.modeArgs
      ? [...options.modeArgs]
      : ['--mode', 'rpc', ...(options.args ? [...options.args] : [])];
    const env = mergeProcessEnv(process.env, options.env ?? {});
    const spawn = options.spawn ?? spawnProcess;
    this.child = spawn(options.bin, args, {
      cwd: options.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout?.on('data', (chunk: Buffer | string) => this.onStdout(chunk));
    this.child.stdout?.on('end', () => this.flushDecoder());
    this.child.stderr?.on('data', (chunk: Buffer | string) => {
      // stderr is intentionally not exposed as a protocol record. Keep only a
      // bounded, redacted warning; never echo a settings file or credential.
      this.activityAt = Date.now();
      const text = String(chunk);
      for (const raw of text.split(/\r?\n/)) {
        const line = redactStderr(raw.trim());
        if (line) log.warn('agent', 'pi-stderr', { line });
      }
    });
    this.child.once('error', (cause) => this.finishExit(toError(cause)));
    this.child.once('close', (code, signal) => {
      const reason = code === 0 || code === null
        ? undefined
        : new Error(`pi RPC process exited with code ${String(code)}${signal ? ` (${signal})` : ''}`);
      this.finishExit(reason);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  isAlive(): boolean {
    return !this.closed && !this.exited && this.child.exitCode === null && !this.child.killed;
  }

  lastActivity(): number {
    return this.activityAt;
  }

  onRecord(listener: (record: PiRecord) => void): () => void {
    this.recordListeners.add(listener);
    return () => this.recordListeners.delete(listener);
  }

  onExit(listener: (error?: Error) => void): () => void {
    this.exitListeners.add(listener);
    if (this.exited) queueMicrotask(() => listener(this.exitError));
    return () => this.exitListeners.delete(listener);
  }

  /** Write an extension response or another raw protocol record. */
  async write(record: PiRecord): Promise<void> {
    if (!this.isAlive()) throw this.exitError ?? new Error('pi RPC process is not alive');
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      throw new Error('pi RPC stdin is closed');
    }
    const payload = `${JSON.stringify(record)}\n`;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      try {
        const accepted = stdin.write(payload, 'utf8', (error?: Error | null) => done(error ?? undefined));
        if (!accepted) stdin.once('drain', () => done());
      } catch (error) {
        done(toError(error));
      }
    });
  }

  /** Send a command and correlate its response by an opaque request id. */
  request<T = PiRecord>(type: string, fields: PiRecord = {}, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (!this.isAlive()) return Promise.reject(this.exitError ?? new Error('pi RPC process is not alive'));
    const id = `bridge-${++this.nextRequest}-${randomUUID()}`;
    const payload = { ...fields, id, type };
    return new Promise<T>((resolve, reject) => {
      const pending: Pending<T> = {
        resolve,
        reject,
        command: type,
        ...(timeoutMs > 0 ? {
          timer: setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`pi RPC ${type} response timed out after ${timeoutMs}ms`));
          }, timeoutMs),
        } : {}),
      };
      this.pending.set(id, pending as Pending<unknown>);
      void this.write(payload).catch((error: unknown) => {
        const current = this.pending.get(id);
        if (!current) return;
        this.pending.delete(id);
        if (current.timer) clearTimeout(current.timer);
        current.reject(toError(error));
      });
    });
  }

  async close(graceMs = DEFAULT_CLOSE_GRACE_MS): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      const child = this.child;
      const leaderWasAlive = child.exitCode === null;
      if (leaderWasAlive) {
        try {
          child.stdin?.end();
        } catch {
          // The process may already have closed stdin; process-group cleanup
          // below remains authoritative.
        }
        await waitForExit(child, Math.max(0, graceMs));
      }
      // Sweep the detached group even if the leader already exited. A wrapper
      // can leave descendants behind after its own close event.
      if (child.pid !== undefined) {
        await killProcessGroup(child.pid, () => child.exitCode !== null, { graceMs: 500, pollMs: 50 });
        if (child.exitCode !== null) {
          await killProcessGroup(child.pid, () => false, { graceMs: 500, pollMs: 50 });
        }
      }
      if (!this.exited) this.finishExit(new Error('pi RPC process closed'));
    })();
    return this.closePromise;
  }

  private onStdout(chunk: Buffer | string): void {
    this.activityAt = Date.now();
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    this.consumeLines();
  }

  private flushDecoder(): void {
    this.buffer += this.decoder.decode();
    this.consumeLines();
    if (this.buffer.trim()) {
      this.handleLine(this.buffer);
      this.buffer = '';
    }
  }

  private consumeLines(): void {
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim()) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let record: PiRecord;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('RPC record is not an object');
      }
      record = parsed as PiRecord;
    } catch {
      // Keep malformed payloads out of user-facing diagnostics; a wrapper may
      // accidentally include a token or a private setting in the bad line.
      const diagnostic = new Error('pi RPC 返回了无法解析的 JSON 记录');
      for (const listener of this.recordListeners) {
        try {
          listener({ type: 'response', command: 'parse', success: false, error: diagnostic.message });
        } catch (listenerError) {
          log.fail('agent', listenerError, { backend: 'pi-rpc', phase: 'parse-listener' });
        }
      }
      // A malformed protocol line means the stream cannot be trusted. Reject
      // every outstanding command and notify the run before recycling the
      // detached process; otherwise a prompt can wait forever for a response
      // that will never be parsed.
      this.finishExit(diagnostic);
      void killProcessGroup(this.child.pid, () => this.child.exitCode !== null, { graceMs: 500, pollMs: 50 }).catch((killError: unknown) => {
        log.fail('agent', killError, { backend: 'pi-rpc', phase: 'protocol-error/kill' });
      });
      return;
    }
    this.activityAt = Date.now();
    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.pending.get(record.id);
      if (pending) {
        this.pending.delete(record.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (record.success === false) pending.reject(new Error(String(record.error ?? `pi RPC ${pending.command} failed`)));
        else pending.resolve(record.data as never ?? (record as never));
      }
    }
    for (const listener of this.recordListeners) {
      try {
        listener(record);
      } catch (error) {
        // A listener belongs to a stream consumer. One faulty consumer must not
        // stop protocol delivery to other subscribers or pending requests.
        log.fail('agent', error, { backend: 'pi-rpc', phase: 'record-listener' });
      }
    }
  }

  private finishExit(error?: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.exitError = error;
    const failure = error ?? new Error('pi RPC process exited');
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
    for (const listener of this.exitListeners) {
      try {
        listener(error);
      } catch (listenerError) {
        // Listener failures cannot change process state.
        log.fail('agent', listenerError, { backend: 'pi-rpc', phase: 'exit-listener' });
      }
    }
    this.exitListeners.clear();
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function redactStderr(line: string): string | undefined {
  const match = line.match(/^\s*(?:\[[^\]]+\]\s*)?(warning?|warn|error|fail(?:ure)?|invalid|not found|denied|cannot|unable)\b(?:\s*[:\-]\s*|\s+)?(.*)$/i);
  if (!match) return undefined;
  const detail = (match[2] ?? '')
    .replace(/(["']?)([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)[A-Z0-9_]*)\1\s*[:=]\s*(".*?"|'.*?'|[^\s,;}]+)/gi, '$2=[redacted]')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[redacted-key]')
    .slice(0, 260);
  return `${match[1]}${detail ? `: ${detail}` : ''}`.slice(0, 300);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || timeoutMs <= 0) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener('close', finish);
      child.removeListener('exit', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once('close', finish);
    child.once('exit', finish);
  });
}
