import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import type { AgentEvent } from '../src/agent/types';
import { writeNodeExecutable } from './helpers/node-executable';

const SERVER = `#!/usr/bin/env node
const fs = require('node:fs');
let buf = '';
const mode = process.env.BACKEND_USER_INPUT_MODE || 'normal';
const logFile = process.env.BACKEND_USER_INPUT_LOG;
const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\\n');
const log = (obj) => { if (logFile) fs.appendFileSync(logFile, JSON.stringify(obj) + '\\n'); };
const inputParams = (turnId) => ({
  threadId: 'thread-backend', turnId, itemId: 'item-input',
  questions: [{ id: 'answer', header: 'Answer', question: 'Continue?', isOther: false, isSecret: false, options: null }],
});
const emitInput = (id, turnId) => send({ id, method: 'item/tool/requestUserInput', params: inputParams(turnId) });
const emitResolved = (id) => send({ method: 'serverRequest/resolved', params: { threadId: 'thread-backend', requestId: id } });
const emitDone = (turnId) => send({ method: 'turn/completed', params: { threadId: 'thread-backend', turn: { id: turnId } } });
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    log(msg);
    if (msg.method === 'initialize') { send({ id: msg.id, result: {} }); continue; }
    if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
      send({ id: msg.id, result: { thread: { id: 'thread-backend' } } });
      continue;
    }
    if (msg.method === 'thread/goal/clear') { send({ id: msg.id, result: {} }); continue; }
    if (msg.method === 'turn/start') {
      send({ id: msg.id, result: { turn: { id: 'turn-backend' } } });
      send({ method: 'turn/started', params: { threadId: 'thread-backend', turn: { id: 'turn-backend' } } });
      emitInput(201, mode === 'wrong-turn' ? 'old-turn' : 'turn-backend');
      continue;
    }
    if (msg.method === 'thread/goal/set') {
      send({ id: msg.id, result: {} });
      send({ method: 'thread/goal/updated', params: { threadId: 'thread-backend', turnId: 'goal-turn', goal: {
        status: 'active', objective: msg.params.objective, tokensUsed: 1, timeUsedSeconds: 1, tokenBudget: 100,
      } } });
      send({ method: 'turn/started', params: { threadId: 'thread-backend', turn: { id: 'goal-turn' } } });
      send({ method: 'turn/started', params: { threadId: 'child-thread', turn: { id: 'child-turn' } } });
      send({ method: 'turn/completed', params: { threadId: 'child-thread', turn: { id: 'child-turn' } } });
      emitInput(202, 'goal-turn');
      continue;
    }
    if (!msg.method && Object.prototype.hasOwnProperty.call(msg, 'id')) {
      if (msg.result) {
        const requestId = msg.id;
        const turnId = requestId === 202 ? 'goal-turn' : 'turn-backend';
        emitResolved(requestId);
        if (requestId === 202) {
          send({ method: 'thread/goal/updated', params: { threadId: 'thread-backend', turnId, goal: {
            status: 'complete', objective: 'goal objective', tokensUsed: 2, timeUsedSeconds: 2, tokenBudget: 100,
          } } });
        }
        emitDone(turnId);
      }
      continue;
    }
  }
});
setInterval(() => {}, 1 << 30);
`;

const dir = mkdtempSync(join(tmpdir(), 'codex-user-input-backend-'));
const { bin } = writeNodeExecutable(dir, 'codex', SERVER);
const logFile = join(dir, 'wire.jsonl');

