import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AppServerClient } from '../src/agent/codex-appserver/app-server-client';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import { writeNodeExecutable } from './helpers/node-executable';

// A small app-server fixture that emits request_user_input from turn/start and
// records the bridge's JSON-RPC response. The bridge tests use the real child
// process transport so numeric and string request ids exercise the wire format.
const SERVER = `#!/usr/bin/env node
const fs = require('node:fs');
let buf = '';
const mode = process.env.USER_INPUT_MODE || 'answer';
const logFile = process.env.USER_INPUT_LOG;
const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\\n');
const log = (obj) => { if (logFile) fs.appendFileSync(logFile, JSON.stringify(obj) + '\\n'); };
const validParams = (turnId = 'turn-1') => ({
  threadId: 'thread-1', turnId, itemId: 'item-1', autoResolutionMs: null,
  questions: [{
    id: 'choice', header: 'Choice', question: 'Pick one', isOther: true, isSecret: false,
    options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }],
  }],
});
function emitInput(id, params = validParams()) { send({ id, method: 'item/tool/requestUserInput', params }); }
function emitTurnStarted(id = 'turn-1') { send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id } } }); }
function emitResolved(id) { send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: id } }); }
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    log(msg);
    if (msg.method === 'initialize') { send({ id: msg.id, result: {} }); continue; }
    if (msg.method === 'thread/start') { send({ id: msg.id, result: { thread: { id: 'thread-1' } } }); continue; }
    if (msg.method === 'turn/start') {
      send({ id: msg.id, result: { turn: { id: 'turn-1' } } });
      emitTurnStarted();
      if (mode === 'answer') emitInput(101);
      else if (mode === 'string-answer') emitInput('request-string');
      else if (mode === 'resolved') {
        emitInput(102);
        setTimeout(() => emitResolved(102), 10);
      } else if (mode === 'disconnect') {
        emitInput(103);
        setTimeout(() => process.exit(17), 10);
      } else if (mode === 'invalid') {
        emitInput(104, { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', questions: [] });
      } else if (mode === 'duplicate-question') {
        emitInput(105, { ...validParams(), questions: [
          validParams().questions[0], { ...validParams().questions[0] },
        ] });
      } else if (mode === 'unhandled') {
        send({ id: 106, method: 'item/commandExecution/requestApproval', params: {} });
        send({ id: 'unhandled-string', method: 'item/commandExecution/requestApproval', params: {} });
      } else if (mode === 'wrong-turn') {
        emitInput(107, validParams('old-turn'));
      }
      continue;
    }
    if (!msg.method && Object.prototype.hasOwnProperty.call(msg, 'id')) {
      if (mode === 'answer' || mode === 'string-answer') {
        setTimeout(() => emitResolved(msg.id), 5);
      }
      continue;
    }
  }
});
setInterval(() => {}, 1 << 30);
`;

const dir = mkdtempSync(join(tmpdir(), 'app-server-user-input-'));
const { bin } = writeNodeExecutable(dir, 'codex', SERVER);

