import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { piGoalExtensionPath } from '../src/agent/pi-rpc/goal-assets';

type FakeHandler = (event: unknown, ctx: FakeContext) => unknown;

interface FakeContext {
  mode: 'rpc';
  cwd: string;
  sessionManager: {
    getBranch: () => Array<Record<string, unknown>>;
    getHeader: () => Record<string, unknown>;
  };
  ui: {
    notify: (message: string, level?: string) => void;
    setStatus: (key: string, value: unknown) => void;
  };
  abort: () => void;
}

interface FakePi {
  handlers: Map<string, FakeHandler[]>;
  commands: Map<string, { handler: (args: string, ctx: FakeContext) => Promise<void> }>;
  entries: Array<Record<string, unknown>>;
  notifications: Array<{ message: string; level?: string }>;
  abortCount: number;
  listenerCount: (channel: string) => number;
  on: (event: string, handler: FakeHandler) => () => void;
  registerCommand: (name: string, command: { handler: (args: string, ctx: FakeContext) => Promise<void> }) => void;
  appendEntry: (customType: string, data: unknown) => void;
  events: {
    on: (channel: string, handler: (data: unknown) => void) => () => void;
    emit: (channel: string, data: unknown) => void;
  };
  fire: (event: string, ctx: FakeContext) => Promise<void>;
}

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const vendorRoot = resolve(repositoryRoot, 'vendor/pi-goal');

function encodeCommand(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function protocolMessages(pi: FakePi): Array<Record<string, unknown>> {
  return pi.notifications
    .filter(({ message }) => message.startsWith('BRIDGE_PI_GOAL_V1:'))
    .map(({ message }) => JSON.parse(message.slice('BRIDGE_PI_GOAL_V1:'.length)) as Record<string, unknown>);
}

function context(entries: Array<Record<string, unknown>> = []): FakeContext {
  return {
    mode: 'rpc',
    cwd: '/tmp/pi-goal-extension-test',
    sessionManager: {
      getBranch: () => entries,
      getHeader: () => ({ type: 'session', id: 'native-test-session' }),
    },
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
    },
    abort: () => undefined,
  };
}

function fakePi(): FakePi {
  const handlers = new Map<string, FakeHandler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: FakeContext) => Promise<void> }>();
  const entries: Array<Record<string, unknown>> = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  let abortCount = 0;
  const bus = new Map<string, Array<(data: unknown) => void>>();
  const pi: FakePi = {
    handlers,
    commands,
    entries,
    notifications,
    abortCount,
    listenerCount: (channel) => (bus.get(channel) ?? []).length,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event) ?? [];
        handlers.set(event, current.filter((candidate) => candidate !== handler));
      };
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    appendEntry(customType, data) {
      entries.push({ type: 'custom', customType, data });
    },
    events: {
      on(channel, handler) {
        const list = bus.get(channel) ?? [];
        list.push(handler);
        bus.set(channel, list);
        return () => bus.set(channel, (bus.get(channel) ?? []).filter((candidate) => candidate !== handler));
      },
      emit(channel, data) {
        for (const handler of [...(bus.get(channel) ?? [])]) handler(data);
      },
    },
    async fire(event, ctx) {
      for (const handler of [...(handlers.get(event) ?? [])]) await handler({ type: event }, ctx);
    },
  };
  Object.defineProperty(pi, 'abortCount', {
    get: () => abortCount,
    set: (value: number) => {
      abortCount = value;
    },
  });
  return pi;
}

