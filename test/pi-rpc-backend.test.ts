import { describe, expect, it, vi } from 'vitest';
import { PiRpcBackend, type PiBackendDeps } from '../src/agent/pi-rpc/backend';
import type { PiRpcClientLike } from '../src/agent/pi-rpc/client';

function fixture() {
  const close = vi.fn(async () => undefined);
  const models = [
    { provider: 'first', id: 'plain', reasoning: false },
    { provider: 'configured', id: 'family/model', reasoning: true },
    { provider: 'other', id: 'mapped', reasoning: true, thinkingLevelMap: { minimal: null, xhigh: 'high', max: null } },
  ];
  const client: PiRpcClientLike = {
    request: async <T>(type: string): Promise<T> => {
      const data = type === 'get_available_models' ? { models }
        : type === 'get_state' ? { model: models[1], thinkingLevel: 'high' }
          : type === 'get_available_thinking_levels' ? { levels: ['off', 'low', 'high'] } : {};
      return data as T;
    },
    write: async () => undefined,
    onRecord: () => () => undefined,
    onExit: () => () => undefined,
    isAlive: () => true,
    lastActivity: () => 0,
    close,
  };
  const createClient = vi.fn(() => client);
  const deps: PiBackendDeps = {
    resolveBin: () => '/mock/pi',
    probe: async () => ({ ok: true, version: '0.99.1' }),
    createClient,
    listSessions: async () => [],
    findSession: async () => undefined,
    readHistory: async () => ({ turns: [], totalTurns: 0 }),
  };
  return { backend: new PiRpcBackend(deps), close, createClient };
}

describe('pi backend configuration boundary', () => {
  it('preserves provider/model ID, configured default and authoritative effort levels', async () => {
    const { backend, close } = fixture();
    const models = await backend.listModels();
    expect(models.filter((model) => model.isDefault)).toEqual([
      expect.objectContaining({ id: 'configured/family/model', supportedEfforts: ['none', 'low', 'high'], defaultEffort: 'high' }),
    ]);
    expect(models[0]).toMatchObject({ isDefault: false, supportedEfforts: ['none'] });
    expect(models[2]?.supportedEfforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects confined modes before opening any process', async () => {
    const { backend, createClient } = fixture();
    for (const mode of ['qa', 'write', undefined] as const) {
      await expect(backend.startThread({ cwd: '/project', mode })).rejects.toThrow(/full/);
    }
    expect(createClient).not.toHaveBeenCalled();
  });

  it('accepts UUIDv7 format but refuses a missing native session instead of starting an empty one', async () => {
    const { backend, createClient } = fixture();
    await expect(backend.resumeThread({ cwd: '/project', mode: 'full', sessionId: '019f0000-0000-7000-8000-000000000001' })).rejects.toThrow(/找不到 pi 会话/);
    expect(createClient).not.toHaveBeenCalled();
  });
});
