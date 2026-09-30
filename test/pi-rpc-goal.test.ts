import { mkdtemp } from 'node:fs/promises';
import { trashTestDirectory } from './helpers/trash-directory';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PiRpcClient } from '../src/agent/pi-rpc/client';
import { decodePiGoalRecord } from '../src/agent/pi-rpc/goal-protocol';
import { PiThread } from '../src/agent/pi-rpc/thread';
import type { AgentEvent } from '../src/agent/types';

const FIXTURE = join(process.cwd(), 'test', 'fixtures', 'pi-goal-server.mjs');

async function withClient<T>(mode: string, fn: (client: PiRpcClient, cwd: string) => Promise<T>, oldStatus?: string): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-goal-rpc-'));
  const client = new PiRpcClient({
    bin: process.execPath,
    cwd,
    modeArgs: [FIXTURE],
    env: { PI_GOAL_FIXTURE_MODE: mode, ...(oldStatus ? { PI_GOAL_OLD_STATUS: oldStatus } : {}) },
    requestTimeoutMs: 2_000,
  });
  try {
    return await fn(client, cwd);
  } finally {
    await client.close();
    trashTestDirectory(cwd);
  }
}

async function threadFor(client: PiRpcClient, cwd: string): Promise<PiThread> {
  const state = await client.request<Record<string, any>>('get_state');
  return new PiThread({ client, cwd, sessionId: state.sessionId, model: 'fixture/fixture-model', effort: 'medium' });
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function notify(payload: unknown): Record<string, any> {
  return { type: 'extension_ui_request', method: 'notify', message: `BRIDGE_PI_GOAL_V1:${JSON.stringify(payload)}` };
}

describe('Pi Goal protocol', () => {
  it('decodes only the private notify channel and preserves structured state', () => {
    expect(decodePiGoalRecord({ type: 'extension_ui_request', method: 'notify', message: 'ordinary notice' })).toBeUndefined();
    expect(decodePiGoalRecord(notify({ version: 1, kind: 'state', runId: 'run-1', goalId: 'goal-1', objective: '写文件', status: 'usage_limited', tokensUsed: 13, timeUsedSeconds: 2, tokenBudget: null }))).toEqual(expect.objectContaining({ kind: 'state', status: 'usage_limited' }));
    expect(decodePiGoalRecord(notify({ version: 1, kind: 'reply', requestId: 'r1', ok: true, data: { goal: null } }))).toEqual(expect.objectContaining({ kind: 'reply', requestId: 'r1', ok: true }));
    expect(decodePiGoalRecord({ type: 'extension_ui_request', method: 'notify', message: 'BRIDGE_PI_GOAL_V1:{bad' })).toEqual(expect.objectContaining({ kind: 'error', error: expect.objectContaining({ code: 'invalid_json' }) }));
  });
});

describe('Pi Goal thread lifecycle', () => {
  it.each([['budget_limited', 'budgetLimited'], ['usage_limited', 'usageLimited'], ['blocked', 'blocked']])('preserves %s as an unsuccessful Goal terminal', async (mode, status) => {
    await withClient(mode, async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const events = await collect(thread.runGoal('must not report complete').events);
      const goals = events.filter((event) => event.type === 'goal_update');
      expect(goals.at(-1)).toMatchObject({ status, tokensUsed: 13 });
      expect(goals.some((event) => event.status === 'complete')).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
    });
  });
  it('rejects settled turn controls during the gap before auto continuation', async () => {
    await withClient('turn-gap', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const run = thread.runGoal('continue after gap');
      let checked = false;
      const events: AgentEvent[] = [];
      for await (const event of run.events) {
        events.push(event);
        if (!checked && event.type === 'done') {
          checked = true;
          await expect(thread.steer({ text: 'stale control' }, event.turnId)).rejects.toThrow(/过期/);
          await expect(thread.abort(event.turnId)).rejects.toThrow(/过期/);
        }
      }
      expect(checked).toBe(true);
      expect(events.filter((event) => event.type === 'turn_started')).toHaveLength(2);
      expect(events).toContainEqual(expect.objectContaining({ type: 'goal_update', status: 'complete' }));
    });
  });
  it.each(['clear', 'abort'])('cancels locally with %s before start ownership exists', async (action) => {
    await withClient('delayed-status', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const run = thread.runGoal('never sent to Pi');
      const draining = collect(run.events);
      if (action === 'clear') await thread.clearGoal();
      else await thread.abort(run.turnId()!);
      const events = await draining;
      await new Promise((r) => setTimeout(r, 50));
      expect(events.some((event) => event.type === 'error' || event.type === 'turn_started')).toBe(false);
      expect(thread.isAlive()).toBe(true);
      const wire = await client.request<{ commands: string[] }>('get_fixture_goal_commands');
      expect(wire.commands).toEqual(['status']);
      const next = await collect(thread.runStreamed({ text: '普通消息' }).events);
      expect(next.some((event) => event.type === 'done')).toBe(true);
    });
  });

  it('uses the clear reply when its terminal state arrives later', async () => {
    await withClient('waiting-late-clear', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const run = thread.runGoal('wait until cleared');
      let cleared = false;
      const events: AgentEvent[] = [];
      for await (const event of run.events) {
        events.push(event);
        if (!cleared && event.type === 'goal_update' && event.status === 'waiting') {
          cleared = true;
          await thread.clearGoal();
        }
      }
      expect(cleared).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ type: 'goal_update', status: 'paused' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
    });
  });
  it('keeps one stream across multiple turns and uses cumulative Goal counters', async () => {
    await withClient('multi-turn', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const events = await collect(thread.runGoal('连续完成两轮').events);
      const starts = events.filter((event) => event.type === 'turn_started');
      const dones = events.filter((event) => event.type === 'done');
      const updates = events.filter((event) => event.type === 'goal_update');
      expect(starts).toHaveLength(2);
      expect(dones).toHaveLength(2);
      expect(updates.map((event) => event.status)).toContain('active');
      expect(updates.at(-1)).toEqual(expect.objectContaining({ status: 'complete', tokensUsed: 39 }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'text', text: 'Goal fixture 完整结果' }));
      expect(events.some((event) => event.type === 'error' && !event.willRetry)).toBe(false);
      expect(dones[0]?.turnId).not.toBe(dones[1]?.turnId);
    });
  });

  it('waits for the current settled turn when terminal state arrives first', async () => {
    await withClient('terminal-first', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const events = await collect(thread.runGoal('末轮先报告完成').events);
      const complete = events.findIndex((event) => event.type === 'goal_update' && event.status === 'complete');
      const done = events.findIndex((event) => event.type === 'done');
      const text = events.findIndex((event) => event.type === 'text');
      expect(complete).toBeGreaterThanOrEqual(0);
      expect(text).toBeGreaterThan(-1);
      expect(done).toBeGreaterThan(text);
      expect(done).toBeGreaterThanOrEqual(complete);
    });
  });

  it('converges when the plugin reports complete without agent_start', async () => {
    await withClient('no-agent-start', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const run = thread.runGoal('直接完成');
      const events = await collect(run.events);
      expect(events).toContainEqual(expect.objectContaining({ type: 'goal_update', status: 'complete' }));
      expect(events).toContainEqual({ type: 'done', turnId: run.turnId() });
      expect(events.some((event) => event.type === 'error' && !event.willRetry)).toBe(false);
    });
  });

  it('treats waiting as active and clear stops without synthesizing complete', async () => {
    await withClient('waiting', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const run = thread.runGoal('等待输入');
      const iterator = run.events[Symbol.asyncIterator]();
      let waiting = false;
      while (!waiting) {
        const next = await iterator.next();
        if (next.done) break;
        waiting = next.value.type === 'goal_update' && next.value.status === 'waiting';
      }
      expect(waiting).toBe(true);
      await thread.clearGoal(run.turnId());
      const rest = await collect({ [Symbol.asyncIterator]: () => iterator });
      const statuses = rest.filter((event) => event.type === 'goal_update').map((event) => event.status);
      expect(statuses).toContain('paused');
      expect(statuses).not.toContain('complete');
    });
  });

  it('clears before aborting, rejects stale turn IDs, and leaves no active Goal', async () => {
    await withClient('slow', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const run = thread.runGoal('可以取消的目标');
      const draining = collect(run.events);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(thread.abort('old-turn')).rejects.toThrow(/run ID/);
      const turnId = run.turnId();
      expect(turnId).toBeTruthy();
      if (!turnId) throw new Error('Goal did not start a turn');
      await thread.abort(turnId);
      const events = await draining;
      const wire = await client.request<{ commands: string[] }>('get_fixture_goal_commands');
      expect(wire.commands).toContain('clear');
      expect(wire.commands).not.toContain('cancel');
      expect(events.some((event) => event.type === 'goal_update' && event.status === 'paused')).toBe(true);
      expect(events.some((event) => event.type === 'done')).toBe(true);
      expect(events.some((event) => event.type === 'goal_update' && event.status === 'complete')).toBe(false);
      const next = await collect(thread.runStreamed({ text: '取消后可继续' }).events);
      expect(next.some((event) => event.type === 'done')).toBe(true);
    }, undefined);
  });

  it('cleans a previous paused Goal before starting a new managed run', async () => {
    await withClient('multi-turn', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const events = await collect(thread.runGoal('清理旧目标').events);
      expect(events.some((event) => event.type === 'goal_update' && event.status === 'complete')).toBe(true);
    }, 'paused');
  });

  it('surfaces a start failure and does not turn handled into completion', async () => {
    await withClient('start-error', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const events = await collect(thread.runGoal('启动失败').events);
      expect(events.some((event) => event.type === 'error' && !event.willRetry)).toBe(true);
      expect(events.some((event) => event.type === 'done')).toBe(false);
    });
  });

  it('keeps plugin Goal errors visible and does not synthesize complete', async () => {
    await withClient('goal-error', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const events = await collect(thread.runGoal('目标失败').events);
      expect(events.some((event) => event.type === 'error' && !event.willRetry)).toBe(true);
      expect(events.some((event) => event.type === 'goal_update' && event.status === 'complete')).toBe(false);
    });
  });

  it('clears a goal when the consumer exits early', async () => {
    await withClient('slow', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const run = thread.runGoal('提前退出');
      const iterator = run.events[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      await iterator.return?.();
      expect(thread.isAlive()).toBe(true);
    });
  });
});
