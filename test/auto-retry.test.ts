import { describe, expect, it } from 'vitest';
import {
  AUTO_RETRY_BASE_MS,
  AUTO_RETRY_MAX_MS,
  autoRetryDelayMs,
  decideAutoRetry,
} from '../src/bot/auto-retry';
import { buildRetryCard, RC } from '../src/card/run-card';
import { initialState, markIdleTimeout, markRetrying } from '../src/card/run-state';

describe('autoRetryDelayMs', () => {
  it('starts at 20s, doubles, and caps at one minute', () => {
    expect(autoRetryDelayMs(1)).toBe(AUTO_RETRY_BASE_MS);
    expect(autoRetryDelayMs(2)).toBe(40_000);
    expect(autoRetryDelayMs(3)).toBe(AUTO_RETRY_MAX_MS);
    expect(autoRetryDelayMs(100)).toBe(AUTO_RETRY_MAX_MS);
  });

  it('never returns something shorter than the base or longer than the cap', () => {
    for (let n = 1; n <= 120; n++) {
      const d = autoRetryDelayMs(n);
      expect(d).toBeGreaterThanOrEqual(AUTO_RETRY_BASE_MS);
      expect(d).toBeLessThanOrEqual(AUTO_RETRY_MAX_MS);
    }
  });
});

describe('decideAutoRetry', () => {
  const base = { timedOut: true, procDead: false, interrupted: false, attempt: 1, canResume: true };

  it('retries a watchdog timeout with the 20s first delay', () => {
    expect(decideAutoRetry(base)).toEqual({
      retry: true,
      attempt: 1,
      delayMs: AUTO_RETRY_BASE_MS,
      maxAttempts: 100,
    });
  });

  it('does not retry after the watchdog was disabled', () => {
    expect(decideAutoRetry({ ...base, enabled: false })).toEqual({ retry: false, reason: 'watchdog-disabled' });
  });

  it('retries a dead child process too', () => {
    const d = decideAutoRetry({ ...base, timedOut: false, procDead: true });
    expect(d.retry).toBe(true);
  });

  it('never retries a user interrupt (⏹), even during a timeout', () => {
    expect(decideAutoRetry({ ...base, interrupted: true })).toEqual({
      retry: false,
      reason: 'user-interrupt',
    });
  });

  it('never retries a poisoned collaboration registry', () => {
    expect(decideAutoRetry({ ...base, protocolFault: 'thread 已失步' })).toEqual({
      retry: false,
      reason: 'protocol-fault',
    });
  });

  it('does not retry a clean terminal (nothing was cut off)', () => {
    expect(decideAutoRetry({ ...base, timedOut: false, procDead: false })).toEqual({
      retry: false,
      reason: 'clean-terminal',
    });
  });

  it('gives up without a resumable session', () => {
    expect(decideAutoRetry({ ...base, canResume: false })).toEqual({
      retry: false,
      reason: 'no-session',
    });
  });

  it('stops at the attempt cap', () => {
    const last = decideAutoRetry({ ...base, attempt: 100 });
    expect(last).toEqual({ retry: true, attempt: 100, delayMs: AUTO_RETRY_MAX_MS, maxAttempts: 100 });
    expect(decideAutoRetry({ ...base, attempt: 101 })).toEqual({ retry: false, reason: 'exhausted' });
  });
});

describe('markRetrying', () => {
  it('keeps the turn alive (running) and surfaces the retry state', () => {
    const timedOut = markIdleTimeout(initialState, 120);
    expect(timedOut.terminal).toBe('idle_timeout');

    const retrying = markRetrying(timedOut, { attempt: 1, maxAttempts: 100, delaySeconds: 20 });
    expect(retrying.terminal).toBe('running');
    expect(retrying.footer).toBe('retrying');
    expect(retrying.retry).toEqual({ attempt: 1, maxAttempts: 100, delaySeconds: 20 });
    // 上一轮的终态字段必须清掉，否则卡上会同时出现「已超时」和「重试中」。
    expect(retrying.errorMsg).toBeUndefined();
    expect(retrying.idleTimeoutSeconds).toBeUndefined();
  });
});

describe('buildRetryCard', () => {
  const json = (c: object) => JSON.stringify(c);
  const opts = {
    attempt: 3,
    maxAttempts: 100,
    delaySeconds: 60,
    idleSeconds: 120,
    reason: 'watchdog-timeout' as const,
  };

  it('shows the attempt, the wait, and a working stop control while waiting', () => {
    const built = buildRetryCard({ ...opts, phase: 'waiting' });
    const s = json(built);
    expect(s).toContain('60 秒后');
    expect(s).toContain('3/100');
    expect(s).toContain('120 秒');
    expect(s).toContain(RC.stop);
  });

  it('drops the stop control once the retry has been dispatched', () => {
    const started = json(buildRetryCard({ ...opts, phase: 'started' }));
    expect(started).toContain('已发起');
    expect(started).not.toContain(RC.stop);
  });

  it('says so when the user stopped the retry sequence', () => {
    const stopped = json(buildRetryCard({ ...opts, phase: 'stopped' }));
    expect(stopped).toContain('停止重试');
    expect(stopped).not.toContain(RC.stop);
  });

  it('explains a dead child process instead of a silent stream', () => {
    const built = json(buildRetryCard({ ...opts, phase: 'waiting', reason: 'proc-dead' }));
    expect(built).toContain('进程意外退出');
  });
});
