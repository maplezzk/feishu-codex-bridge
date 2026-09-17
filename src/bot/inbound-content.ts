/**
 * Messages from Feishu are user data.  When the bridge cannot read all of a
 * card or a forwarded conversation, the model must be told that the input is
 * incomplete instead of being left to fill in the blanks from a title or
 * surrounding context.
 */

export type IncompleteContentKind = 'interactive-card' | 'forwarded-messages' | 'quoted-message';

/**
 * Append an explicit, model-visible read-status block.  `detail` is flattened
 * and bounded here because it can originate in an uploader-controlled message
 * body.  The normal context weaving sanitizes it again before it is used as a
 * quote/history block.
 */
export function appendIncompleteContentNotice(
  text: string,
  kind: IncompleteContentKind,
  detail?: string,
): string {
  const label =
    kind === 'interactive-card' ? '交互卡片' : kind === 'forwarded-messages' ? '转发聊天记录' : '引用消息';
  const cleanDetail = cleanDetailText(detail);
  const current = text.trim();
  const lines = [
    `[桥接层读取状态：这条飞书${label}的内容没有完整读取成功。`,
    cleanDetail ? `当前只确认到：${cleanDetail}` : '当前没有可确认的正文。',
    '不要根据标题、摘要、历史上下文或常识猜测缺失内容。',
    '请向用户索要原始文字、截图或可访问链接；在补全前不要执行依赖缺失字段的查询、修改、审批或提交。',
    ']',
  ];
  const notice = lines.join('\n');
  return current ? `${current}\n\n${notice}` : notice;
}

function cleanDetailText(value: string | undefined): string {
  if (!value) return '';
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}
