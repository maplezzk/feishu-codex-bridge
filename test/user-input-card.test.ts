import { describe, expect, it } from 'vitest';
import {
  buildUserInputCard,
  customField,
  questionField,
  USER_INPUT_ACTION,
} from '../src/card/user-input';
import type { AgentUserInputQuestion } from '../src/agent/types';

function question(overrides: Partial<AgentUserInputQuestion> = {}): AgentUserInputQuestion {
  return {
    id: 'colour',
    header: 'Colour',
    question: 'Which colour should Codex use?',
    isOther: false,
    isSecret: false,
    options: [
      { label: 'Blue', description: 'A calm blue tone' },
      { label: 'Red', description: 'A vivid red tone' },
    ],
    ...overrides,
  };
}

function callbackValues(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(callbackValues);
  if (!node || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  const own = Array.isArray(obj.behaviors)
    ? obj.behaviors.flatMap((behavior) => {
      if (!behavior || typeof behavior !== 'object') return [];
      const value = (behavior as Record<string, unknown>).value;
      return value && typeof value === 'object' ? [value as Record<string, unknown>] : [];
    })
    : [];
  const children = Object.entries(obj)
    .filter(([key]) => key !== 'behaviors')
    .flatMap(([, value]) => callbackValues(value));
  return [...own, ...children];
}

function findByTag(node: unknown, tag: string): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap((item) => findByTag(item, tag));
  if (!node || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  const own = obj.tag === tag ? [obj] : [];
  return [...own, ...Object.values(obj).flatMap((value) => findByTag(value, tag))];
}

describe('Codex user-input cards', () => {
  it('keeps the full question and option descriptions, uses index values, and does not preselect', () => {
    const built = buildUserInputCard({ questions: [question({ isOther: true })], token: 'opaque-token' });
    const json = JSON.stringify(built);
    expect(json).toContain('Which colour should Codex use?');
    expect(json.split('Blue — A calm blue tone')).toHaveLength(2);
    expect(json.split('Red — A vivid red tone')).toHaveLength(2);
    expect(findByTag(built, 'markdown').map((node) => node.content)).toEqual([
      '每题选择或填写答案后提交，自填内容优先。',
      'Which colour should Codex use?',
    ]);
    expect(built.config).toMatchObject({ width_mode: 'default' });
    expect(findByTag(built, 'column_set').some((row) =>
      findByTag(row, 'select_static').length === 1 && findByTag(row, 'input').length === 1)).toBe(true);
    expect(findByTag(built, 'input')[0]).toMatchObject({ input_type: 'text', placeholder: { content: '其他答案（可选）' } });
    expect(json).toContain(questionField(0));
    expect(json).toContain(customField(0));
    expect(json).toContain('"value":"0"');
    expect(json).toContain('"value":"1"');
    expect(json).not.toContain('initial_option');
    expect(callbackValues(built)).toEqual([expect.objectContaining({ a: USER_INPUT_ACTION, token: 'opaque-token' })]);
  });

  it('renders a free-text field for options=null and preserves all three questions in English', () => {
    const questions = [
      question({ id: 'one', header: 'One', question: 'First?', options: null, isOther: false }),
      question({ id: 'two', header: 'Two', question: 'Second?', options: [{ label: 'A', description: 'The first' }] }),
      question({ id: 'three', header: 'Three', question: 'Third?', options: null, isOther: true }),
    ];
    const built = buildUserInputCard({ questions, token: 't', locale: 'en' });
    const json = JSON.stringify(built);
    expect(json).toContain('Codex needs your answer');
    expect(json).toContain('First?');
    expect(json).toContain('Second?');
    expect(json).toContain('Third?');
    expect(findByTag(built, 'input')).toHaveLength(2);
    expect(findByTag(built, 'input').every((node) => node.required === true)).toBe(true);
    expect(findByTag(built, 'select_static')).toHaveLength(1);
  });

  it('never renders a secret question', () => {
    expect(() => buildUserInputCard({ questions: [question({ isSecret: true })], token: 't' })).toThrow(/secret/i);
  });

  it('removes all live controls from terminal cards', () => {
    const resolved = buildUserInputCard({
      questions: [question()],
      token: 't',
      status: 'resolved',
      answers: { colour: { answers: ['Blue'] } },
    });
    expect(findByTag(resolved, 'form')).toHaveLength(0);
    expect(callbackValues(resolved)).toHaveLength(0);
    expect(JSON.stringify(resolved)).toContain('Blue');
  });
});