function trash(path: string): void {
  const result = spawnSync('trash', [path], { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    console.warn(`trash unavailable; leaving temporary test directory for system cleanup: ${path}`);
  }
}

function readLog(path: string): Record<string, any>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function withClient<T>(mode: string, fn: (client: AppServerClient, logFile: string) => Promise<T>): Promise<T> {
  const logFile = join(dir, `${mode}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const client = new AppServerClient({
    bin,
    cwd: dir,
    env: { USER_INPUT_MODE: mode, USER_INPUT_LOG: logFile },
  });
  try {
    await client.connect();
    await client.request('thread/start', { cwd: dir });
    return await fn(client, logFile);
  } finally {
    await client.close();
  }
}

afterAll(async () => {
  await shutdownResidentClients();
  trash(dir);
});

describe('app-server request_user_input transport', () => {
  it('answers the original numeric request id once and exposes the resolved lifecycle', async () => {
    await withClient('answer', async (client, logFile) => {
      const events = client.streamEvents()[Symbol.asyncIterator]();
      await client.request('turn/start', {});
      const started = await events.next();
      expect(started.value).toMatchObject({ method: 'turn/started' });
      const input = await events.next();
      expect(input.value).toMatchObject({ method: 'bridge/userInput' });
      if (input.done || input.value.method !== 'bridge/userInput') throw new Error('missing user input');
      const request = input.value.params;
      expect(request.requestId).toBe(101);
      expect(request.autoResolutionMs).toBeNull();
      expect(request.questions[0]?.id).toBe('choice');
      expect(request.questions[0]?.options).toEqual([{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }]);
      const resolutions: string[] = [];
      request.onResolved((reason) => resolutions.push(reason));
      await request.respond({ choice: { answers: ['A'] } });
      await expect(request.respond({ choice: { answers: ['B'] } })).rejects.toThrow(/no longer pending/);
      await vi.waitFor(() => expect(resolutions).toEqual(['responded']));
      await vi.waitFor(() => expect(readLog(logFile).some((line) => line.id === 101 && line.result?.answers?.choice?.answers?.[0] === 'A')).toBe(true));
      expect(request.isPending()).toBe(false);
    });
  });

  it('preserves string request ids and sends an RPC response with the same id', async () => {
    await withClient('string-answer', async (client, logFile) => {
      const events = client.streamEvents()[Symbol.asyncIterator]();
      await client.request('turn/start', {});
      await events.next();
      const input = await events.next();
      if (input.done || input.value.method !== 'bridge/userInput') throw new Error('missing user input');
      await input.value.params.respond({ choice: { answers: ['typed'] } });
      await vi.waitFor(() => expect(readLog(logFile).some((line) => line.id === 'request-string' && line.result)).toBe(true));
    });
  });

  it('does not answer a request already resolved by app-server', async () => {
    await withClient('resolved', async (client, logFile) => {
      const events = client.streamEvents()[Symbol.asyncIterator]();
      await client.request('turn/start', {});
      await events.next();
      const input = await events.next();
      if (input.done || input.value.method !== 'bridge/userInput') throw new Error('missing user input');
      const request = input.value.params;
      let reason: string | undefined;
      request.onResolved((value) => { reason = value; });
      await vi.waitFor(() => expect(reason).toBe('server-resolved'));
      expect(request.isPending()).toBe(false);
      await expect(request.respond({ choice: { answers: ['late'] } })).rejects.toThrow(/no longer pending/);
      expect(readLog(logFile).some((line) => line.id === 102 && line.result)).toBe(false);
    });
  });

  it('resolves pending requests on process disconnect without hiding process death', async () => {
    await withClient('disconnect', async (client) => {
      const events = client.streamEvents()[Symbol.asyncIterator]();
      await client.request('turn/start', {});
      await events.next();
      const input = await events.next();
      if (input.done || input.value.method !== 'bridge/userInput') throw new Error('missing user input');
      const request = input.value.params;
      let reason: string | undefined;
      request.onResolved((value) => { reason = value; });
      await vi.waitFor(() => expect(reason).toBe('process-exited'));
      expect(client.exited).toBe(true);
      expect(request.isPending()).toBe(false);
      expect(client.hasPendingUserInput({ threadId: 'thread-1', turnId: 'turn-1' })).toBe(false);
    });
  });

  it('returns explicit invalid-params errors for malformed questions', async () => {
    await withClient('invalid', async (client, logFile) => {
      const events = client.streamEvents()[Symbol.asyncIterator]();
      await client.request('turn/start', {});
      await events.next();
      await vi.waitFor(() => expect(readLog(logFile).some((line) => line.id === 104 && line.error?.code === -32602)).toBe(true));
      const pending = await Promise.race([
        events.next().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
      ]);
      expect(pending).toBe(false);
    });
  });

  it('rejects duplicate question ids and leaves no pending bridge request', async () => {
    await withClient('duplicate-question', async (client, logFile) => {
      const events = client.streamEvents()[Symbol.asyncIterator]();
      await client.request('turn/start', {});
      await events.next();
      await vi.waitFor(() => expect(readLog(logFile).some((line) => line.id === 105 && line.error?.code === -32602)).toBe(true));
    });
  });

  it('keeps other server requests non-blocking with -32601 for numeric and string ids', async () => {
    await withClient('unhandled', async (client, logFile) => {
      await client.request('turn/start', {});
      await vi.waitFor(() => {
        const replies = readLog(logFile).filter((line) => line.error?.code === -32601);
        expect(replies.map((line) => line.id).sort()).toEqual([106, 'unhandled-string'].sort());
      });
    });
  });

  it('stream() filters and rejects a user-input request that has no interactive consumer', async () => {
    await withClient('answer', async (client, logFile) => {
      const notifications = client.stream()[Symbol.asyncIterator]();
      await client.request('turn/start', {});
      await expect(notifications.next()).resolves.toMatchObject({ value: { method: 'turn/started' }, done: false });
      const next = notifications.next();
      await vi.waitFor(() => expect(readLog(logFile).some((line) => line.id === 101 && line.error?.code === -32000)).toBe(true));
      await client.close();
      await next;
    });
  });
});
