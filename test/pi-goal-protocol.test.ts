import { describe, expect, it } from 'vitest';
import type { PiRpcClientLike } from '../src/agent/pi-rpc/client';
import type { PiRecord } from '../src/agent/pi-rpc/event-map';
import { decodePiGoalRecord, sendPiGoalCommand } from '../src/agent/pi-rpc/goal-protocol';

function wire(behavior: (emit: (record: PiRecord) => void, exit: () => void) => Promise<PiRecord>) {
  const listeners = new Set<(record: PiRecord) => void>();
  const exits = new Set<(error?: Error) => void>();
  const client: PiRpcClientLike = {
    request: async <T>() => behavior((record) => { for (const fn of listeners) fn(record); }, () => { for (const fn of exits) fn(new Error('process exited')); }) as Promise<T>,
    write: async () => undefined,
    onRecord(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    onExit(fn) { exits.add(fn); return () => { exits.delete(fn); }; },
    isAlive: () => true, lastActivity: () => Date.now(), close: async () => undefined,
  };
  return { client, listeners, exits };
}
function notify(value: unknown): PiRecord {
  return { type: 'extension_ui_request', method: 'notify', message: `BRIDGE_PI_GOAL_V1:${JSON.stringify(value)}` };
}
const ack = { disposition: 'handled' };
const reply = (requestId = 'r1') => notify({ version: 1, kind: 'reply', requestId, ok: true, data: { goal: null } });

describe('Pi Goal wire request lifecycle', () => {
  it.each(['reply-first', 'ack-first'])('correlates replies with %s and removes listeners', async (order) => {
    const w = wire(async (emit) => {
      emit(reply('wrong-id'));
      if (order === 'reply-first') { emit(reply()); await new Promise((r) => setTimeout(r, 5)); }
      else setTimeout(() => emit(reply()), 5);
      return ack;
    });
    expect(await sendPiGoalCommand(w.client, { action: 'status', requestId: 'r1' }, 100)).toEqual({ goal: null });
    expect(w.listeners.size + w.exits.size).toBe(0);
  });
  it('times out when only a different request answers', async () => {
    const w = wire(async (emit) => { emit(reply('other')); return ack; });
    await expect(sendPiGoalCommand(w.client, { action: 'status', requestId: 'r1' }, 10)).rejects.toThrow(/超时/);
    expect(w.listeners.size + w.exits.size).toBe(0);
  });
  it('fails immediately on process exit', async () => {
    const w = wire(async (_emit, exit) => { exit(); return ack; });
    await expect(sendPiGoalCommand(w.client, { action: 'status', requestId: 'r1' }, 100)).rejects.toThrow('process exited');
    expect(w.listeners.size + w.exits.size).toBe(0);
  });
  it('does not accept a reply if its prompt acknowledgement fails', async () => {
    const w = wire(async (emit) => { emit(reply()); throw new Error('write failed'); });
    await expect(sendPiGoalCommand(w.client, { action: 'status', requestId: 'r1' }, 100)).rejects.toThrow('write failed');
  });
  it('rejects unknown protocol kinds without waiting for timeout', async () => {
    const w = wire(async (emit) => { emit(notify({ version: 1, kind: 'unsupported' })); return ack; });
    await expect(sendPiGoalCommand(w.client, { action: 'status', requestId: 'r1' }, 100)).rejects.toThrow(/kind 不支持/);
  });
  it.each([{ summary: {} }, { reason: [] }, { tokensUsed: -1 }, { tokenBudget: 0 }])('rejects malformed state %j', (invalid) => {
    const state = { version: 1, kind: 'state', runId: 'run', goalId: 'goal', objective: 'verify', status: 'complete', tokensUsed: 10, timeUsedSeconds: 2, tokenBudget: null, ...invalid };
    expect(decodePiGoalRecord(notify(state))).toMatchObject({ kind: 'error', error: { code: 'invalid_state' } });
  });
});
