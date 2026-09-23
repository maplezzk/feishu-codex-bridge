import { describe, expect, it } from 'vitest';
import { appendIncompleteContentNotice } from '../src/bot/inbound-content';

describe('appendIncompleteContentNotice', () => {
  it('keeps readable forwarded text actionable while fencing only the missing parts', () => {
    const out = appendIncompleteContentNotice(
      '<forwarded_messages>\n[17:23] 陈钟芮Rosy: 包裹号：38051320\n</forwarded_messages>',
      'forwarded-messages',
      '已读取 11 条转发消息的文字内容；2 条图片或附件的实际内容未能读取。',
      { partialReadable: true },
    );

    expect(out).toContain('包裹号：38051320');
    expect(out).toContain('已读取 11 条转发消息的文字内容；2 条图片或附件的实际内容未能读取。');
    expect(out).toContain('已读取的部分正文可以直接使用');
    expect(out).toContain('不要把占位符当作真实内容');
  });
});