// The bridge wrapper is tested with an upstream-shaped runtime seam. The seam
// still drives the real bridge command, ownership, event, and restore logic;
// only the external Pi Goal implementation is isolated by this mock.
vi.mock('../vendor/pi-goal/upstream/index.ts', () => ({
  default: (pi: FakePi) => {
    let goalCounter = 0;
    let managedRun: { runId: string; goalId: string } | undefined;
    const runtime: Record<string, unknown> = {
      activeGoal: undefined,
      cancelContinuationWork: () => undefined,
      clearGoalRecovery: () => undefined,
      clearGoalWaitTimer: () => undefined,
      clearBudgetWrapUp: () => undefined,
      persistGoal: (goal: Record<string, unknown>) => {
        pi.appendEntry('bridge-goal-state', { goal });
      },
      clearActiveGoal: (_ctx: FakeContext) => {
        const active = runtime.activeGoal as Record<string, unknown> | undefined;
        runtime.activeGoal = undefined;
        if (active && managedRun) {
          pi.events.emit(`bridge-pi-goal:event:${managedRun.runId}`, {
            type: 'state',
            runId: managedRun.runId,
            goalId: active.id,
            status: 'cleared',
          });
        }
      },
    };
    pi.events.on('bridge-pi-goal:start', (payload) => {
      const request = payload as { runId: string; objective: string; tokenBudget?: number };
      if (request.objective === '__stall__') return;
      if (request.objective === '__reject__') {
        pi.events.emit(`bridge-pi-goal:event:${request.runId}`, { type: 'error', error: { code: 'ACTIVATION_FAILED', message: 'fixture activation failed' } });
        return;
      }
      if (runtime.activeGoal) {
        pi.events.emit(`bridge-pi-goal:event:${request.runId}`, {
          type: 'error',
          runId: request.runId,
          error: { code: 'GOAL_ALREADY_EXISTS', message: 'A Goal already exists.' },
        });
        return;
      }
      const goalId = `goal-${++goalCounter}`;
      managedRun = { runId: request.runId, goalId };
      runtime.activeGoal = {
        id: goalId,
        text: request.objective,
        status: 'active',
        tokensUsed: 0,
        timeUsedSeconds: 0,
        tokenBudget: request.tokenBudget,
        activeStartedAt: Date.now(),
      };
      pi.events.emit(`bridge-pi-goal:event:${request.runId}`, {
        type: 'state',
        runId: request.runId,
        goalId,
        status: 'active',
      });
    });
    pi.events.on('bridge-pi-goal:cancel', (payload) => {
      const request = payload as { runId: string };
      if (!managedRun || managedRun.runId !== request.runId || !runtime.activeGoal) {
        pi.events.emit(`bridge-pi-goal:event:${request.runId}`, {
          type: 'error',
          runId: request.runId,
          error: { code: 'RUN_NOT_FOUND', message: 'No active managed run matches runId.' },
        });
        return;
      }
      runtime.activeGoal = { ...(runtime.activeGoal as Record<string, unknown>), status: 'paused', activeStartedAt: undefined };
      pi.events.emit(`bridge-pi-goal:event:${request.runId}`, {
        type: 'state',
        runId: request.runId,
        goalId: managedRun.goalId,
        status: 'paused',
      });
    });
    return { runtime, commands: {}, runController: {} };
  },
}));

async function loadBridgeExtension() {
  // The vendored extension is JavaScript loaded directly by Pi, outside the TS build.
  // @ts-expect-error upstream JavaScript extension has no declaration file
  return (await import('../vendor/pi-goal/bridge-extension.mjs')).default as (pi: FakePi) => unknown;
}

async function invoke(pi: FakePi, request: Record<string, unknown>, ctx: FakeContext) {
  const command = pi.commands.get('bridge-goal');
  if (!command) throw new Error('bridge-goal command was not registered');
  await command.handler(encodeCommand(request), ctx);
}

