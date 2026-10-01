import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { PiThread } from '../src/agent/pi-rpc/thread';
import type { PiRpcClientLike } from '../src/agent/pi-rpc/client';
import type { PiRecord } from '../src/agent/pi-rpc/event-map';
import type { AgentEvent } from '../src/agent/types';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

function fixture(autoSettle = true) {
  let model = { provider: 'fixture', id: 'reason', reasoning: true };
  let level = 'high';
  const listeners = new Set<(record: PiRecord) => void>();
  const calls: PiRecord[] = [];
  const emit = (record: PiRecord) => { for (const listener of listeners) listener(record); };
  const client: PiRpcClientLike = {
    request: async <T>(type: string, fields: PiRecord = {}): Promise<T> => {
      calls.push({ type, ...fields });
      let data: unknown = {};
      if (type === 'set_model') {
        model = { provider: fields.provider, id: fields.modelId, reasoning: fields.modelId !== 'plain' };
        level = model.reasoning ? 'medium' : 'off'; // Pi's native model switch changes the level.
      } else if (type === 'get_state') data = { model, thinkingLevel: level };
      else if (type === 'get_available_thinking_levels') data = { levels: model.reasoning ? ['off', 'low', 'medium', 'high'] : ['off'] };
      else if (type === 'set_thinking_level') level = fields.level;
      else if (type === 'prompt') {
        emit({ type: 'turn_start' });
        if (autoSettle) queueMicrotask(() => emit({ type: 'agent_settled' }));
        data = { disposition: 'started' };
      }
      return data as T;
    },
    write: async () => undefined,
    onRecord: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onExit: () => () => undefined,
    isAlive: () => true,
    lastActivity: () => 0,
    close: async () => undefined,
  };
  const thread = new PiThread({ client, cwd: '/project', sessionId: 'test-session', model: 'fixture/reason', effort: 'high' });
  return { thread, emit, calls, client };
}

async function collect(events: AsyncIterable<AgentEvent>) {
  const values: AgentEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}

describe('pi turn configuration and asynchronous run scope', () => {
  it('still closes the process while cancelling a pending UI whose stdin write never resolves', async () => {
    const { thread, emit, client } = fixture(false);
    client.write = () => new Promise<void>(() => undefined);
    client.close = vi.fn(async () => undefined);
    const draining = collect(thread.runStreamed({ text: 'question' }).events);
    await new Promise((resolve) => setImmediate(resolve));
    emit({ type: 'extension_ui_request', id: 'blocked-ui', method: 'confirm', title: 'continue?' });
    const outcome = await Promise.race([
      thread.close().then(() => 'closed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
    ]);
    expect(outcome).toBe('closed');
    expect(client.close).toHaveBeenCalledOnce();
    await draining;
  });
  it('revalidates the same requested effort after a model switch clamps it', async () => {
    const { thread, calls } = fixture();
    const events = await collect(thread.runStreamed({ text: 'must not run' }, { model: 'fixture/plain', effort: 'high' }).events);
    expect(events.at(-1)).toMatchObject({ type: 'error', willRetry: false });
    expect(calls.some((call) => call.type === 'prompt')).toBe(false);
    await thread.close();
  });

  it('applies and reads back requested effort even when the old cache had the same value', async () => {
    const { thread, calls } = fixture();
    const events = await collect(thread.runStreamed({ text: 'run' }, { model: 'fixture/reason-2', effort: 'high' }).events);
    expect(calls).toContainEqual({ type: 'set_thinking_level', level: 'high' });
    expect(events.some((event) => event.type === 'done')).toBe(true);
    await thread.close();
  });

  it('rejects an old steer after image reading crosses into a new run, without sending it', async () => {
    const { thread, emit, calls } = fixture(false);
    const first = thread.runStreamed({ text: 'first' });
    const firstDrain = collect(first.events);
    await new Promise((resolve) => setImmediate(resolve));
    let finishImage!: (value: Buffer<ArrayBuffer>) => void;
    vi.mocked(readFile).mockImplementationOnce(() => new Promise<Buffer<ArrayBuffer>>((resolve) => { finishImage = resolve; }));
    const steering = thread.steer({ text: 'old steer', images: ['/project/image.png'] }, first.turnId()!);
    const rejection = expect(steering).rejects.toThrow(/过期|结束/);
    emit({ type: 'agent_settled' });
    await firstDrain;
    const second = thread.runStreamed({ text: 'second' });
    const secondDrain = collect(second.events);
    finishImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await rejection;
    expect(calls.some((call) => call.type === 'steer')).toBe(false);
    emit({ type: 'agent_settled' });
    await secondDrain;
    await thread.close();
  });
});
