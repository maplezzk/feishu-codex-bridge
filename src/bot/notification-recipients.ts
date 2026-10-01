import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { CARD_API_TIMEOUT_MS, withCardApiTimeout } from '../card/run-card-stream';
import { log } from '../core/logger';

interface Message {
  root_id?: string;
  thread_id?: string;
  upper_message_id?: string;
  sender?: { id?: string; id_type?: string; sender_type?: string };
}

/** Read at notification time so people joining after the turn began are included. */
export async function notificationRecipients(
  channel: LarkChannel,
  scope: { messageId?: string; inThread: boolean; requesterOpenId?: string },
): Promise<string[]> {
  const fallback = scope.requesterOpenId ? [scope.requesterOpenId] : [];
  if (!scope.inThread || !scope.messageId) return fallback;
  try {
    return await withCardApiTimeout(async () => {
      const deadline = Date.now() + CARD_API_TIMEOUT_MS;
      const recipients = new Set(fallback);
      const collect = (item: Message) => {
        const sender = item.sender;
        if (!item.upper_message_id && sender?.sender_type === 'user' && sender.id && (!sender.id_type || sender.id_type === 'open_id')) {
          recipients.add(sender.id);
        }
      };
      const message = await channel.rawClient.im.v1.message.get({ path: { message_id: scope.messageId! } });
      if (message.code || !message.data?.items?.[0]?.thread_id) throw new Error('topic lookup failed');
      const item = message.data.items[0];
      collect(item);
      if (item.root_id && item.root_id !== scope.messageId) {
        const root = await channel.rawClient.im.v1.message.get({ path: { message_id: item.root_id } });
        if (root.code || !root.data?.items?.length) throw new Error('topic root lookup failed');
        // A forwarded root may include original messages from another chat.
        collect(root.data.items[0]!);
      }
      const seen = new Set<string>();
      let pageToken: string | undefined;
      do {
        if (Date.now() >= deadline) throw new Error('topic participants lookup timed out');
        const response = await channel.rawClient.im.v1.message.list({ params: {
          container_id_type: 'thread', container_id: item.thread_id!, page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        } });
        if (response.code || !response.data?.items) throw new Error('topic participants lookup failed');
        response.data.items.forEach(collect);
        if (!response.data.has_more) return [...recipients];
        pageToken = response.data.page_token;
        if (!pageToken || seen.has(pageToken)) throw new Error('topic pagination incomplete');
        seen.add(pageToken);
      } while (true);
    }, '话题通知参与者读取');
  } catch (err) {
    // Notification lookup must not turn an already finished task into a failure.
    log.fail('card', err, { phase: 'topic-notification-recipients', fallback: 'requester-only' });
    return fallback;
  }
}
