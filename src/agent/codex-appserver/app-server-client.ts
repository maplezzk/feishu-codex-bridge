import { UnsentRequestError } from '../types';
import type { AgentUserInputQuestion, AgentUserInputRequest } from '../types';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mergeProcessEnv, spawnProcess } from '../../platform/spawn';
import { log } from '../../core/logger';
import type { ServerNotification } from './protocol';

/** Simple async queue: push() from the reader, async-iterate from consumers. */
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((v: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined as never, done: true });
  }

  /** Drop everything buffered but not yet consumed (consumers/waiters keep working). */
  clear(): void {
    this.items.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    let ended = false;
    const owned = new Set<(v: IteratorResult<T>) => void>();
    return {
      [Symbol.asyncIterator]() { return this; },
      next: () => {
        if (ended) return Promise.resolve({ value: undefined as never, done: true });
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>(resolve => {
          const waiter = (v: IteratorResult<T>) => { owned.delete(waiter); resolve(v); };
          owned.add(waiter);
          this.waiters.push(waiter);
        });
      },
      return: async () => {
        ended = true;
        for (const waiter of owned) {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          waiter({ value: undefined as never, done: true });
        }
        return { value: undefined as never, done: true };
      },
    };
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** An app-server event plus the bridge-only user-input request event. */
export type AppServerStreamEvent =
  | ServerNotification
  | { method: 'bridge/userInput'; params: AgentUserInputRequest };

interface PendingUserInput {
  key: string;
  request: AgentUserInputRequest;
  pending: boolean;
  resolvedReason?: string;
  listeners: Set<(reason: string) => void>;
}

/** 应用层 JSON-RPC error 应答——进程本身是健康的（它好好地回了包）。按失败
 * 弃置/重建进程的调用方（client-pool 的 utilityRequest）必须把它与超时/传输层
 * 失败区分开：杀掉健康的共享进程会 failAllPending 殃及并发在飞的其他请求。 */
export class JsonRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

export interface AppServerClientOptions {
  bin: string;
  cwd: string;
  env?: Record<string, string>;
  clientName?: string;
}

/**
 * One `codex app-server --listen stdio://` child process, speaking JSON-RPC 2.0
 * over newline-delimited JSON. One client = one thread/session (per design:
 * a process per session for crash isolation). The one exception is the shared
 * metadata utility client (client-pool.ts), which hosts no threads at all.
 */
export class AppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly events = new AsyncQueue<AppServerStreamEvent>();
  private readonly pendingUserInputs = new Map<string, PendingUserInput>();
  private closed = false;
  private hasExited = false;
  /** A live process can still become unusable when Codex loses a custom
   * collaboration-tool result or a subagent registration. Keep that state
   * separate from `exited`: callers can finish reporting the current turn and
   * then recycle the process instead of reusing a poisoned session. */
  private protocolFaultReason: string | undefined;

  constructor(private readonly opts: AppServerClientOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** true once the child process has exited (crash or close) — the client is
   * dead and every further request would just EPIPE. Callers (CodexThread.
   * isAlive) use this to evict the thread so resolveThread's resume fallback
   * can take over instead of reusing a corpse. */
  get exited(): boolean {
    return this.hasExited || this.closed;
  }

  /** True when stderr proves that Codex's collaboration/tool lifecycle is out
   * of sync. The process may still be alive, but a later turn must not reuse it. */
  get needsRecycle(): boolean {
    return Boolean(this.protocolFaultReason);
  }

  get recycleReason(): string | undefined {
    return this.protocolFaultReason;
  }

  /** spawn + initialize handshake. Throws if spawn/handshake fails. */
  async connect(): Promise<void> {
    // Launch via cross-spawn (platform/spawn) so a Windows `.cmd` codex shim
    // runs instead of throwing EINVAL (CVE-2024-27980). With stdio all-piped the
    // streams are non-null, so the cast to *WithoutNullStreams is sound.
    const child = spawnProcess(this.opts.bin, ['app-server', '--listen', 'stdio://'], {
      cwd: this.opts.cwd,
      env: mergeProcessEnv(process.env, { ...this.opts.env, FEISHU_CODEX_BRIDGE: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    log.info('agent', 'spawn', { pid: child.pid ?? null, cwd: this.opts.cwd });

    child.stdout.on('data', (d: Buffer) => this.onStdout(d));
    child.stderr.on('data', (d: Buffer) => {
      const line = d.toString('utf8').trim();
      if (!line) return;
      const fault = protocolFaultIn(line);
      if (fault && !this.protocolFaultReason) {
        this.protocolFaultReason = fault;
        log.warn('agent', 'protocol-fault', { pid: child.pid ?? null, reason: fault });
      }
      log.warn('agent', 'stderr', { line: line.slice(0, 200) });
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      // Mark the client dead so later request()/notify() reject fast instead of
      // writing into a broken pipe (and isAlive() reports the truth).
      this.hasExited = true;
      this.closed = true;
      this.failAllPending(new Error(`app-server exited (code=${code} signal=${signal})`));
      this.resolveAllUserInputs('process-exited');
      this.events.close();
    });
    child.on('error', (err) => this.failAllPending(err));
    // Writable streams emit their own error in addition to write callbacks.
    child.stdin.on('error', (err) => {
      this.failAllPending(err);
      void this.close();
    });

    await this.request('initialize', {
      clientInfo: { name: this.opts.clientName ?? 'feishu-codex-bridge', version: '0.0.1' },
      // experimentalApi opts into experimental JSON-RPC methods + fields — REQUIRED
      // for the goal RPCs (thread/goal/set|get|clear). Verified against codex 0.139:
      // without it, thread/goal/set is rejected. The `goals` feature itself is
      // stable+on by default there, so no experimentalFeature/enablement/set needed.
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized');
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed || !this.child) return Promise.reject(new UnsentRequestError('app-server client closed'));
    this.handleOutgoingLifecycle(method, params);
    const id = ++this.nextId;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} response timed out; delivery unknown`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value as T); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.child!.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || !this.child) return;
    this.handleOutgoingLifecycle(method, params);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })}\n`);
  }

  /** async-iterate server notifications (closes when the process exits). */
  stream(): AsyncIterable<ServerNotification> {
    const source = this.events[Symbol.asyncIterator]();
    let ended = false;
    const iterator: AsyncIterableIterator<ServerNotification> = {
      [Symbol.asyncIterator]() { return this; },
      next: async () => {
        while (!ended) {
          const step = await source.next();
          if (step.done || ended) break;
          const event = step.value;
          if (event.method !== 'bridge/userInput') return { value: event, done: false };
          if (event.params.isPending()) {
            void event.params.reject('User input unavailable in this operation').catch((err: unknown) => {
              log.fail('agent', err, { phase: 'user-input/unavailable' });
            });
          }
        }
        return { value: undefined as never, done: true };
      },
      // Forward cancellation directly: an async generator's return() queues
      // behind a pending next(), leaving the queue reader alive indefinitely.
      return: async () => {
        ended = true;
        await source.return?.();
        return { value: undefined as never, done: true };
      },
    };
    return iterator;
  }

  /** Async-iterate normal notifications and bridge user-input requests. */
  streamEvents(): AsyncIterable<AppServerStreamEvent> {
    return this.events;
  }

  /** Whether an unclosed request_user_input belongs to the supplied scope. */
  hasPendingUserInput(scope: { threadId: string; turnId?: string }): boolean {
    for (const { request, pending } of this.pendingUserInputs.values()) {
      if (!pending || request.threadId !== scope.threadId) continue;
      if (scope.turnId === undefined || request.turnId === scope.turnId) return true;
    }
    return false;
  }

  /** Reject still-pending interactive requests when their consumer stops. */
  async rejectPendingUserInputs(
    scope: { threadId?: string; turnId?: string },
    reason: string,
  ): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const { request } of [...this.pendingUserInputs.values()]) {
      if (scope.threadId !== undefined && request.threadId !== scope.threadId) continue;
      if (scope.turnId !== undefined && request.turnId !== scope.turnId) continue;
      if (request.isPending()) writes.push(request.reject(reason));
    }
    await Promise.all(writes);
  }

  /** Drop buffered, un-consumed notifications. Used when a prewarmed pool client
   * is taken for a real session: notifications buffered while it idled in the
   * pool (MCP startup progress, the ephemeral warmup thread/started, …) belong
   * to the warmup thread and must never leak into the session's event stream. */
  clearNotifications(): void {
    this.events.clear();
    void this.rejectPendingUserInputs({}, 'User input unavailable in this operation').catch((err: unknown) => {
      log.fail('agent', err, { phase: 'user-input/clear-buffer' });
    });
  }

  async close(graceMs = 4000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.resolveAllUserInputs('client-closed');
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.events.close();
      return;
    }

    if (process.platform === 'win32' && child.pid) {
      // Windows has no POSIX signals, and child.kill() can't reap codex's
      // grandchildren (MCP / tool subprocesses) — they'd orphan. `taskkill /T`
      // terminates the whole process tree; wait for exit with graceMs fallback.
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          resolve();
        };
        const t = setTimeout(done, graceMs);
        child.once('exit', done);
        spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on(
          'error',
          () => {
            child.kill();
            done();
          },
        );
      });
      return;
    }

    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, graceMs);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private onStdout(d: Buffer): void {
    this.buf += d.toString('utf8');
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      log.warn('agent', 'nonjson', { line: line.slice(0, 120) });
      return;
    }

    // response to one of our requests
    if (typeof msg.id === 'number' && (('result' in msg) || ('error' in msg)) && !('method' in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if ('error' in msg && msg.error) {
        const e = msg.error as { message?: string };
        p.reject(new JsonRpcError(e.message ?? 'JSON-RPC error'));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // server-initiated request. request_user_input is the one interactive
    // method the bridge forwards; malformed payloads receive an explicit
    // JSON-RPC invalid-params error, while all other requests keep the old
    // method-not-found behavior so the app-server cannot remain blocked.
    if (isRpcId(msg.id) && typeof msg.method === 'string') {
      if (msg.method === 'item/tool/requestUserInput') {
        this.handleUserInputRequest(msg.id, msg.params);
      } else {
        this.sendRpcError(msg.id, -32601, 'not handled');
      }
      return;
    }

    // notification
    if (typeof msg.method === 'string') {
      const notification = msg as unknown as ServerNotification;
      this.handleNotificationLifecycle(notification);
      this.events.push(notification);
    }
  }

  private failAllPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private handleUserInputRequest(requestId: string | number, rawParams: unknown): void {
    const parsed = parseUserInputParams(rawParams);
    if (!parsed.ok) {
      this.sendRpcError(requestId, -32602, parsed.error);
      return;
    }
    const key = rpcIdKey(requestId);
    if (this.pendingUserInputs.has(key)) {
      this.sendRpcError(requestId, -32600, 'duplicate request id');
      return;
    }

    const state: PendingUserInput = {
      key,
      request: undefined as never,
      pending: true,
      listeners: new Set(),
    };
    const finish = (reason: string): boolean => this.finishUserInput(state, reason);
    const request: AgentUserInputRequest = {
      requestId,
      threadId: parsed.params.threadId,
      turnId: parsed.params.turnId,
      itemId: parsed.params.itemId,
      questions: parsed.params.questions,
      ...(parsed.params.autoResolutionMs !== undefined
        ? { autoResolutionMs: parsed.params.autoResolutionMs }
        : {}),
      isPending: () => state.pending,
      respond: async (answers) => {
        if (!finish('responded')) throw new Error('user input request is no longer pending');
        await this.writeServerResponse(requestId, { answers });
      },
      reject: async (reason) => {
        if (!finish('rejected')) throw new Error('user input request is no longer pending');
        await this.writeServerError(requestId, -32000, reason || 'request rejected');
      },
      onResolved: (listener) => {
        if (!state.pending) {
          try {
            listener(state.resolvedReason ?? 'resolved');
          } catch (err) {
            log.fail('agent', err, { phase: 'user-input/resolved-listener', reason: state.resolvedReason ?? 'resolved' });
          }
          return () => undefined;
        }
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
    };
    state.request = request;
    this.pendingUserInputs.set(key, state);
    this.events.push({ method: 'bridge/userInput', params: request });
  }

  private finishUserInput(state: PendingUserInput, reason: string): boolean {
    if (!state.pending) return false;
    state.pending = false;
    state.resolvedReason = reason;
    this.pendingUserInputs.delete(state.key);
    for (const listener of state.listeners) {
      try {
        listener(reason);
      } catch (err) {
        log.fail('agent', err, { phase: 'user-input/resolved-listener', reason });
      }
    }
    state.listeners.clear();
    return true;
  }

  private resolveAllUserInputs(reason: string): void {
    for (const state of [...this.pendingUserInputs.values()]) this.finishUserInput(state, reason);
  }

  private resolveUserInputs(
    predicate: (request: AgentUserInputRequest) => boolean,
    reason: string,
  ): void {
    for (const state of [...this.pendingUserInputs.values()]) {
      if (predicate(state.request)) this.finishUserInput(state, reason);
    }
  }

  private handleNotificationLifecycle(notification: ServerNotification): void {
    switch (notification.method) {
      case 'serverRequest/resolved': {
        const key = rpcIdKey(notification.params.requestId);
        const state = this.pendingUserInputs.get(key);
        if (state && state.request.threadId === notification.params.threadId) {
          this.finishUserInput(state, 'server-resolved');
        }
        return;
      }
      case 'turn/started':
        this.resolveUserInputs(
          (request) => request.threadId === notification.params.threadId && request.turnId !== notification.params.turn.id,
          'turn-started',
        );
        return;
      case 'turn/completed':
        this.resolveUserInputs(
          (request) => request.threadId === notification.params.threadId && request.turnId === notification.params.turn.id,
          'turn-completed',
        );
        return;
      case 'thread/closed':
        this.resolveUserInputs(
          (request) => request.threadId === notification.params.threadId,
          'thread-closed',
        );
        return;
      case 'error':
        if (!notification.params.willRetry) {
          this.resolveUserInputs(
            (request) => request.threadId === notification.params.threadId && request.turnId === notification.params.turnId,
            'turn-error',
          );
        }
        return;
      default:
        return;
    }
  }

  private handleOutgoingLifecycle(method: string, rawParams: unknown): void {
    if (!isRecord(rawParams)) return;
    const threadId = typeof rawParams.threadId === 'string' ? rawParams.threadId : undefined;
    const turnId = typeof rawParams.turnId === 'string' ? rawParams.turnId : undefined;
    if (method === 'turn/interrupt' && threadId && turnId) {
      this.resolveUserInputs(
        (request) => request.threadId === threadId && request.turnId === turnId,
        'turn-interrupted',
      );
    } else if (method === 'thread/close' && threadId) {
      this.resolveUserInputs((request) => request.threadId === threadId, 'thread-closed');
    }
  }

  private sendRpcError(requestId: string | number, code: number, message: string): void {
    void this.writeServerError(requestId, code, message).catch((err: unknown) => {
      log.fail('agent', err, { phase: 'server-request/error-response', requestId, code });
    });
  }

  private writeServerResponse(requestId: string | number, result: unknown): Promise<void> {
    return this.writeServerLine({ jsonrpc: '2.0', id: requestId, result });
  }

  private writeServerError(requestId: string | number, code: number, message: string): Promise<void> {
    return this.writeServerLine({ jsonrpc: '2.0', id: requestId, error: { code, message } });
  }

  private writeServerLine(payload: unknown): Promise<void> {
    if (this.closed || !this.child) {
      return Promise.reject(new UnsentRequestError('app-server client closed'));
    }
    return new Promise<void>((resolve, reject) => {
      try {
        this.child!.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

interface ParsedUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: AgentUserInputQuestion[];
  autoResolutionMs?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is string | number {
  return (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isFinite(value));
}

function rpcIdKey(value: string | number): string {
  return `${typeof value}:${String(value)}`;
}

function parseUserInputParams(raw: unknown):
  | { ok: true; params: ParsedUserInputParams }
  | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'invalid requestUserInput params' };
  const threadId = raw.threadId;
  const turnId = raw.turnId;
  const itemId = raw.itemId;
  if (typeof threadId !== 'string' || threadId.length === 0) {
    return { ok: false, error: 'invalid requestUserInput params: threadId' };
  }
  if (typeof turnId !== 'string' || turnId.length === 0) {
    return { ok: false, error: 'invalid requestUserInput params: turnId' };
  }
  if (typeof itemId !== 'string' || itemId.length === 0) {
    return { ok: false, error: 'invalid requestUserInput params: itemId' };
  }

  const rawQuestions = raw.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > 3) {
    return { ok: false, error: 'invalid requestUserInput params: questions must contain 1-3 items' };
  }
  const questionIds = new Set<string>();
  const questions: AgentUserInputQuestion[] = [];
  for (const rawQuestion of rawQuestions) {
    if (!isRecord(rawQuestion)) return { ok: false, error: 'invalid requestUserInput question' };
    const id = rawQuestion.id;
    const header = rawQuestion.header;
    const question = rawQuestion.question;
    const isOther = rawQuestion.isOther;
    const isSecret = rawQuestion.isSecret;
    if (
      typeof id !== 'string' || id.length === 0 ||
      typeof header !== 'string' || header.length === 0 ||
      typeof question !== 'string' || question.length === 0 ||
      typeof isOther !== 'boolean' || typeof isSecret !== 'boolean'
    ) {
      return { ok: false, error: 'invalid requestUserInput question fields' };
    }
    if (questionIds.has(id)) {
      return { ok: false, error: 'invalid requestUserInput params: duplicate question id' };
    }
    questionIds.add(id);

    const rawOptions = rawQuestion.options;
    if (rawOptions !== null && !Array.isArray(rawOptions)) {
      return { ok: false, error: 'invalid requestUserInput options' };
    }
    const options: Array<{ label: string; description: string }> | null = rawOptions === null ? null : [];
    for (const rawOption of rawOptions ?? []) {
      if (!isRecord(rawOption)) return { ok: false, error: 'invalid requestUserInput option fields' };
      const label = rawOption.label;
      const description = rawOption.description;
      if (
        typeof label !== 'string' ||
        typeof description !== 'string'
      ) {
        return { ok: false, error: 'invalid requestUserInput option fields' };
      }
      options!.push({ label, description });
    }
    questions.push({
      id,
      header,
      question,
      isOther,
      isSecret,
      options,
    });
  }

  let autoResolutionMs: number | null | undefined;
  if ('autoResolutionMs' in raw) {
    if (raw.autoResolutionMs !== null &&
        (typeof raw.autoResolutionMs !== 'number' || !Number.isFinite(raw.autoResolutionMs) || raw.autoResolutionMs < 0)) {
      return { ok: false, error: 'invalid requestUserInput params: autoResolutionMs' };
    }
    autoResolutionMs = raw.autoResolutionMs as number | null;
  }
  return {
    ok: true,
    params: {
      threadId,
      turnId,
      itemId,
      questions,
      ...(autoResolutionMs !== undefined ? { autoResolutionMs } : {}),
    },
  };
}

/** Known Codex core errors that leave the collaboration registry or a custom
 * tool call unresolved. They are recoverable only by recycling the app-server
 * process; keeping it in the live-session cache makes every later turn inherit
 * the stale registry. */
function protocolFaultIn(stderr: string): string | undefined {
  if (/Custom tool call output is missing for call id:/i.test(stderr)) {
    return 'missing-custom-tool-output';
  }
  if (/agent with id .* not found/i.test(stderr)) return 'subagent-not-found';
  return undefined;
}
