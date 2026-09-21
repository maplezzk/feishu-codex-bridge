import { describe, expect, it } from 'vitest';
import { buildProjectTopicsCard } from '../src/card/dm-cards';
import type { SessionRecord } from '../src/bot/session-store';

function session(i: number, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    threadId: `omt_${i}`,
    chatId: 'oc_project',
    cwd: '/work/project',
    sessionId: `thread_${i}`,
    backend: 'codex-appserver',
    summary: `topic-${i}`,
    createdAt: 1_000 + i,
    updatedAt: 2_000 + i,
    ...over,
  };
}

describe('buildProjectTopicsCard model display', () => {
  it('shows the persisted model and reasoning effort for each topic', () => {
    const card = buildProjectTopicsCard(
      { name: 'ERP', chatId: 'oc_project' },
      [
        session(1, { model: 'gpt-5.6-sol', effort: 'high' }),
        session(2, { model: 'gpt-5.6-terra' }),
        session(3),
      ],
    );
    const json = JSON.stringify(card);

    expect(json).toContain('🤖 模型：gpt-5.6-sol · 思考：高');
    expect(json).toContain('🤖 模型：gpt-5.6-terra · 思考：未记录');
    expect(json).toContain('🤖 模型：未记录 · 思考：未记录');
  });
});
