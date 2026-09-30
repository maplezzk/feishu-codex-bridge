import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKEND_ID, backendIds, createBackend } from '../src/agent';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { ClaudeAgentBackend } from '../src/agent/claude-agent/backend';
import { PiRpcBackend } from '../src/agent/pi-rpc/backend';

describe('agent backend registry', () => {
  it('defaults to the codex app-server backend (zero-arg call = legacy path)', () => {
    expect(DEFAULT_BACKEND_ID).toBe('codex-appserver');
    const be = createBackend();
    expect(be).toBeInstanceOf(CodexAppServerBackend);
    expect(be.id).toBe('codex-appserver');
  });

  it('resolves an explicit codex-appserver id to the same implementation', () => {
    expect(createBackend('codex-appserver')).toBeInstanceOf(CodexAppServerBackend);
  });

  it('codex backend declares no capabilities object (undefined ⇒ full feature set)', () => {
    expect(createBackend().capabilities).toBeUndefined();
  });

  it('throws a clear error for an unknown backend id, listing what is registered', () => {
    expect(() => createBackend('no-such-backend')).toThrow(/未知 agent 后端/);
    expect(() => createBackend('no-such-backend')).toThrow(/codex-appserver/);
  });

  it('resolves an explicit claude-agent id to the Claude Agent SDK backend', () => {
    const be = createBackend('claude-agent');
    expect(be).toBeInstanceOf(ClaudeAgentBackend);
    expect(be.id).toBe('claude-agent');
  });

  it('resolves an explicit pi-rpc id to the Pi RPC backend', () => {
    const be = createBackend('pi-rpc');
    expect(be).toBeInstanceOf(PiRpcBackend);
    expect(be.id).toBe('pi-rpc');
    expect(be.supportedModes).toEqual(['full']);
  });

  it('claude-agent declares an explicit capabilities object（steer off；goal/compact/resume on）', () => {
    const caps = createBackend('claude-agent').capabilities;
    expect(caps).toBeDefined();
    // goal:true（goal-like 自主轮）；compact:true（原生 /compact）；resume:true（~/.claude/projects 同源）；
    // steer:false（飞行中引导不支持 → 自动排队成下一轮）。
    expect(caps).toMatchObject({ goal: true, steer: false, compact: true, resume: true });
  });

  it('backendIds lists every registered backend（codex + claude-agent + pi-rpc）', () => {
    expect(backendIds()).toEqual(['codex-appserver', 'claude-agent', 'pi-rpc']);
  });
});