function trash(path: string): void {
  const result = spawnSync('trash', [path], { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    console.warn(`trash unavailable; leaving temporary test directory for system cleanup: ${path}`);
  }
}

function readLog(): Record<string, any>[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function start() {
  const backend = new CodexAppServerBackend();
  const thread = await backend.startThread({ cwd: dir });
  return thread;
}

afterEach(async () => {
  await shutdownResidentClients();
  delete process.env.BACKEND_USER_INPUT_MODE;
  delete process.env.BACKEND_USER_INPUT_LOG;
});

afterAll(() => {
  trash(dir);
});

describe('Codex backend user-input scope and goal wiring', () => {
  it('enables default-mode request_user_input on thread/start and thread/resume', async () => {
    const previousBin = process.env.CODEX_BIN;
    const previousLog = process.env.BACKEND_USER_INPUT_LOG;
    process.env.CODEX_BIN = bin;
    process.env.BACKEND_USER_INPUT_LOG = logFile;
    try {
      const backend = new CodexAppServerBackend();
      const started = await backend.startThread({ cwd: dir });
      await started.close();
      const resumed = await backend.resumeThread({ cwd: dir, sessionId: 'thread-backend' });
      await resumed.close();
      const controlRequests = readLog().filter((line) =>
        (line.method === 'thread/start' || line.method === 'thread/resume') && !line.params?.ephemeral,
      );
      expect(controlRequests.length).toBeGreaterThanOrEqual(2);
      for (const request of controlRequests) {
        expect(request.params.config['features.default_mode_request_user_input']).toBe(true);
      }
    } finally {
      if (previousBin === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previousBin;
      if (previousLog === undefined) delete process.env.BACKEND_USER_INPUT_LOG;
      else process.env.BACKEND_USER_INPUT_LOG = previousLog;
    }
  });

  it('yields only exact thread and turn requests, and responds on the original id', async () => {
    const previousBin = process.env.CODEX_BIN;
    const previousMode = process.env.BACKEND_USER_INPUT_MODE;
    const previousLog = process.env.BACKEND_USER_INPUT_LOG;
    process.env.CODEX_BIN = bin;
    process.env.BACKEND_USER_INPUT_MODE = 'normal';
    process.env.BACKEND_USER_INPUT_LOG = logFile;
    try {
      const thread = await start();
      const run = thread.runStreamed({ text: 'ask' });
      const iterator = run.events[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({ type: 'turn_started', turnId: 'turn-backend' });
      const input = await iterator.next();
      if (input.done || input.value.type !== 'user_input_request') throw new Error('missing scoped request');
      expect(input.value.request.requestId).toBe(201);
      expect(run.lastActivity!()).toBeGreaterThanOrEqual(Date.now() - 100);
      await input.value.request.respond({ answer: { answers: ['yes'] } });
      const done = await iterator.next();
      expect(done.value).toEqual({ type: 'done', turnId: 'turn-backend' });
      await vi.waitFor(() => expect(readLog().some((line) => line.id === 201 && line.result)).toBe(true));
      await thread.close();
    } finally {
      if (previousBin === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previousBin;
      if (previousMode === undefined) delete process.env.BACKEND_USER_INPUT_MODE;
      else process.env.BACKEND_USER_INPUT_MODE = previousMode;
      if (previousLog === undefined) delete process.env.BACKEND_USER_INPUT_LOG;
      else process.env.BACKEND_USER_INPUT_LOG = previousLog;
    }
  });

  it('explicitly rejects a request from an old turn', async () => {
    const previousBin = process.env.CODEX_BIN;
    const previousMode = process.env.BACKEND_USER_INPUT_MODE;
    const previousLog = process.env.BACKEND_USER_INPUT_LOG;
    process.env.CODEX_BIN = bin;
    process.env.BACKEND_USER_INPUT_MODE = 'wrong-turn';
    process.env.BACKEND_USER_INPUT_LOG = logFile;
    let thread: Awaited<ReturnType<typeof start>> | undefined;
    try {
      thread = await start();
      const run = thread.runStreamed({ text: 'stale' });
      const iterator = run.events[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({ type: 'turn_started', turnId: 'turn-backend' });
      const next = iterator.next();
      await vi.waitFor(() => expect(readLog().some((line) => line.id === 201 && line.error?.code === -32000)).toBe(true));
      await thread.close();
      await next;
    } finally {
      await thread?.close();
      if (previousBin === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previousBin;
      if (previousMode === undefined) delete process.env.BACKEND_USER_INPUT_MODE;
      else process.env.BACKEND_USER_INPUT_MODE = previousMode;
      if (previousLog === undefined) delete process.env.BACKEND_USER_INPUT_LOG;
      else process.env.BACKEND_USER_INPUT_LOG = previousLog;
    }
  });

  it('rejects an unanswered request when the event consumer returns early', async () => {
    const previousBin = process.env.CODEX_BIN;
    const previousMode = process.env.BACKEND_USER_INPUT_MODE;
    const previousLog = process.env.BACKEND_USER_INPUT_LOG;
    process.env.CODEX_BIN = bin;
    process.env.BACKEND_USER_INPUT_MODE = 'normal';
    process.env.BACKEND_USER_INPUT_LOG = logFile;
    let thread: Awaited<ReturnType<typeof start>> | undefined;
    try {
      thread = await start();
      const run = thread.runStreamed({ text: 'return-early' });
      const iterator = run.events[Symbol.asyncIterator]();
      await iterator.next();
      const input = await iterator.next();
      if (input.done || input.value.type !== 'user_input_request') throw new Error('missing scoped request');
      await iterator.return?.();
      await vi.waitFor(() => expect(readLog().some((line) => line.id === 201 && line.error?.code === -32000)).toBe(true));
    } finally {
      await thread?.close();
      if (previousBin === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previousBin;
      if (previousMode === undefined) delete process.env.BACKEND_USER_INPUT_MODE;
      else process.env.BACKEND_USER_INPUT_MODE = previousMode;
      if (previousLog === undefined) delete process.env.BACKEND_USER_INPUT_LOG;
      else process.env.BACKEND_USER_INPUT_LOG = previousLog;
    }
  });

  it('keeps goal input bound to the parent turn while child turns start and finish', async () => {
    const previousBin = process.env.CODEX_BIN;
    const previousMode = process.env.BACKEND_USER_INPUT_MODE;
    const previousLog = process.env.BACKEND_USER_INPUT_LOG;
    process.env.CODEX_BIN = bin;
    process.env.BACKEND_USER_INPUT_MODE = 'goal';
    process.env.BACKEND_USER_INPUT_LOG = logFile;
    let thread: Awaited<ReturnType<typeof start>> | undefined;
    try {
      thread = await start();
      const run = thread.runGoal('goal objective');
      const iterator = run.events[Symbol.asyncIterator]();
      let input: Extract<AgentEvent, { type: 'user_input_request' }> | undefined;
      const seen: AgentEvent[] = [];
      while (!input) {
        const step = await iterator.next();
        if (step.done) throw new Error('goal ended before user input');
        if (step.value.type === 'turn_started') expect(step.value.turnId).toBe('goal-turn');
        seen.push(step.value);
        if (step.value.type === 'user_input_request') input = step.value;
      }
      expect(input.request.turnId).toBe('goal-turn');
      await input.request.respond({ answer: { answers: ['yes'] } });
      while (true) {
        const step = await iterator.next();
        if (step.done) break;
        seen.push(step.value);
      }
      expect(seen.some((event) => event.type === 'goal_update' && event.status === 'complete')).toBe(true);
      expect(seen.some((event) => event.type === 'done' && event.turnId === 'goal-turn')).toBe(true);
    } finally {
      await thread?.close();
      if (previousBin === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previousBin;
      if (previousMode === undefined) delete process.env.BACKEND_USER_INPUT_MODE;
      else process.env.BACKEND_USER_INPUT_MODE = previousMode;
      if (previousLog === undefined) delete process.env.BACKEND_USER_INPUT_LOG;
      else process.env.BACKEND_USER_INPUT_LOG = previousLog;
    }
  });
});
