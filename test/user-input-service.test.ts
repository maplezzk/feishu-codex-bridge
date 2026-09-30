import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentUserInputQuestion, AgentUserInputRequest } from '../src/agent/types';
import { CardDispatcher } from '../src/card/dispatcher';
import {
  buildUserInputCard,
  createUserInputService,
  customField,
  questionField,
  USER_INPUT_ACTION,
  type UserInputScope,
} from '../src/card/user-input';

interface RequestHarness {
  request: AgentUserInputRequest;
  respond: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
  resolve(reason: string): void;
}

function question(overrides: Partial<AgentUserInputQuestion> = {}): AgentUserInputQuestion {
  return {
    id: 'mode',
    header: 'Mode',
    question: 'Which mode?',
    isOther: false,
    isSecret: false,
    options: [
      { label: 'Fast', description: 'Move quickly' },
      { label: 'Safe', description: 'Run extra checks' },
    ],
    ...overrides,
  };
}

function makeRequest(
  questions: AgentUserInputQuestion[] = [question()],
  opts: { autoResolutionMs?: number | null; respondFailure?: Error } = {},
): RequestHarness {
  let pending = true;
  const listeners = new Set<(reason: string) => void>();
  const respond = vi.fn(async () => {
    if (!pending) throw new Error('request is no longer pending');
    pending = false;
    for (const listener of [...listeners]) listener('responded');
    if (opts.respondFailure) throw opts.respondFailure;
  });
  const reject = vi.fn(async (reason: string) => {
    if (!pending) throw new Error('request is no longer pending');
    pending = false;
    for (const listener of [...listeners]) listener(reason);
  });
  const request: AgentUserInputRequest = {
    requestId: 'req-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    questions,
    ...(opts.autoResolutionMs === undefined ? {} : { autoResolutionMs: opts.autoResolutionMs }),
    isPending: () => pending,
    respond,
    reject,
    onResolved: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    request,
    respond,
    reject,
    resolve(reason: string) {
      if (!pending) return;
      pending = false;
      for (const listener of [...listeners]) listener(reason);
    },
  };
}

function findCallbackValue(node: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findCallbackValue(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.behaviors)) {
    for (const behavior of obj.behaviors) {
      if (!behavior || typeof behavior !== 'object') continue;
      const value = (behavior as Record<string, unknown>).value;
      if (value && typeof value === 'object' && (value as Record<string, unknown>).a === USER_INPUT_ACTION) {
        return value as Record<string, unknown>;
      }
    }
  }
  for (const child of Object.values(obj)) {
    const found = findCallbackValue(child);
    if (found) return found;
  }
  return undefined;
}

function setup(overrides: {
  questions?: AgentUserInputQuestion[];
  autoResolutionMs?: number | null;
  send?: (scope: UserInputScope, card: object) => Promise<{ messageId: string }>;
  update?: (messageId: string, card: object) => Promise<boolean>;
  notify?: (scope: UserInputScope, text: string) => Promise<unknown>;
  respondFailure?: Error;
} = {}) {
  const sent: { scope: UserInputScope; card: object }[] = [];
  const updates: { messageId: string; card: object }[] = [];
  const notices: { scope: UserInputScope; text: string }[] = [];
  const errors: { error: unknown; phase: string }[] = [];
  const harness = makeRequest(overrides.questions, {
    autoResolutionMs: overrides.autoResolutionMs,
    respondFailure: overrides.respondFailure,
  });
  const send = overrides.send ?? (async (scope, card) => {
    sent.push({ scope, card });
    return { messageId: 'message-1' };
  });
  const update = async (messageId: string, card: object) => {
    updates.push({ messageId, card });
    return overrides.update ? overrides.update(messageId, card) : true;
  };
  const notify = overrides.notify ?? (async (scope, text) => {
    notices.push({ scope, text });
  });
  const service = createUserInputService({
    send,
    update,
    notify,
    onError: (error, phase) => errors.push({ error, phase }),
  });
  const dispatcher = new CardDispatcher({} as never, {} as never);
  service.register(dispatcher);
  const scope: UserInputScope = {
    chatId: 'chat-1',
    replyToMessageId: 'reply-1',
    inThread: true,
    requesterOpenId: 'user-1',
  };
  return { harness, service, dispatcher, scope, sent, updates, notices, errors, callback: () => findCallbackValue(sent[0]?.card) };
}

