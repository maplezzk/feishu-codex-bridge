import type { CardActionEvent, LarkChannel } from '@larksuiteoapi/node-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import { CardDispatcher } from '../src/card/dispatcher';
import { createUserInputService } from '../src/card/user-input';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';

const wire = vi.hoisted(() => ({ writes: [] as Record<string, any>[] }));
vi.mock('../src/agent/codex-appserver/locate', () => ({ resolveCodexBin: () => 'fake-codex' }));
vi.mock('../src/platform/spawn', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/platform/spawn')>();
  const { EventEmitter } = await import('node:events');
  const { PassThrough, Writable } = await import('node:stream');
  return {
    ...original,
    spawnProcess: () => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      const emit = (message: object) => child.stdout.write(JSON.stringify(message) + '\n');
      child.stdin = new Writable({ write(chunk, _encoding, done) {
        const message = JSON.parse(String(chunk));
        wire.writes.push(message);
        if (message.method === 'initialize') emit({ id: message.id, result: {} });
        if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-e2e' } } });
        if (message.method === 'turn/start') {
          emit({ id: message.id, result: { turn: { id: 'turn-e2e' } } });
          emit({ method: 'turn/started', params: { threadId: 'thread-e2e', turn: { id: 'turn-e2e' } } });
          emit({ id: 'ask-42', method: 'item/tool/requestUserInput', params: {
            threadId: 'thread-e2e', turnId: 'turn-e2e', itemId: 'item-e2e', autoResolutionMs: null,
            questions: [
              { id: 'color', header: 'Color', question: 'Choose a color', isOther: false, isSecret: false,
                options: [{ label: 'Blue', description: 'Blue color' }, { label: 'Green', description: 'Green color' }] },
              { id: 'style', header: 'Style', question: 'Describe the style', isOther: true, isSecret: false, options: null },
            ],
          } });
        }
        if (message.id === 'ask-42' && message.result) {
          emit({ method: 'serverRequest/resolved', params: { threadId: 'thread-e2e', requestId: 'ask-42' } });
          emit({ method: 'item/completed', params: { threadId: 'thread-e2e', turnId: 'turn-e2e',
            item: { type: 'agentMessage', id: 'answer-e2e', text: 'Continuing with Blue and minimal.' } } });
          emit({ method: 'turn/completed', params: { threadId: 'thread-e2e', turn: { id: 'turn-e2e', status: 'completed', error: null } } });
        }
        done();
      } });
      child.kill = () => { queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0, null); }); return true; };
      return child;
    },
  };
});

function nodes(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, any>;
  return [object, ...Object.values(object).flatMap(nodes)];
}

describe('Codex question round trip through Feishu forms', () => {
  it('answers the original string RPC id, rejects a different user, and continues the same turn once', async () => {
    wire.writes.length = 0;
    const thread = await new CodexAppServerBackend().startThread({ cwd: process.cwd(), mode: 'full' });
    const channel = {} as LarkChannel;
    const dispatcher = new CardDispatcher(channel, {} as AppConfig);
    const send = vi.fn(async (_scope: unknown, _card: object) => ({ messageId: 'question-message' }));
    const update = vi.fn(async () => true);
    const notify = vi.fn(async () => undefined);
    const service = createUserInputService({ send, update, notify });
    service.register(dispatcher);
    const events: string[] = [];
    const run = thread.runStreamed({ text: 'Ask me two questions' });
    const consume = (async () => {
      for await (const event of run.events) {
        events.push(event.type);
        if (event.type === 'user_input_request') await service.open(event.request, {
          chatId: 'chat-e2e', inThread: true, replyToMessageId: 'run-message', requesterOpenId: 'owner-e2e',
        });
      }
    })();
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      const cardNodes = nodes(send.mock.calls[0]![1]);
      const callback = cardNodes.find((node) => node.a === 'codex.question.submit');
      const select = cardNodes.find((node) => node.tag === 'select_static')!;
      const input = cardNodes.find((node) => node.tag === 'input')!;
      expect(callback).toBeDefined();
      const formValue = { [select.name]: select.options[0].value, [input.name]: 'minimal' };
      const action = (openId: string) => ({
        chatId: 'chat-e2e', messageId: 'question-message', operator: { openId },
        action: { value: callback, tag: 'button' }, raw: { action: { form_value: formValue } },
      }) as unknown as CardActionEvent;
      await dispatcher.handle(action('different-user'));
      expect(wire.writes.filter((message) => message.id === 'ask-42')).toEqual([]);
      await dispatcher.handle(action('owner-e2e'));
      await consume;
      expect(wire.writes.filter((message) => message.id === 'ask-42')).toEqual([
        { jsonrpc: '2.0', id: 'ask-42', result: { answers: { color: { answers: ['Blue'] }, style: { answers: ['minimal'] } } } },
      ]);
      expect(events).toContain('text');
      expect(events.at(-1)).toBe('done');
      await dispatcher.handle(action('owner-e2e'));
      expect(wire.writes.filter((message) => message.id === 'ask-42')).toHaveLength(1);
      expect(update).toHaveBeenCalled();
      expect(notify).toHaveBeenCalled();
    } finally {
      await service.closeThread(thread.sessionId, 'test-ended');
      await thread.close();
    }
  });
});
