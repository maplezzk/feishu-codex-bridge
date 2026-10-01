import { describe, expect, it, vi } from 'vitest';
import { createAsyncUserInputRequest, createUserInputService } from '../src/card/user-input';
import { notificationRecipients } from '../src/bot/notification-recipients';
import { sendCompletionReminderReply } from '../src/bot/completion-reminder';

function fixture() {
  let people = ['ou_A'];
  const reply = vi.fn(async () => ({}));
  const api = {
    get: async ({ path }: any) => ({ code: 0, data: { items: [{ thread_id: 'omt_topic',
      ...(path.message_id === 'om_root' ? { sender: { id: 'ou_root', sender_type: 'user' } } : { root_id: 'om_root' }),
    }] } }),
    list: async ({ params }: any) => ({ code: params.container_id === 'omt_topic' && params.container_id_type === 'thread' ? 0 : 400,
      data: params.page_token ? {
      items: people.map(id => ({ sender: { id, sender_type: 'user' } })), has_more: false,
    } : { items: [{ sender: { id: 'cli_bot', sender_type: 'app' } },
      { sender: { id: 'ou_A', sender_type: 'user' } }, { sender: { id: 'system', sender_type: 'system' } }],
      has_more: true, page_token: 'second-page' } }),
    reply,
  };
  return { api, reply, join: (id: string) => { people.push(id); },
    channel: { rawClient: { im: { v1: { message: api } } } } as never };
}

describe('topic notification delivery', () => {
  it('questions and completion include humans from every page and newly joined B, without robots or repeated mentions', async () => {
    const f = fixture();
    const cards: object[] = [];
    const service = createUserInputService({
      recipients: scope => notificationRecipients(f.channel, { messageId: scope.replyToMessageId,
        inThread: scope.inThread, requesterOpenId: scope.requesterOpenId }),
      send: async (_scope, card) => { cards.push(card); return { messageId: 'om_question' }; },
      update: async () => true, notify: async () => undefined,
    });
    const request = () => createAsyncUserInputRequest({ threadId: 'session', turnId: 'turn', itemId: crypto.randomUUID(),
      questions: [{ id: 'next', header: 'Next', question: '下一步？', isOther: true, isSecret: false, options: [] }],
    }, async () => undefined);
    const scope = { chatId: 'oc_chat', replyToMessageId: 'om_card', inThread: true, requesterOpenId: 'ou_A' };
    try {
      await service.open(request(), scope);
      f.join('ou_B');
      await service.open(request(), scope);
      const first = JSON.stringify(cards[0]);
      const second = JSON.stringify(cards[1]);
      expect(first).toContain('<at id=ou_A></at>');
      expect(first).not.toContain('<at id=ou_B></at>');
      for (const id of ['ou_A', 'ou_B', 'ou_root']) {
        expect(second.split(`<at id=${id}></at>`)).toHaveLength(2);
      }
      expect(second).not.toContain('cli_bot');
      expect(second).not.toContain('<at id=system>');
      await expect(sendCompletionReminderReply({ channel: f.channel,
        cfg: { accounts: { app: { id: 'cli_bot', secret: 'fixture', tenant: 'feishu' } },
          preferences: { completionReminder: { mode: 'always' } } }, dedupe: { seen: () => false },
      }, { cardMsgId: 'om_card', requesterOpenId: 'ou_A', outcome: 'done', requestedAt: Date.now(),
        manuallyRequested: false, cardUpdated: true, replyInThread: true })).resolves.toBe('sent');
      const body = JSON.parse((f.reply.mock.calls[0] as any)[0].data.content);
      expect(body.zh_cn.content[0].filter((node: any) => node.tag === 'at').map((node: any) => node.user_id))
        .toEqual(['ou_A', 'ou_root', 'ou_B']);
    } finally { await service.closeAll('test-ended'); }
  });

  it('flat replies do not notify other topic members; incomplete pagination reports an error and only falls back to the requester', async () => {
    const f = fixture();
    f.join('ou_B');
    expect(await notificationRecipients(f.channel, { messageId: 'om_card', inThread: false, requesterOpenId: 'ou_A' }))
      .toEqual(['ou_A']);
    f.api.list = async () => ({ code: 0, data: { items: [], has_more: true, page_token: 'same-page' } });
    expect(await notificationRecipients(f.channel, { messageId: 'om_card', inThread: true, requesterOpenId: 'ou_A' }))
      .toEqual(['ou_A']);
  });
});