async function click(
  t: ReturnType<typeof setup>,
  formValue: Record<string, unknown>,
  overrides: Partial<{ chatId: string; messageId: string; openId: string }> = {},
): Promise<void> {
  const callback = t.callback();
  expect(callback).toBeDefined();
  await t.dispatcher.handle({
    chatId: overrides.chatId ?? t.scope.chatId,
    messageId: overrides.messageId ?? 'message-1',
    operator: { openId: overrides.openId ?? t.scope.requesterOpenId },
    action: { value: callback },
    raw: { action: { form_value: formValue } },
  } as never);
}

describe('Codex user-input service', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends one scoped card and maps index values while custom text wins', async () => {
    const t = setup({ questions: [question({ isOther: true })] });
    await t.service.open(t.harness.request, t.scope);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.scope).toMatchObject(t.scope);
    const card = t.sent[0]?.card as Record<string, unknown>;
    expect(JSON.stringify(card)).toContain(USER_INPUT_ACTION);

    await click(t, { [questionField(0)]: '1', [customField(0)]: 'my own mode' });
    expect(t.harness.respond).toHaveBeenCalledWith({ mode: { answers: ['my own mode'] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(t.updates.at(-1)?.card)).toContain('my own mode');
  });

  it('rejects callbacks from another user, chat, or message without resolving the request', async () => {
    const t = setup();
    await t.service.open(t.harness.request, t.scope);
    await click(t, { [questionField(0)]: '0' }, { openId: 'intruder' });
    await click(t, { [questionField(0)]: '0' }, { chatId: 'other-chat' });
    await click(t, { [questionField(0)]: '0' }, { messageId: 'other-message' });
    expect(t.harness.respond).not.toHaveBeenCalled();
    expect(t.harness.reject).not.toHaveBeenCalled();
    expect(t.notices.map((notice) => notice.text).join('\n')).toMatch(/只接受|所属会话|当前提问卡/);
  });

  it('notifies and refreshes the pending card for empty or invalid answers, then accepts a retry', async () => {
    const t = setup();
    await t.service.open(t.harness.request, t.scope);
    await click(t, {});
    await click(t, { [questionField(0)]: '999' });
    expect(t.harness.respond).not.toHaveBeenCalled();
    expect(t.updates.length).toBeGreaterThanOrEqual(2);
    await click(t, { [questionField(0)]: '0' });
    expect(t.harness.respond).toHaveBeenCalledWith({ mode: { answers: ['Fast'] } });
  });

  it('rejects a selected-option array containing an invalid member without dropping it', async () => {
    const t = setup();
    await t.service.open(t.harness.request, t.scope);
    await click(t, { [questionField(0)]: ['0', {}] });
    expect(t.harness.respond).not.toHaveBeenCalled();
    expect(t.harness.request.isPending()).toBe(true);
    expect(t.notices.some((notice) => notice.text.includes('无效选项'))).toBe(true);
    await click(t, { [questionField(0)]: '0' });
    expect(t.harness.respond).toHaveBeenCalledOnce();
  });

  it('preserves a protocol question id that matches an object prototype property', async () => {
    const t = setup({ questions: [question({ id: '__proto__' })] });
    await t.service.open(t.harness.request, t.scope);
    await click(t, { [questionField(0)]: '0' });
    expect(JSON.stringify(t.harness.respond.mock.calls[0]?.[0])).toBe('{"__proto__":{"answers":["Fast"]}}');
  });

  it('does not respond after the request resolves while the submitting-card update is in flight', async () => {
    let finishUpdate!: () => void;
    let first = true;
    const t = setup({
      update: async () => {
        if (first) {
          first = false;
          await new Promise<void>((resolve) => { finishUpdate = () => resolve(); });
        }
        return true;
      },
    });
    await t.service.open(t.harness.request, t.scope);
    const clickPromise = click(t, { [questionField(0)]: '0' });
    await vi.waitFor(() => expect(finishUpdate).toBeTypeOf('function'));
    t.harness.resolve('server-resolved');
    finishUpdate();
    await clickPromise;
    expect(t.harness.respond).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(t.updates.at(-1)?.card)).toContain('提问已失效');
  });

  it('does not leave a pending card behind when resolution races an invalid-submit refresh', async () => {
    let finishUpdate!: () => void;
    let first = true;
    const t = setup({
      update: async () => {
        if (first) {
          first = false;
          await new Promise<void>((resolve) => { finishUpdate = () => resolve(); });
        }
        return true;
      },
    });
    await t.service.open(t.harness.request, t.scope);
    const clickPromise = click(t, {});
    await vi.waitFor(() => expect(finishUpdate).toBeTypeOf('function'));
    t.harness.resolve('server-resolved');
    finishUpdate();
    await clickPromise;
    await vi.advanceTimersByTimeAsync(0);
    expect(t.harness.respond).not.toHaveBeenCalled();
    expect(JSON.stringify(t.updates.at(-1)?.card)).toContain('提问已失效');
  });

  it('rejects free-text questions without inventing an answer', async () => {
    const t = setup({ questions: [question({ options: null, isOther: true })] });
    await t.service.open(t.harness.request, t.scope);
    await click(t, {});
    expect(t.harness.respond).not.toHaveBeenCalled();
    await click(t, { [customField(0)]: 'typed answer' });
    expect(t.harness.respond).toHaveBeenCalledWith({ mode: { answers: ['typed answer'] } });
  });

  it('turns an external resolution into an inactive card, and late clicks only notify', async () => {
    const t = setup();
    await t.service.open(t.harness.request, t.scope);
    t.harness.resolve('server-resolved');
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(t.updates.at(-1)?.card)).toContain('提问已失效');
    const updateCount = t.updates.length;
    await click(t, { [questionField(0)]: '0' });
    expect(t.harness.respond).not.toHaveBeenCalled();
    expect(t.updates).toHaveLength(updateCount);
    expect(t.notices.at(-1)?.text).toMatch(/失效/);
  });

  it('rejects secret requests without sending their question text to Feishu', async () => {
    const t = setup({ questions: [question({ isSecret: true, question: 'secret-value' })] });
    await t.service.open(t.harness.request, t.scope);
    expect(t.sent).toHaveLength(0);
    expect(t.harness.reject).toHaveBeenCalledOnce();
    expect(t.notices.at(-1)?.text).not.toContain('secret-value');
  });

  it('rejects a request without a requester identity instead of sending an unanswered card', async () => {
    const t = setup();
    await t.service.open(t.harness.request, { chatId: 'chat-1', inThread: true });
    expect(t.sent).toHaveLength(0);
    expect(t.harness.reject).toHaveBeenCalledOnce();
    expect(t.notices.at(-1)?.text).toMatch(/发起人|requester/);
  });

  it('rejects on the bounded timeout and does not fabricate answers', async () => {
    const t = setup({ autoResolutionMs: 50 });
    await t.service.open(t.harness.request, t.scope);
    await vi.advanceTimersByTimeAsync(49);
    expect(t.harness.reject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.harness.reject).toHaveBeenCalledOnce();
    expect(t.harness.respond).not.toHaveBeenCalled();
    expect(JSON.stringify(t.updates.at(-1)?.card)).toContain('超时');
  });

  it('rejects the request and notifies when sending fails', async () => {
    const t = setup({ send: async () => { throw new Error('network down'); } });
    await t.service.open(t.harness.request, t.scope);
    expect(t.harness.reject).toHaveBeenCalledOnce();
    expect(t.notices.at(-1)?.text).toMatch(/发送失败/);
    expect(t.errors.some((entry) => entry.phase === 'send')).toBe(true);
  });

  it('marks a response write failure explicitly and isolates an update failure', async () => {
    const t = setup({ respondFailure: new Error('write failed'), update: async () => false });
    await t.service.open(t.harness.request, t.scope);
    await click(t, { [questionField(0)]: '0' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.harness.respond).toHaveBeenCalledOnce();
    expect(t.notices.map((notice) => notice.text).join('\n')).toMatch(/更新失败|提交失败/);
    expect(t.errors.some((entry) => entry.phase === 'respond')).toBe(true);
  });

  it('closes all pending requests for a thread without throwing through caller cleanup', async () => {
    const t = setup();
    await t.service.open(t.harness.request, t.scope);
    await expect(t.service.closeThread('thread-1', 'run-ended')).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.harness.reject).toHaveBeenCalledWith('run-ended');
    expect(JSON.stringify(t.updates.at(-1)?.card)).toContain('提问已关闭');
  });
});
