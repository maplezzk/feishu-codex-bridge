import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

/**
 * Recover the real text of an `interactive` (card 2.0) message that Feishu
 * delivers to bots only as a downgraded placeholder.
 *
 * Why this exists: when a card 2.0 / CardKit interactive card is *received* by a
 * bot (e.g. a 多维表格「发送消息卡片」自动化, or any app-sent card), the push
 * event — and the default `im.v1.message.get` body — carry a degraded legacy
 * representation: `{"title":"…","elements":[[{"tag":"text","text":"请升级至最新
 * 版本客户端，以查看内容"}]]}`. The actual body (markdown, links, the Base record
 * URL) is NOT in it, so the SDK's converter walks it to nothing and yields the
 * `[interactive card]` fallback — codex then sees no usable content.
 *
 * The full card is only returned when the message is fetched with
 * `card_msg_content_type=raw_card_content`, which gives a `json_card` in the
 * property-wrapped card-builder schema (distinct from the send-format schema the
 * SDK's walkCard handles). We re-fetch that here and extract its text + links so
 * codex reads「请处理这条记录 [查看…](base链接)」and can follow the link.
 */

/** True when the normalized card content is a downgraded placeholder (no real
 * body), so a `raw_card_content` re-fetch is worth it. Covers the SDK's
 * `[interactive card]` fallback and the literal「请升级…」client placeholder. */
export function isDegradedCardContent(content: string): boolean {
  const t = content.trim();
  if (t === '' || t === '[interactive card]') return true;
  return /请升级至最新版本客户端|请使用新版本.*查看|client to view|upgrade .*client/i.test(t);
}

/** Unwrap the `card_msg_content_type=raw_card_content` body: the API returns
 * `{"json_card":"<stringified card>","json_attachment":{…}}`. Returns the parsed
 * `json_card` object, the parsed body itself if it isn't wrapped, or undefined on
 * malformed JSON. */
export function parseRawCardWrapper(bodyContent: string): unknown {
  try {
    const parsed = JSON.parse(bodyContent) as Record<string, unknown>;
    if (typeof parsed.json_card === 'string') return JSON.parse(parsed.json_card);
    if (parsed.json_card && typeof parsed.json_card === 'object') return parsed.json_card;
    return parsed;
  } catch {
    return undefined;
  }
}

export type InteractiveCardReadReason =
  | 'fetch-failed'
  | 'empty-response'
  | 'malformed-response'
  | 'title-only'
  | 'body-unreadable';

/** Result of reading a card source.  `complete=false` is deliberately
 * explicit: a non-empty title is not evidence that the card body was read. */
export interface InteractiveCardContent {
  text?: string;
  complete: boolean;
  reason?: InteractiveCardReadReason;
}

/**
 * Extract readable text + links from the `raw_card_content` (json_card) schema —
 * the property-wrapped card-builder format where text lives in
 * `property.content`, links pair it with `property.url.url`, and structure nests
 * under `property.elements / columns / actions / title / text`. A multilingual
 * footer (`property.i18nElements`) is rendered in one locale only (zh_cn first)
 * to avoid 5× duplication. Output lines are de-duplicated, order preserved.
 */
export function extractRawCardText(jsonCard: unknown): string {
  return collectCardParts(jsonCard).all.join('\n');
}

function visit(node: unknown, out: string[]): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, out);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  // Top-level containers (header first so the card title leads the body).
  if (obj.header) visit(obj.header, out);
  if (obj.body) visit(obj.body, out);

  // Card 2.0 / CardKit source cards use direct fields such as
  // `body.elements[].content` and `{tag:'plain_text', content:'...'}`.  The
  // old extractor only followed `property.*`, which silently reduced a full
  // card to its header title.  Read the direct send-format shape as well.
  pushDirectLeaf(obj, out);
  visitDirectChildren(obj, out);

  const prop = obj.property as Record<string, unknown> | undefined;
  if (!prop) return;

  // Leaf text: plain_text / link / markdown-leaf. A link pairs content with a URL.
  if (typeof prop.content === 'string' && prop.content.trim()) {
    const url = readUrl(prop.url);
    out.push(url ? `[${prop.content.trim()}](${url})` : prop.content);
  }

  // Multilingual footer — keep one locale (else the「来自 …」line repeats ×5).
  const i18n = prop.i18nElements as Record<string, unknown> | undefined;
  if (i18n && typeof i18n === 'object') {
    visit(i18n.zh_cn ?? i18n.zh_hk ?? i18n.zh_tw ?? i18n.en_us ?? Object.values(i18n)[0], out);
  }

  // Nested structure: panel headers, titles, button labels, rows/columns,
  // action groups, list items and code-block token contents.
  visit(prop.header, out);
  visit(prop.title, out);
  visit(prop.text, out);
  visit(prop.label, out);
  visit(prop.placeholder, out);
  visit(prop.summary, out);
  visit(prop.options, out);
  visit(prop.items, out);
  visit(prop.contents, out);
  visit(prop.elements, out);
  visit(prop.columns, out);
  visit(prop.actions, out);
}

function pushDirectLeaf(obj: Record<string, unknown>, out: string[]): void {
  const tag = typeof obj.tag === 'string' ? obj.tag : '';
  const content = typeof obj.content === 'string' ? obj.content : undefined;
  const text = typeof obj.text === 'string' ? obj.text : undefined;
  const structuredText =
    obj.text && typeof obj.text === 'object' && typeof (obj.text as { content?: unknown }).content === 'string'
      ? ((obj.text as { content: string }).content as string)
      : undefined;
  const url = readUrl(obj.url);
  if (content?.trim()) out.push(url ? `[${content.trim()}](${url})` : content);
  // `text` is used by legacy button/link nodes.  Avoid duplicating the direct
  // content of a plain-text node, and do not treat an empty/structural tag as
  // readable text.
  if (text?.trim() && (!content || tag === 'button' || tag === 'a' || tag === 'text')) {
    out.push(url ? `[${text.trim()}](${url})` : text);
  }
  if (structuredText?.trim() && (tag === 'button' || tag === 'a' || tag === 'text')) {
    out.push(url ? `[${structuredText.trim()}](${url})` : structuredText);
  }
  if (tag === 'a' && !content && !text && url) out.push(url);
}

