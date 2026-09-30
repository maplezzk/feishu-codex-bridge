import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBackend } from '../src/agent';
import type { AgentEvent, AgentRun, AgentThread } from '../src/agent/types';
import { buildRunCard } from '../src/card/run-card';
import { finalMessageText, initialState, reduce } from '../src/card/run-state';
import { findPiSession } from '../src/agent/pi-rpc/history';

const LIVE = process.env.PI_GOAL_LIVE === '1';
const evidenceRoot = process.env.PI_GOAL_E2E_DIR ? resolve(process.env.PI_GOAL_E2E_DIR) : undefined;
function save(name: string, value: unknown): void {
  if (!evidenceRoot) return;
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function drain(run: AgentRun, onEvent?: (event: AgentEvent) => Promise<void>) {
  let state = initialState;
  const turns: Array<{ turnId: string; terminal: string | undefined; text: string; card: unknown }> = [];
  const types: string[] = [];
  const goals: Array<Extract<AgentEvent, { type: 'goal_update' }>> = [];
  let currentId: string | undefined;
  const finalize = (): void => {
    if (!currentId) return;
    turns.push({ turnId: currentId, terminal: state.terminal, text: finalMessageText(state), card: buildRunCard({ rs: state, showTools: true, goalControls: true, cardKey: 'local-goal-e2e' }) });
    currentId = undefined;
  };
  for await (const event of run.events) {
    types.push(event.type);
    if (event.type === 'goal_update') goals.push(event);
    if (event.type === 'turn_started') { finalize(); state = initialState; currentId = event.turnId; }
    if (event.type === 'user_input_request') {
      await event.request.reject('本地 E2E 不接受未预期的交互问题');
      throw new Error('Pi Goal 提出了未预期的交互问题');
    }
    state = reduce(state, event);
    await onEvent?.(event);
    if (event.type === 'done') finalize();
  }
  finalize();
  return { types, goals, turns, terminal: state.terminal, text: turns.map((turn) => turn.text).join('\n') };
}

describe.runIf(LIVE)('pi Goal real RPC E2E', () => {
  it('原生恢复把遗留 active 目标先暂停，重复打开仍保持暂停', { timeout: 30_000 }, async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-pi-goal-restore-')));
    const backend = createBackend('pi-rpc');
    let thread: AgentThread | undefined;
    try {
      thread = await backend.startThread({ cwd, mode: 'full' });
      const sessionId = thread.sessionId;
      const path = await findPiSession(cwd, sessionId);
      if (!path) throw new Error('Native initial session was not persisted');
      await thread.close();
      const entries = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const now = Date.now();
      // A native session fixture represents interruption before shutdown could
      // pause the Goal. It exercises real Pi hook ordering, without a model call.
      appendFileSync(path, `${JSON.stringify({ type: 'custom', id: randomUUID().slice(0, 8), parentId: entries.at(-1)?.id ?? null, timestamp: new Date(now).toISOString(), customType: 'bridge-goal-state', data: { goal: { id: randomUUID(), text: 'interrupted test goal', status: 'active', startedAt: now, updatedAt: now, iteration: 1, tokensUsed: 12, timeUsedSeconds: 2, baselineTokens: 0, activeStartedAt: now } } })}\n`);
      for (let reopen = 0; reopen < 2; reopen += 1) {
        thread = await backend.resumeThread({ cwd, sessionId, mode: 'full' });
        const latest = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((entry) => entry.customType === 'bridge-goal-state').at(-1);
        expect(latest.data.goal.status).toBe('paused');
        expect(thread.sessionId).toBe(sessionId);
        await thread.close();
      }
      save('goal-active-restore.json', { status: 'passed', sessionId, fixture: 'native interrupted active entry', restoredStatus: 'paused', reopenCount: 2, modelCalled: false });
    } finally {
      await thread?.close();
      execFileSync('trash', [cwd]);
    }
  });
  it('真实目标 → 文件写入 → 原生等待后自动续跑 → 完成工具 → 卡片与恢复', { timeout: 300_000 }, async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-pi-goal-e2e-')));
    const marker = `pi-goal-${randomUUID()}`;
    const backend = createBackend('pi-rpc');
    let thread: AgentThread | undefined;
    let resumed: AgentThread | undefined;
    try {
      thread = await backend.startThread({ cwd, mode: 'full' });
      const sessionId = thread.sessionId;
      const sessionPath = await findPiSession(cwd, sessionId);
      expect(sessionPath).toBeTruthy();
      const run = thread.runGoal(`这是临时验收目录，只操作 marker.txt。目标有两个必须按顺序完成的阶段：阶段一用 write 创建 marker.txt，内容只有 ${marker}，然后单独调用 bridge_goal_wait，reason 为“等待文件稳定验收窗口”，resume_after_ms 为10000。这个工具设置了明确的10秒安全唤醒期限。必须先等待一次，不要在第一次运行中执行阶段二，不要提前宣告完成。自动唤醒后进入阶段二，用 read 读取 marker.txt，确认内容准确，再调用 bridge_goal_complete 报告完整证据。最终回复完整标记。`);
      const result = await drain(run);
      const fileContent = readFileSync(join(cwd, 'marker.txt'), 'utf8').trim();
      save('goal-file.json', { sessionId, marker, fileContent, ...result });
      expect(fileContent).toBe(marker);
      expect(result.goals.some((goal) => goal.status === 'active')).toBe(true);
      expect(result.goals.at(-1)?.status).toBe('complete');
      expect(result.turns.length).toBeGreaterThanOrEqual(2);
      expect(result.types).toEqual(expect.arrayContaining(['tool_use', 'tool_result', 'done', 'goal_update']));
      expect(result.text).toContain(marker);
      expect(result.goals.at(-1)?.tokensUsed).toBeGreaterThan(0);
      expect(result.goals.at(-1)?.timeUsedSeconds).toBeGreaterThan(0);
      expect(result.turns.every((turn) => turn.terminal === 'done')).toBe(true);
      await thread.close();
      resumed = await backend.resumeThread({ cwd, sessionId, mode: 'full' });
      const reply = await drain(resumed.runStreamed({ text: '上一轮文件的唯一标记是什么？从已有会话回答，不调用工具，只回复标记。' }));
      const history = await backend.readHistory(cwd, sessionId, 10);
      expect(reply.text).toContain(marker);
      expect(history.totalTurns).toBeGreaterThanOrEqual(2);
      save('goal-resume.json', { status: 'passed', sessionId, nativeFileExists: Boolean(sessionPath), reply: reply.text, historyTurns: history.totalTurns });
      save('goal-file-result.json', { status: 'passed', sessionId, marker, fileContent, turns: result.turns.length, goalStatus: result.goals.at(-1), restored: true });
    } finally {
      await resumed?.close(); await thread?.close();
      execFileSync('trash', [cwd]);
    }
  });

  it('工具运行中温和结束 → 新目标强制取消 → 旧ID拒绝 → 普通对话', { timeout: 300_000 }, async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-pi-goal-controls-')));
    const marker = `soft-${randomUUID()}`;
    const backend = createBackend('pi-rpc');
    let thread: AgentThread | undefined;
    let resumed: AgentThread | undefined;
    try {
      thread = await backend.startThread({ cwd, mode: 'full' });
      const sessionId = thread.sessionId;
      let ended = false;
      const soft = await drain(thread.runGoal(`只用一次 bash 调用执行下面这个完整命令：sleep 2; printf '%s' '${marker}' > soft.txt。不要用 write 工具，不要把等待和写入拆开。命令结束后读回文件确认，再报告目标完成。只操作这个临时目录。`), async (event) => {
        if (!ended && event.type === 'tool_use' && `${event.title} ${event.detail ?? ''}`.includes('sleep 2')) {
          ended = true;
          await thread!.clearGoal();
        }
      });
      save('goal-soft-end.json', { ended, fileExists: existsSync(join(cwd, 'soft.txt')), ...soft });
      expect(ended).toBe(true);
      expect(readFileSync(join(cwd, 'soft.txt'), 'utf8')).toBe(marker);
      expect(soft.turns.at(-1)?.terminal).toBe('done');
      let aborted = false;
      const active = thread.runGoal("只用一次 bash 调用执行：sleep 10; printf 'should-not-finish' > aborted.txt。不要用 write 工具，不要拆成多个命令。等待结束后报告完成，只操作当前临时目录。");
      let stoppedId: string | undefined;
      const cancelled = await drain(active, async (event) => {
        if (!aborted && event.type === 'tool_use' && `${event.title} ${event.detail ?? ''}`.includes('sleep 10')) {
          aborted = true; stoppedId = active.turnId();
          await thread!.abort(stoppedId!);
        }
      });
      save('goal-abort.json', { aborted, fileExists: existsSync(join(cwd, 'aborted.txt')), ...cancelled });
      expect(aborted).toBe(true);
      expect(existsSync(join(cwd, 'aborted.txt'))).toBe(false);
      await expect(thread.abort(stoppedId!)).rejects.toThrow(/过期/);
      const next = await drain(thread.runStreamed({ text: '停止之前的目标，不调用工具，只回答：目标取消后可继续' }));
      expect(next.text).toContain('目标取消后可继续');
      await thread.close();
      resumed = await backend.resumeThread({ cwd, sessionId, mode: 'full' });
      const still = await drain(resumed.runStreamed({ text: '不要执行旧目标，只回答：恢复后没有自动续跑' }));
      expect(still.text).toContain('恢复后没有自动续跑');
      save('goal-controls-result.json', { status: 'passed', sessionId, ended, aborted, staleRejected: true, softFileContent: marker, abortedFileAbsent: true, next: next.text, resumed: still.text });
    } finally {
      await resumed?.close(); await thread?.close();
      execFileSync('trash', [cwd]);
    }
  });
});
