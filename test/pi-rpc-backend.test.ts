import { describe, expect, it, vi } from 'vitest';
import { trashTestDirectory } from './helpers/trash-directory';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiRpcBackend, type PiBackendDeps } from '../src/agent/pi-rpc/backend';
import type { PiRpcClientLike, PiRpcClientOptions } from '../src/agent/pi-rpc/client';
import type { PiRecord } from '../src/agent/pi-rpc/event-map';

function fixture(options: { wrongHeader?: boolean; unsupportedGoal?: boolean } = {}) {
  const close = vi.fn(async () => undefined);
  const models = [
    { provider: 'first', id: 'plain', reasoning: false },
    { provider: 'configured', id: 'family/model', reasoning: true },
    { provider: 'other', id: 'mapped', reasoning: true, thinkingLevelMap: { minimal: null, xhigh: 'high', max: null } },
  ];
  let sessionId = '';
  let cwd = '';
  const listeners = new Set<(record: PiRecord) => void>();
  const request = vi.fn(async (type: string, fields?: PiRecord): Promise<PiRecord> => {
      if (type === 'prompt') {
        if (options.unsupportedGoal) throw new Error('Goal extension unavailable');
        const command = JSON.parse(Buffer.from(String(fields?.message).split(' ')[1]!, 'base64url').toString('utf8')) as PiRecord;
        const reply = { version: 1, kind: 'reply', requestId: command.requestId, ok: true, data: { goal: null, sessionHeader: { type: 'session', version: 3, id: options.wrongHeader ? 'wrong' : sessionId, cwd, timestamp: '2026-09-30T00:00:00Z' } } };
        for (const listener of listeners) listener({ type: 'extension_ui_request', method: 'notify', message: `BRIDGE_PI_GOAL_V1:${JSON.stringify(reply)}` });
        return { disposition: 'handled' };
      }
      const data = type === 'get_available_models' ? { models }
        : type === 'get_state' ? { sessionId, sessionFile: join(cwd, 'native', `${sessionId}.jsonl`), model: models[1], thinkingLevel: 'high' }
          : type === 'get_available_thinking_levels' ? { levels: ['off', 'low', 'high'] }
            : type === 'get_entries' ? { entries: [] } : {};
      return data;
  });
  const client: PiRpcClientLike = {
    request: async <T>(type: string, fields?: PiRecord): Promise<T> => await request(type, fields) as T,
    write: async () => undefined,
    onRecord: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onExit: () => () => undefined,
    isAlive: () => true,
    lastActivity: () => 0,
    close,
  };
  const createClient = vi.fn((opts: PiRpcClientOptions) => {
    cwd = opts.cwd;
    const args = [...opts.args ?? []];
    sessionId = args[args.indexOf('--session-id') + 1] ?? sessionId;
    return client;
  });
  const deps: PiBackendDeps = {
    resolveBin: () => '/mock/pi',
    probe: async () => ({ ok: true, version: '0.99.1' }),
    createClient,
    listSessions: async () => [],
    findSession: async () => undefined,
    readHistory: async () => ({ turns: [], totalTurns: 0 }),
  };
  return { backend: new PiRpcBackend(deps), close, createClient, request };
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

  it('loads the packaged Goal extension and saves Pi native session data before a first-turn cancellation', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-pi-goal-backend-')));
    try {
      const { backend, createClient, request } = fixture();
      const thread = await backend.startThread({ cwd, mode: 'full' });
      expect(backend.capabilities.goal).toBe(true);
      expect(createClient.mock.calls[0]?.[0].args).toContain('--extension');
      const sessionPath = join(cwd, 'native', `${thread.sessionId}.jsonl`);
      const header = JSON.parse(readFileSync(sessionPath, 'utf8').split('\n')[0]!);
      expect(header).toMatchObject({ type: 'session', id: thread.sessionId, cwd });
      expect(request).toHaveBeenCalledWith('switch_session', { sessionPath });
      await thread.close();
    } finally { trashTestDirectory(cwd); }
  });

  it('fails visibly and closes the process when the Goal handshake is unsupported or references another session', async () => {
    for (const options of [{ unsupportedGoal: true }, { wrongHeader: true }]) {
      const { backend, close } = fixture(options);
      await expect(backend.startThread({ cwd: '/project', mode: 'full' })).rejects.toThrow(/Goal/);
      expect(close).toHaveBeenCalledOnce();
    }
  });
});