function visitDirectChildren(obj: Record<string, unknown>, out: string[]): void {
  const i18n = obj.i18nElements;
  if (i18n && typeof i18n === 'object') {
    const locales = i18n as Record<string, unknown>;
    visit(locales.zh_cn ?? locales.zh_hk ?? locales.zh_tw ?? locales.en_us ?? Object.values(locales)[0], out);
  }
  for (const key of [
    'header',
    'title',
    'text',
    'label',
    'placeholder',
    'summary',
    'options',
    'items',
    'contents',
    'elements',
    'columns',
    'actions',
    'fields',
    'content',
  ]) {
    const value = obj[key];
    // `content` was already emitted when it is a string.  Arrays/objects can
    // still contain nested rich-text nodes and need traversal.
    if (key === 'content' && typeof value === 'string') continue;
    if (
      key === 'text' &&
      (obj.tag === 'button' || obj.tag === 'a' || obj.tag === 'text') &&
      value &&
      typeof value === 'object' &&
      typeof (value as { content?: unknown }).content === 'string'
    ) {
      continue;
    }
    if (value != null) visit(value, out);
  }
}

function readUrl(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const url = (value as { url?: unknown }).url;
    if (typeof url === 'string' && url.trim()) return url.trim();
  }
  return undefined;
}

function uniqueLines(out: string[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const piece of out) {
    const key = piece.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    lines.push(key);
  }
  return lines;
}

function collectCardParts(jsonCard: unknown): { all: string[]; title: string[]; body: string[]; hasBody: boolean } {
  const allRaw: string[] = [];
  visit(jsonCard, allRaw);

  const titleRaw: string[] = [];
  const bodyRaw: string[] = [];
  const root = jsonCard && typeof jsonCard === 'object' && !Array.isArray(jsonCard) ? (jsonCard as Record<string, unknown>) : undefined;
  if (root?.header != null) visit(root.header, titleRaw);
  if (root?.title != null) visit(root.title, titleRaw);

  let hasBody = false;
  if (root?.body != null) {
    hasBody = true;
    visit(root.body, bodyRaw);
  } else if (root) {
    for (const key of ['elements', 'content', 'columns', 'actions', 'fields', 'label', 'placeholder', 'options', 'text']) {
      if (root[key] == null) continue;
      hasBody = true;
      visit(root[key], bodyRaw);
    }
  }

  const all = uniqueLines(allRaw);
  const title = uniqueLines(titleRaw);
  const body = uniqueLines(bodyRaw).filter((line) => !title.includes(line));
  // Some cards expose a direct `title` without a separate `body` object.  If
  // that title is the only readable field, it is still incomplete from the
  // bridge's point of view and must be surfaced to the model.
  return { all, title, body, hasBody };
}

/** Assess whether a raw card contains a readable body, rather than merely a
 * title.  This is intentionally conservative: a false incomplete warning is
 * safer than letting an agent act on a guessed ticket/SKU. */
export function assessRawCardContent(jsonCard: unknown): InteractiveCardContent {
  const parts = collectCardParts(jsonCard);
  const text = parts.all.join('\n').trim();
  if (!text) return { complete: false, reason: 'body-unreadable' };

  const title = parts.title.join('\n').trim();
  const body = parts.body.join('\n').trim();
  if (!body || (title && text === title)) {
    return { text, complete: false, reason: parts.hasBody ? 'body-unreadable' : 'title-only' };
  }
  return { text, complete: true };
}

/** A normalized event can contain just a card title even though the source
 * body was dropped by Feishu.  Use this only for interactive messages; a
 * normal one-line text message must not be treated as a card. */
export function isLikelyIncompleteCardText(content: string): boolean {
  const t = content.trim();
  if (isDegradedCardContent(t)) return true;
  if (!t || t === '[卡片消息]') return true;
  return !t.includes('\n') && !/https?:\/\//i.test(t) && !/^\[按钮：/.test(t);
}

/**
 * Re-fetch a received interactive card with `card_msg_content_type=raw_card_content`
 * and return its extracted text, or undefined if the fetch fails / yields nothing
 * (caller keeps the degraded content). Best-effort: needs the `im:message` read
 * scope the bot already uses to receive messages.
 */
export async function fetchInteractiveCardText(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  const result = await fetchInteractiveCardContent(channel, messageId);
  return result.text;
}

/**
 * Fetch and assess the source card.  The structured result lets callers keep
 * partial text while also telling codex that the body is incomplete.
 */
export async function fetchInteractiveCardContent(
  channel: LarkChannel,
  messageId: string,
): Promise<InteractiveCardContent> {
  let body: string | undefined;
  try {
    const res = await channel.rawClient.im.v1.message.get({
      path: { message_id: messageId },
      params: { card_msg_content_type: 'raw_card_content' },
    });
    body = (res.data as { items?: { body?: { content?: string } }[] } | undefined)?.items?.[0]?.body?.content;
  } catch (err) {
    log.warn('intake', 'card-content-fetch-failed', { messageId, err: String(err) });
    return { complete: false, reason: 'fetch-failed' };
  }
  if (!body) return { complete: false, reason: 'empty-response' };
  const card = parseRawCardWrapper(body);
  if (card == null) return { complete: false, reason: 'malformed-response' };
  return assessRawCardContent(card);
}