describe('vendored pi-goal bridge extension', () => {
  it.each(['__reject__', '__stall__'])('disposes listeners after failed activation %s', async (objective) => {
    const pi = fakePi();
    const ctx = context();
    ctx.ui.notify = (message, level) => pi.notifications.push({ message, level });
    (await loadBridgeExtension())(pi);
    await pi.fire('session_start', ctx);
    if (objective === '__stall__') vi.useFakeTimers();
    try {
      const starting = invoke(pi, { requestId: 'failed', action: 'start', runId: 'failed-run', objective }, ctx);
      if (objective === '__stall__') await vi.advanceTimersByTimeAsync(20_001);
      await starting;
      expect(protocolMessages(pi).find((message) => message.requestId === 'failed')).toMatchObject({ ok: false });
      expect(pi.listenerCount('bridge-pi-goal:event:failed-run')).toBe(0);
      await invoke(pi, { requestId: 'next', action: 'start', runId: 'next-run', objective: 'next goal' }, ctx);
      expect(protocolMessages(pi).find((message) => message.requestId === 'next')).toMatchObject({ ok: true });
      await invoke(pi, { requestId: 'stale', action: 'cancel', runId: 'failed-run' }, ctx);
      expect(protocolMessages(pi).find((message) => message.requestId === 'stale')).toMatchObject({ ok: false, error: { code: 'RUN_NOT_FOUND' } });
      expect(pi.listenerCount('bridge-pi-goal:event:failed-run')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('resolves the checkout asset and ships upstream provenance', () => {
    expect(piGoalExtensionPath()).toBe(resolve(vendorRoot, 'bridge-extension.mjs'));
    expect(readFileSync(resolve(vendorRoot, 'LICENSE'), 'utf8')).toContain('MIT License');
    expect(readFileSync(resolve(vendorRoot, 'UPSTREAM.json'), 'utf8')).toContain('"version": "0.54.8"');
    expect(readFileSync(resolve(vendorRoot, 'settings.json'), 'utf8')).toContain('"enabled": true');
  });

  it('starts and reports a managed Goal, rejects a wrong runId, and soft-clears without aborting', async () => {
    const pi = fakePi();
    const ctx = context();
    ctx.ui.notify = (message, level) => pi.notifications.push({ message, level });
    ctx.abort = () => {
      pi.abortCount += 1;
    };
    const bridge = await loadBridgeExtension();
    bridge(pi);
    await pi.fire('session_start', ctx);

    await invoke(pi, { requestId: 'start-1', action: 'start', runId: 'run-1', objective: 'write the marker' }, ctx);
    const started = protocolMessages(pi).find((message) => message.kind === 'reply' && message.requestId === 'start-1');
    expect(started).toMatchObject({ version: 1, kind: 'reply', requestId: 'start-1', ok: true });
    expect((started?.data as Record<string, unknown>).goal).toMatchObject({ goalId: 'goal-1', objective: 'write the marker', status: 'active' });

    await invoke(pi, { requestId: 'status-1', action: 'status' }, ctx);
    expect(protocolMessages(pi).find((message) => message.requestId === 'status-1')).toMatchObject({
      kind: 'reply',
      ok: true,
      data: {
        goal: { goalId: 'goal-1', status: 'active' },
        sessionHeader: { id: 'native-test-session' },
      },
    });

    await invoke(pi, { requestId: 'wrong-clear', action: 'clear', runId: 'wrong-run' }, ctx);
    expect(protocolMessages(pi).find((message) => message.requestId === 'wrong-clear')).toMatchObject({
      kind: 'reply',
      ok: false,
      error: { code: 'RUN_NOT_FOUND' },
    });

    await invoke(pi, { requestId: 'clear-1', action: 'clear', runId: 'run-1' }, ctx);
    expect(protocolMessages(pi).find((message) => message.requestId === 'clear-1')).toMatchObject({
      kind: 'reply',
      ok: true,
      data: { goal: { goalId: 'goal-1', status: 'cleared' } },
    });
    expect(pi.abortCount).toBe(0);
  });

  it('does not let an old managed run clear a newer Goal and cancels by exact runId', async () => {
    const pi = fakePi();
    const ctx = context();
    ctx.ui.notify = (message, level) => pi.notifications.push({ message, level });
    const bridge = await loadBridgeExtension();
    bridge(pi);
    await pi.fire('session_start', ctx);
    await invoke(pi, { requestId: 'start-1', action: 'start', runId: 'run-1', objective: 'first' }, ctx);
    await invoke(pi, { requestId: 'clear-1', action: 'clear', runId: 'run-1' }, ctx);
    await invoke(pi, { requestId: 'start-2', action: 'start', runId: 'run-2', objective: 'second' }, ctx);

    await invoke(pi, { requestId: 'old-clear', action: 'clear', runId: 'run-1' }, ctx);
    expect(protocolMessages(pi).find((message) => message.requestId === 'old-clear')).toMatchObject({
      kind: 'reply',
      ok: false,
      error: { code: 'RUN_SUPERSEDED' },
    });
    expect(protocolMessages(pi).filter((message) => message.kind === 'state').at(-1)).toMatchObject({ runId: 'run-2', status: 'active' });

    await invoke(pi, { requestId: 'cancel-2', action: 'cancel', runId: 'run-2' }, ctx);
    expect(protocolMessages(pi).find((message) => message.requestId === 'cancel-2')).toMatchObject({
      kind: 'reply',
      ok: true,
      data: { goal: { goalId: 'goal-2', status: 'paused' } },
    });
    await invoke(pi, { requestId: 'clear-stopped', action: 'clear' }, ctx);
    expect(protocolMessages(pi).find((message) => message.requestId === 'clear-stopped')).toMatchObject({ ok: true });
    await invoke(pi, { requestId: 'start-3', action: 'start', runId: 'run-3', objective: 'third' }, ctx);
    expect(protocolMessages(pi).find((message) => message.requestId === 'start-3')).toMatchObject({ ok: true });
  });

  it('pauses only the bridge namespace active entry during restore', async () => {
    const userGoal = { id: 'user-goal', text: 'leave me alone', status: 'active' };
    const bridgeGoal = { id: 'bridge-goal', text: 'resume later', status: 'active', tokensUsed: 2, timeUsedSeconds: 1 };
    const entries = [
      { type: 'custom', customType: 'goal-state', data: { goal: userGoal } },
      { type: 'custom', customType: 'bridge-goal-state', data: { goal: bridgeGoal } },
    ];
    const pi = fakePi();
    const ctx = context(entries);
    ctx.ui.notify = (message, level) => pi.notifications.push({ message, level });
    const bridge = await loadBridgeExtension();
    bridge(pi);
    await pi.fire('session_start', ctx);

    expect(entries[0]).toMatchObject({ customType: 'goal-state', data: { goal: { id: 'user-goal', status: 'active' } } });
    expect(pi.entries).toHaveLength(1);
    expect(pi.entries[0]).toMatchObject({
      customType: 'bridge-goal-state',
      data: { goal: { id: 'bridge-goal', status: 'paused', text: 'resume later' } },
    });
  });

  it('keeps terminal usage captured before upstream clears the runtime', async () => {
    const pi = fakePi();
    const ctx = context();
    ctx.ui.notify = (message, level) => pi.notifications.push({ message, level });
    const bridge = await loadBridgeExtension();
    bridge(pi);
    await pi.fire('session_start', ctx);
    await invoke(pi, { requestId: 'start', action: 'start', runId: 'run-snapshot', objective: 'verify marker' }, ctx);
    pi.events.emit('bridge-pi-goal:event:run-snapshot', {
      type: 'state', runId: 'run-snapshot', goalId: 'goal-1', status: 'complete', summary: 'marker verified',
      goal: { id: 'goal-1', text: 'verify marker', status: 'complete', tokensUsed: 321, timeUsedSeconds: 8, tokenBudget: 1000 },
    });
    expect(protocolMessages(pi).filter((message) => message.kind === 'state').at(-1)).toMatchObject({
      status: 'complete', tokensUsed: 321, timeUsedSeconds: 8, tokenBudget: 1000, summary: 'marker verified',
    });
  });
});
