import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { defaultModelProvider } from '../src/agent/codex-appserver/usage';
import { log } from '../src/core/logger';
import type { AgentEvent } from '../src/agent/types';

/**
 * LIVE 集成测试：用真 codex + 真 `$CODEX_HOME` 验证「改了 config 就原地切 provider」。
 * 只做 thread/resume（不跑 turn、不计费），故默认 SKIP；跑法：
 *   CODEX_PROVIDER_LIVE=1 CODEX_LIVE_SESSION=<会话 uuid> CODEX_LIVE_CWD=<该项目目录> \
 *     npx vitest run test/resume-provider.live.test.ts
 * 断言的是真机行为：会话里记着旧 provider（例如 openai），resume 后必须变成当前
 * config.toml 顶层的 model_provider（例如 cider）——直接读 backend 打出的
 * `session-provider` 日志，那个值来自 codex 的 thread/resume 回包。
 */
const LIVE = process.env.CODEX_PROVIDER_LIVE === '1';
/** 再真跑一小轮（要计费，默认关）：证明跨 provider 恢复的老会话不是只能 resume，还能跑完。 */
const LIVE_TURN = process.env.CODEX_PROVIDER_LIVE_TURN === '1';
const sessionId = process.env.CODEX_LIVE_SESSION ?? '';
const cwd = process.env.CODEX_LIVE_CWD ?? process.cwd();

describe.runIf(LIVE)('resume 原地切 provider LIVE', () => {
  it('resumed thread reports the provider from the live config.toml', { timeout: 60_000 }, async () => {
    expect(sessionId).toMatch(/[0-9a-f-]{36}/);
    const expected = await defaultModelProvider();
    expect(expected, 'config.toml 顶层没有 model_provider，无事可验').toBeTruthy();

    const info = vi.spyOn(log, 'info');
    const warn = vi.spyOn(log, 'warn');
    const backend = new CodexAppServerBackend();
    const thread = await backend.resumeThread({ sessionId, cwd });
    try {
      expect(thread.sessionId).toBe(sessionId);
      const applied = info.mock.calls.find(([, event]) => event === 'session-provider')?.[2];
      expect(applied, 'backend 没有报告 resume 后的 provider').toBeTruthy();
      expect(applied).toMatchObject({ sessionId, provider: expected });
      expect(warn.mock.calls.filter(([, event]) => event === 'provider-override-ignored')).toEqual([]);
    } finally {
      await thread.close().catch(() => undefined);
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it.runIf(LIVE_TURN)('a cross-provider resumed thread can still finish a real turn', { timeout: 120_000 }, async () => {
    const backend = new CodexAppServerBackend();
    const thread = await backend.resumeThread({ sessionId, cwd });
    const types: string[] = [];
    let text = '';
    try {
      for await (const ev of thread.runStreamed({ text: '只回复两个字：收到' }).events as AsyncIterable<AgentEvent>) {
        types.push(ev.type);
        if (ev.type === 'text_delta') text += ev.text;
      }
    } finally {
      await thread.close().catch(() => undefined);
    }
    expect(types).toContain('done');
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
