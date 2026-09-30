import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PiRpcClient } from '../src/agent/pi-rpc/client';
import { assertPiPermission } from '../src/agent/pi-rpc/permission';
import { PiThread } from '../src/agent/pi-rpc/thread';
import type { AgentEvent } from '../src/agent/types';

const FIXTURE = join(process.cwd(), 'test', 'fixtures', 'pi-rpc-server.mjs');

async function withClient<T>(mode: string, fn: (client: PiRpcClient, cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-rpc-runtime-'));
  const client = new PiRpcClient({
    bin: process.execPath,
    cwd,
    // modeArgs exercises the executable/argument injection seam without
    // putting a test-only dependency in the production package.
    modeArgs: [FIXTURE],
    env: { PI_FIXTURE_MODE: mode },
    requestTimeoutMs: 2_000,
  });
  try {
    return await fn(client, cwd);
  } finally {
    await client.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function threadFor(client: PiRpcClient, cwd: string): Promise<PiThread> {
  const state = await client.request<Record<string, any>>('get_state');
  return new PiThread({
    client,
    cwd,
    sessionId: state.sessionId,
    model: 'fixture/fixture-model',
    effort: 'medium',
  });
}

describe('PiRpcClient runtime boundary', () => {
  it('treats native TUI display updates as one-way diagnostics rather than failed questions', async () => {
    await withClient('display-ui', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const events = await collect(thread.runStreamed({ text: 'display updates' }).events);
      expect(events.some((event) => event.type === 'error' || event.type === 'user_input_request')).toBe(false);
      expect(events.some((event) => event.type === 'done')).toBe(true);
    });
  });

  it('returns an explicit no-op result for the native short-session compact outcome', async () => {
    await withClient('compact-too-small', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      expect(await thread.compact()).toEqual({ compacted: false, usage: null });
      expect(thread.isAlive()).toBe(true);
    });
  });
  it('correlates responses and keeps U+2028/U+2029 inside a JSONL record', async () => {
    await withClient('unicode', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const events = await collect(thread.runStreamed({ text: 'unicode' }).events);
      const text = events.filter((event) => event.type === 'text').map((event) => event.text).join('');
      expect(text).toContain('\u2028');
      expect(text).toContain('\u2029');
      expect(events.find((event) => event.type === 'text_delta')).toMatchObject({ delta: '前半\u2028中间\u2029后半' });
      expect(events.some((event) => event.type === 'done')).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ type: 'context_usage', usedTokens: 42, contextWindow: 100_000 }));
    });
  });

  it('does not wait for agent_settled when pi reports handled', async () => {
    await withClient('normal', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const events = await collect(thread.runStreamed({ text: '/handled' }).events);
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(events.some((event) => event.type === 'error')).toBe(false);
    });
  });

  it('settles when the protocol delivers agent_settled before the prompt response', async () => {
    await withClient('early-settled', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const events = await collect(thread.runStreamed({ text: 'early' }).events);
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(events.some((event) => event.type === 'error' && !event.willRetry)).toBe(false);
    });
  });

  it('keeps a final failure visible and emits no false done', async () => {
    await withClient('error', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const events = await collect(thread.runStreamed({ text: 'final failure' }).events);
      expect(events.filter((event) => event.type === 'error' && !event.willRetry)).toHaveLength(1);
      expect(events.some((event) => event.type === 'done')).toBe(false);
    });
  });

  it('converges a malformed protocol stream into a visible terminal error', async () => {
    await withClient('exit', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const events = await collect(thread.runStreamed({ text: 'bad protocol' }).events);
      expect(events.some((event) => event.type === 'error' && !event.willRetry)).toBe(true);
      expect(thread.isAlive()).toBe(false);
    });
  });

  it('exposes unknown model/effort as a visible failed run', async () => {
    await withClient('normal', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const badModel = await collect(thread.runStreamed({ text: 'bad model' }, { model: 'fixture/missing' }).events);
      expect(badModel.at(-1)).toEqual(expect.objectContaining({ type: 'error', willRetry: false }));
      expect(badModel.some((event) => event.type === 'done')).toBe(false);

      const badEffort = await collect(thread.runStreamed({ text: 'bad effort' }, { effort: 'ultra' }).events);
      expect(badEffort.find((event) => event.type === 'error')).toEqual(expect.objectContaining({ willRetry: false }));
    });
  });

  it('rejects stale steer/abort IDs and aborts only the current run', async () => {
    await withClient('slow', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const run = thread.runStreamed({ text: 'long' });
      const draining = collect(run.events);
      await expect(thread.steer({ text: 'stale' }, 'old-run')).rejects.toThrow('run ID');
      await expect(thread.abort('old-run')).rejects.toThrow('run ID');
      await thread.abort(run.turnId()!);
      const events = await draining;
      expect(events.some((event) => event.type === 'error' && !event.willRetry)).toBe(false);
    });
  });

  it('kills a process when abort is acknowledged without agent_settled', async () => {
    await withClient('abort-stuck', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const run = thread.runStreamed({ text: 'stuck' });
      const draining = collect(run.events);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await thread.abort(run.turnId()!);
      const events = await draining;
      expect(thread.isAlive()).toBe(false);
      expect(events.some((event) => event.type === 'error' && !event.willRetry)).toBe(true);
    });
  }, 12_000);

  it('sends supported image payloads through the RPC boundary', async () => {
    await withClient('normal', async (client, cwd) => {
      const imagePath = join(cwd, 'fixture.png');
      await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const records: Array<Record<string, any>> = [];
      const unsubscribe = client.onRecord((record) => {
        if (record.type === 'fixture_images') records.push(record);
      });
      try {
        const thread = await threadFor(client, cwd);
        await collect(thread.runStreamed({ text: 'image', images: [imagePath] }).events);
      } finally {
        unsubscribe();
      }
      expect(records).toEqual([expect.objectContaining({ count: 1, firstType: 'image/png' })]);
      expect(records[0]?.firstDataLength).toBeGreaterThan(0);
    });
  });

  it('maps extension confirm UI and resumes after the bridge response', async () => {
    await withClient('ui', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      const seen: AgentEvent[] = [];
      for await (const event of thread.runStreamed({ text: 'ui' }).events) {
        seen.push(event);
        if (event.type === 'user_input_request') {
          await event.request.respond({ 'fixture-ui-1': { answers: ['是'] } });
        }
      }
      expect(seen.some((event) => event.type === 'user_input_request')).toBe(true);
      expect(seen.some((event) => event.type === 'done')).toBe(true);
    });
  });

  it('runs compact after a settled turn and preserves the usage shape', async () => {
    await withClient('normal', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      await collect(thread.runStreamed({ text: 'first' }).events);
      const result = await thread.compact();
      expect(result.compacted).toBe(true);
      expect(result.usage).toEqual(expect.objectContaining({ usedTokens: 8, contextWindow: 100_000 }));
    });
  });

  it('does not infer compact usage from tokensBefore when pi omits stats', async () => {
    await withClient('compact-no-usage', async (client, cwd) => {
      const thread = await threadFor(client, cwd);
      await collect(thread.runStreamed({ text: 'first' }).events);
      const result = await thread.compact();
      expect(result.compacted).toBe(true);
      expect(result.usage).toBeNull();
    });
  });
});

describe('pi permission gate', () => {
  it('fails closed for omitted/default and confined tiers', () => {
    expect(() => assertPiPermission(undefined)).toThrow('只支持');
    expect(() => assertPiPermission('qa')).toThrow('只支持');
    expect(() => assertPiPermission('write')).toThrow('只支持');
    expect(() => assertPiPermission('full')).not.toThrow();
  });
});
