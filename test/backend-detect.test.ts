import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 智能默认 effectiveDefaultBackend 规则、detectAgents agent 分组、backendForProject
 * 显式优先/回退、ensureAnyAgent 放行。Codex 与 Pi 探测都 mock，不碰真机环境。
 */

// ── 受控的 codex 探测（detectAgents 据它推导默认）────────────────────────
const detectState = { codexBin: null as string | null, codexVersion: null as string | null };
const piState = { ok: false, version: null as string | null, hint: '未找到测试 pi' };

vi.mock('../src/agent/codex-appserver/locate', () => ({
  resolveCodexBin: vi.fn(() => detectState.codexBin),
  codexVersionAsync: vi.fn(async () => detectState.codexVersion),
}));

vi.mock('../src/agent/pi-rpc/backend', () => ({
  PiRpcBackend: class {
    async doctor() {
      return { ...piState };
    }
  },
}));

import { detectAgents, effectiveDefaultBackend, backendForProject } from '../src/agent/detect';
import { ensureAnyAgent } from '../src/bot/onboarding';

beforeEach(() => {
  detectState.codexBin = null;
  detectState.codexVersion = null;
  piState.ok = false;
  piState.version = null;
  piState.hint = '未找到测试 pi';
});
afterEach(() => vi.clearAllMocks());

describe('智能默认 effectiveDefaultBackend（detect 推导）', () => {
  it('有 codex → codex-appserver', async () => {
    detectState.codexBin = '/usr/bin/codex';
    detectState.codexVersion = 'codex 9.9';
    expect(await effectiveDefaultBackend({ force: true })).toBe('codex-appserver');
  });

  it('都无 → 回退 codex-appserver 占位（doctor 会报需安装）', async () => {
    detectState.codexBin = null;
    detectState.codexVersion = null;
    expect(await effectiveDefaultBackend({ force: true })).toBe('codex-appserver');
  });
});

describe('backendForProject：显式优先（须为已注册后端），否则有效默认', () => {
  it('项目显式选了已注册后端 codex-appserver → 用它（不探测）', async () => {
    detectState.codexBin = null; // 即便探不到 codex，显式值也优先
    expect(await backendForProject({ backend: 'codex-appserver' })).toBe('codex-appserver');
  });

  it('项目指向已移除后端（旧 claude-sdk 配置）→ 回退有效默认 codex-appserver（避免 createBackend 抛未知后端）', async () => {
    detectState.codexBin = '/usr/bin/codex';
    detectState.codexVersion = 'codex 9.9';
    expect(await backendForProject({ backend: 'claude-sdk' }, { force: true })).toBe('codex-appserver');
  });

  it('项目没选 → 落有效默认', async () => {
    detectState.codexBin = '/usr/bin/codex';
    detectState.codexVersion = 'codex 9.9';
    expect(await backendForProject({}, { force: true })).toBe('codex-appserver');
  });
});

describe('detectAgents：按 agent 维度分组（codex + pi）', () => {
  it('codex 装了 → codex agent installed，其 codex-appserver 后端 available', async () => {
    detectState.codexBin = '/usr/bin/codex';
    detectState.codexVersion = 'codex 9.9';
    const agents = await detectAgents();
    expect(agents).toHaveLength(2);
    const codex = agents.find((a) => a.id === 'codex')!;
    expect(codex.installed).toBe(true);
    expect(codex.backends).toHaveLength(1);
    expect(codex.backends[0]!.backendId).toBe('codex-appserver');
    expect(codex.backends[0]!.available).toBe(true);
    // external-cli 基线，绝不出「一键下载」信号
    expect(codex.backends[0]!.installable).toBe(false);
  });

  it('codex 未装 → Codex not installed，Pi 探测失败也可见（仍不改变默认）', async () => {
    detectState.codexBin = null;
    detectState.codexVersion = null;
    const agents = await detectAgents();
    expect(agents).toHaveLength(2);
    const codex = agents.find((a) => a.id === 'codex')!;
    expect(codex.installed).toBe(false);
    expect(codex.backends[0]!.available).toBe(false);
    expect(codex.backends[0]!.installable).toBe(false);
    const pi = agents.find((a) => a.id === 'pi')!;
    expect(pi.installed).toBe(false);
    expect(pi.backends[0]!.backendId).toBe('pi-rpc');
    expect(pi.backends[0]!.available).toBe(false);
    expect(pi.backends[0]!.reason).toBe('未找到测试 pi');
  });

  it('Pi 装了 → pi-rpc 可用且只支持 full，不成为智能默认', async () => {
    piState.ok = true;
    piState.version = 'pi 0.99.1';
    const agents = await detectAgents();
    const pi = agents.find((a) => a.id === 'pi')!;
    expect(pi.installed).toBe(true);
    expect(pi.version).toBe('pi 0.99.1');
    expect(pi.backends[0]).toMatchObject({
      backendId: 'pi-rpc',
      available: true,
      supportedModes: ['full'],
      installable: false,
    });
    expect(await effectiveDefaultBackend({ force: true })).toBe('codex-appserver');
  });
});

describe('ensureAnyAgent：agent 可用即放行；都无也不阻塞', () => {
  it('codex 可用 → 放行 true', async () => {
    detectState.codexBin = '/usr/bin/codex';
    detectState.codexVersion = 'codex 9.9';
    expect(await ensureAnyAgent()).toBe(true);
  });

  it('都无 → 仍放行 true（告警但不阻塞，Web 引导下载）', async () => {
    detectState.codexBin = null;
    detectState.codexVersion = null;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await ensureAnyAgent()).toBe(true);
      expect(errSpy).toHaveBeenCalled(); // 打了告警
    } finally {
      errSpy.mockRestore();
    }
  });
});
