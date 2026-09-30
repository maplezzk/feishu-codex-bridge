import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBackend } from '../src/agent';
import type { AgentEvent, AgentThread } from '../src/agent/types';
import { buildRunCard } from '../src/card/run-card';
import { finalMessageText, initialState, reduce } from '../src/card/run-state';

// Opt in explicitly: uses the installed pi and its existing model provider.
const LIVE = process.env.PI_LIVE === '1';
const evidenceRoot = process.env.PI_E2E_DIR ? resolve(process.env.PI_E2E_DIR) : undefined;

function save(name: string, value: unknown): void {
  if (!evidenceRoot) return;
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function drain(events: AsyncIterable<AgentEvent>) {
  let state = initialState;
  const types: string[] = [];
  for await (const event of events) {
    types.push(event.type);
    if (event.type === 'user_input_request') {
      await event.request.reject('本地 E2E 不接受未预期的交互问题');
      throw new Error('pi 扩展提出未预期的交互问题');
    }
    state = reduce(state, event);
  }
  return { state, types, text: finalMessageText(state) };
}

describe.runIf(LIVE)('pi RPC backend live E2E', () => {
  it('真实文件任务 → 卡片终态 → 关闭恢复 → 原生历史', { timeout: 240_000 }, async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-pi-e2e-')));
    const marker = `pi-e2e-${randomUUID()}`;
    const backend = createBackend('pi-rpc');
    let thread: AgentThread | undefined;
    let resumed: AgentThread | undefined;
    try {
      thread = await backend.startThread({ cwd, mode: 'full' });
      const sessionId = thread.sessionId;
      const first = await drain(thread.runStreamed({
        text: `这是临时验证目录。请创建 marker.txt，内容只有 ${marker}，然后用 read 工具读回该文件，最终回复读回的完整内容。只操作这个文件。`,
      }).events);
      const fileContent = readFileSync(join(cwd, 'marker.txt'), 'utf8').trim();
      const card = buildRunCard({ rs: first.state, showTools: true });
      save('file-and-card.json', { sessionId, marker, fileContent, types: first.types, terminal: first.state.terminal, text: first.text, card });
      expect(fileContent).toBe(marker);
      expect(first.state.terminal).toBe('done');
      expect(first.types).toEqual(expect.arrayContaining(['text_delta', 'tool_use', 'tool_result', 'done']));
      expect(first.types).toContain('context_usage');
      expect(first.state.usage?.window).toBeGreaterThan(0);
      expect(first.state.usage?.used).toBeGreaterThan(0);
      expect(first.text).toContain(marker);
      const tools = first.state.blocks.filter((block) => block.kind === 'tool');
      expect(tools.length).toBeGreaterThanOrEqual(2);
      // A tool may fail and be retried by the model (e.g. read before write).
      // Preserve that failure while requiring every call to have settled.
      expect(tools.every((block) => block.kind === 'tool' && block.tool.status !== 'running')).toBe(true);
      expect(JSON.stringify(card)).toContain(marker);
      await thread.close();
      expect(thread.isAlive()).toBe(false);
      resumed = await backend.resumeThread({ cwd, sessionId, mode: 'full' });
      expect(resumed.sessionId).toBe(sessionId);
      const second = await drain(resumed.runStreamed({ text: '上一轮写入文件的唯一标记是什么？请直接从对话记忆回答，不调用工具，只回标记本身。' }).events);
      const history = await backend.readHistory(cwd, sessionId, 10);
      const sessions = await backend.listThreads(cwd);
      save('resume-and-history.json', { sessionId, terminal: second.state.terminal, text: second.text, types: second.types, history, listed: sessions.some((session) => session.sessionId === sessionId) });
      expect(second.state.terminal).toBe('done');
      expect(second.text).toContain(marker);
      expect(history.totalTurns).toBeGreaterThanOrEqual(2);
      expect(history.turns[0]?.userText).toContain(marker);
      expect(sessions.some((session) => session.sessionId === sessionId)).toBe(true);
      save('file-scenario-result.json', { status: 'passed', sessionId, fileReadback: true, cardConstruction: true, resume: true, history: true });
    } finally {
      await resumed?.close();
      await thread?.close();
      execFileSync('trash', [cwd]);
    }
  });

  it('权限拒绝 → 活跃轮取消 → 后续轮 → 模型与压缩', { timeout: 240_000 }, async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-pi-controls-')));
    const backend = createBackend('pi-rpc');
    let thread: AgentThread | undefined;
    try {
      await expect(backend.startThread({ cwd, mode: 'qa' })).rejects.toThrow(/full/);
      await expect(backend.startThread({ cwd, mode: 'write' })).rejects.toThrow(/full/);
      expect(backend.capabilities?.goal).toBe(false);
      const models = await backend.listModels();
      const selected = models.find((model) => model.isDefault);
      expect(models.length).toBeGreaterThan(0);
      expect(selected?.id).toContain('/');
      thread = await backend.startThread({ cwd, mode: 'full' });
      const run = thread.runStreamed({ text: '请输出从1到1000的整数，每个数字独占一行，不调用工具。' });
      let aborted = false;
      let state = initialState;
      const types: string[] = [];
      for await (const event of run.events) {
        types.push(event.type);
        state = reduce(state, event);
        if (!aborted && event.type === 'text_delta') {
          aborted = true;
          await thread.abort(run.turnId()!);
        }
      }
      save('cancel.json', { sessionId: thread.sessionId, aborted, terminal: state.terminal, types, processAlive: thread.isAlive() });
      expect(aborted).toBe(true);
      expect(thread.isAlive()).toBe(true);
      await expect(thread.abort(run.turnId()!)).rejects.toThrow(/过期/);
      const next = await drain(thread.runStreamed({ text: '停止数数。只回答：取消后可继续' }).events);
      expect(next.state.terminal).toBe('done');
      expect(next.text).toContain('取消后可继续');
      const compact = await thread.compact();
      expect(typeof compact.compacted).toBe('boolean');
      expect(thread.isAlive()).toBe(true);
      save('controls-scenario-result.json', { status: 'passed', permissionsRejected: ['qa', 'write'], goal: false, aborted, nextTurn: next.text, compact, modelCount: models.length, selectedModel: selected, processAlive: thread.isAlive() });
    } finally {
      await thread?.close();
      execFileSync('trash', [cwd]);
    }
  });
});
