import type { AgentEvent, ToolKind } from '../types';

/** A record emitted by pi's JSON/RPC session-event stream. */
export type PiRecord = Record<string, any>;

/** The state needed to reconcile one assistant message's streaming blocks. */
interface MessageState {
  id: string;
  blocks: Map<number, BlockState>;
  /** A final block event was already emitted for this content index. */
  finalized: Set<number>;
}

interface BlockState {
  itemId: string;
  kind: 'text' | 'thinking' | 'tool';
  text: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolId?: string;
}

interface PendingError {
  message: string;
  /** Retry notices are visible, but must not become a terminal error. */
  retrying: boolean;
}

export interface PiEventMapper {
  /** Map one raw pi session record to zero or more bridge events. */
  map(record: PiRecord): AgentEvent[];
}

/**
 * Convert pi's RPC/JSON event stream into the bridge's backend-neutral events.
 *
 * Pi deliberately has two completion boundaries. `agent_end` closes one model
 * attempt, while `agent_settled` says that retry, compaction and queued input
 * have all drained. The bridge therefore never emits `done` from `agent_end` or
 * `turn_end`; only `agent_settled` can close this mapper's run.
 */
export function createPiEventMapper(turnId: string): PiEventMapper {
  let messageSeq = 0;
  let currentAssistant: MessageState | undefined;
  let pendingError: PendingError | undefined;
  let lastUsageKey: string | undefined;
  let settled = false;

  const nextItemId = (messageId: string, index: number): string =>
    `pi:${turnId}:${messageId}:${index}`;

  function ensureBlock(message: MessageState, index: number, kind: BlockState['kind']): BlockState {
    const existing = message.blocks.get(index);
    if (existing) {
      // The provider may omit a start event after a reconnect. Preserve the
      // original identity, but learn a more specific kind from later events.
      if (existing.kind === 'text' && kind !== 'text' && existing.text === '') existing.kind = kind;
      return existing;
    }
    const block: BlockState = { itemId: nextItemId(message.id, index), kind, text: '' };
    message.blocks.set(index, block);
    return block;
  }

  function ensureAssistant(): MessageState {
    if (currentAssistant) return currentAssistant;
    const message: MessageState = { id: `m${++messageSeq}`, blocks: new Map(), finalized: new Set() };
    currentAssistant = message;
    return message;
  }

  function setPendingError(message: string, retrying: boolean): void {
    const clean = message.trim();
    if (!clean) return;
    // A terminal-looking error from an earlier low-level attempt is retained
    // until a subsequent retry succeeds or the session settles. A newer final
    // error replaces it; retry notices never erase the useful detail.
    if (!pendingError || !retrying || pendingError.retrying) pendingError = { message: clean, retrying };
  }

  function clearRetryError(): void {
    if (pendingError?.retrying) pendingError = undefined;
  }

  function mapUsage(usage: unknown): AgentEvent[] {
    if (!usage || typeof usage !== 'object') return [];
    const u = usage as Record<string, unknown>;
    const input = numberOrUndefined(u.input);
    const output = numberOrUndefined(u.output);
    if (input === undefined && output === undefined) return [];
    const key = `${input ?? ''}:${output ?? ''}`;
    if (key === lastUsageKey) return [];
    lastUsageKey = key;
    return [{ type: 'usage', inputTokens: input, outputTokens: output }];
  }

  function finalizeBlock(message: MessageState, index: number, block: BlockState, authoritative?: unknown): AgentEvent[] {
    if (message.finalized.has(index)) return [];
    message.finalized.add(index);
    if (block.kind === 'text') {
      const text = typeof authoritative === 'string' ? authoritative : block.text;
      block.text = text;
      return text ? [{ type: 'text', itemId: block.itemId, text }] : [];
    }
    if (block.kind === 'thinking') {
      const text = typeof authoritative === 'string' ? authoritative : block.text;
      block.text = text;
      return text ? [{ type: 'thinking', itemId: block.itemId, text }] : [];
    }
    // A provider-level toolcall_end is a useful reconciliation point when a
    // malformed stream omitted toolcall_start. Normal tool execution is shown
    // by tool_execution_start below, so do not emit a duplicate result here.
    return block.toolName
      ? [{ type: 'tool_use', itemId: block.itemId, title: piToolTitle(block.toolName, block.toolArgs), detail: piToolDetail(block.toolName, block.toolArgs), kind: piToolKind(block.toolName) }]
      : [];
  }

  function mapAssistantMessageEnd(messageValue: unknown): AgentEvent[] {
    const message = asRecord(messageValue);
    if (!message || message.role !== 'assistant') return [];
    const state = currentAssistant ?? ensureAssistant();
    const out: AgentEvent[] = [];
    const content = asArray(message.content);
    content.forEach((part, index) => {
      const block = asRecord(part);
      if (!block) return;
      const type = stringValue(block.type);
      if (type === 'text') {
        const b = ensureBlock(state, index, 'text');
        out.push(...finalizeBlock(state, index, b, typeof block.text === 'string' ? block.text : undefined));
      } else if (type === 'thinking') {
        const b = ensureBlock(state, index, 'thinking');
        out.push(...finalizeBlock(state, index, b, typeof block.thinking === 'string' ? block.thinking : undefined));
      } else if (type === 'toolCall') {
        const b = ensureBlock(state, index, 'tool');
        b.toolName = stringValue(block.name) || b.toolName;
        b.toolArgs = objectValue(block.arguments) ?? b.toolArgs;
        b.toolId = stringValue(block.id) || b.toolId;
        // A toolcall start normally emitted tool_use already. If it did not,
        // this emits exactly one start event with the stable contentIndex id.
        if (!state.finalized.has(index)) {
          state.finalized.add(index);
          out.push({
            type: 'tool_use',
            itemId: b.toolId || b.itemId,
            title: piToolTitle(b.toolName ?? '工具', b.toolArgs),
            detail: piToolDetail(b.toolName ?? '工具', b.toolArgs),
            kind: piToolKind(b.toolName ?? '工具'),
          });
        }
      }
    });
    const assistantError = stringValue(message.errorMessage);
    // A failed model attempt may be followed by Pi's native retry. It is still
    // a final error if the session settles without a successful retry.
    if (assistantError) setPendingError(assistantError, message.stopReason !== 'aborted');
    out.push(...mapUsage(message.usage));
    return out;
  }

  function mapMessageUpdate(record: PiRecord): AgentEvent[] {
    const update = asRecord(record.assistantMessageEvent);
    if (!update) return mapUsage(record.usage);
    const type = stringValue(update.type);
    const index = numberValue(update.contentIndex) ?? 0;
    const state = ensureAssistant();
    const out: AgentEvent[] = [];
    switch (type) {
      case 'text_start': {
        ensureBlock(state, index, 'text');
        break;
      }
      case 'text_delta': {
        const b = ensureBlock(state, index, 'text');
        const delta = stringValue(update.delta);
        if (delta) {
          b.text += delta;
          out.push({ type: 'text_delta', itemId: b.itemId, delta });
        }
        break;
      }
      case 'text_end': {
        const b = ensureBlock(state, index, 'text');
        // The end event carries the authoritative full block. It replaces the
        // streamed buffer under the same itemId, so run-state cannot duplicate it.
        out.push(...finalizeBlock(state, index, b, typeof update.content === 'string' ? update.content : undefined));
        break;
      }
      case 'thinking_start':
        ensureBlock(state, index, 'thinking');
        break;
      case 'thinking_delta': {
        const b = ensureBlock(state, index, 'thinking');
        const delta = stringValue(update.delta);
        if (delta) {
          b.text += delta;
          out.push({ type: 'thinking_delta', itemId: b.itemId, delta });
        }
        break;
      }
      case 'thinking_end': {
        const b = ensureBlock(state, index, 'thinking');
        out.push(...finalizeBlock(state, index, b, typeof update.content === 'string' ? update.content : undefined));
        break;
      }
      case 'toolcall_start': {
        // Pi's start event carries only contentIndex/partial, not a final
        // call id. Wait for toolcall_end so execution can reuse that same id.
        ensureBlock(state, index, 'tool');
        break;
      }
      case 'toolcall_end': {
        const toolCall = asRecord(update.toolCall);
        const b = ensureBlock(state, index, 'tool');
        if (toolCall) {
          b.toolName = stringValue(toolCall.name) || b.toolName;
          b.toolId = stringValue(toolCall.id) || b.toolId;
          b.toolArgs = objectValue(toolCall.arguments) ?? b.toolArgs;
        }
        // If start was present the tool_use has already been emitted. Emit a
        // same-id update only when the final call supplies useful arguments.
        if (b.toolName && !state.finalized.has(index)) {
          state.finalized.add(index);
          out.push({
            type: 'tool_use',
            itemId: b.toolId || b.itemId,
            title: piToolTitle(b.toolName, b.toolArgs),
            detail: piToolDetail(b.toolName, b.toolArgs),
            kind: piToolKind(b.toolName),
          });
        }
        break;
      }
      case 'error': {
        const error = errorText(update.error) || stringValue(update.reason) || 'Pi 模型响应失败';
        const retryable = stringValue(update.reason) !== 'aborted';
        setPendingError(error, retryable);
        if (retryable) out.push({ type: 'error', message: error, willRetry: true });
        break;
      }
      case 'done':
      case 'start':
      default:
        break;
    }
    out.push(...mapUsage(record.usage));
    return out;
  }

  function mapToolStart(record: PiRecord): AgentEvent[] {
    const toolCallId = stringValue(record.toolCallId);
    const toolName = stringValue(record.toolName) || '工具';
    if (!toolCallId) return [];
    const args = objectValue(record.args);
    return [{
      type: 'tool_use',
      itemId: toolCallId,
      title: piToolTitle(toolName, args),
      detail: piToolDetail(toolName, args),
      kind: piToolKind(toolName),
    }];
  }

  function mapToolEnd(record: PiRecord): AgentEvent[] {
    const itemId = stringValue(record.toolCallId);
    if (!itemId) return [];
    const result = asRecord(record.result);
    const output = piResultText(record.result);
    const explicitExit = result ? numberValue(result.exitCode) : undefined;
    const isError = record.isError === true || result?.isError === true;
    const exitCode = explicitExit ?? (isError ? 1 : piToolKind(stringValue(record.toolName) || '') === 'command' ? 0 : undefined);
    return [{ type: 'tool_result', itemId, output, exitCode }];
  }

  function map(record: PiRecord): AgentEvent[] {
    const type = stringValue(record.type);
    if (!type || settled) return [];
    switch (type) {
      case 'agent_start':
        return [];
      case 'turn_start':
        return [{ type: 'turn_started', turnId }];
      case 'turn_end':
        // A turn can be followed by tool work, queued input, retry or compaction.
        return [];
      case 'message_start': {
        const message = asRecord(record.message);
        if (message?.role === 'assistant') {
          currentAssistant = { id: `m${++messageSeq}`, blocks: new Map(), finalized: new Set() };
          const out: AgentEvent[] = [];
          for (const [index, part] of asArray(message.content).entries()) {
            const block = asRecord(part);
            if (!block) continue;
            if (block.type === 'text') ensureBlock(currentAssistant, index, 'text');
            else if (block.type === 'thinking') ensureBlock(currentAssistant, index, 'thinking');
            else if (block.type === 'toolCall') ensureBlock(currentAssistant, index, 'tool');
          }
          return out;
        }
        return [];
      }
      case 'message_update':
        return mapMessageUpdate(record);
      case 'message_end':
        return mapAssistantMessageEnd(record.message);
      case 'tool_execution_start':
        return mapToolStart(record);
      case 'tool_execution_update':
        // Pi's partialResult is a latest snapshot rather than an append-only
        // delta. The normalized run-state has no partial result event, so keep
        // it out of the card and let the raw activity watchdog observe it.
        return [];
      case 'tool_execution_end':
        return mapToolEnd(record);
      case 'auto_retry_start': {
        const message = stringValue(record.errorMessage) || '网络波动，正在重试…';
        setPendingError(message, true);
        return [{ type: 'error', message, willRetry: true }];
      }
      case 'auto_retry_end':
        if (record.success === true) {
          clearRetryError();
          return [];
        }
        setPendingError(stringValue(record.finalError) || pendingError?.message || '自动重试失败', false);
        return [];
      case 'summarization_retry_scheduled': {
        const message = stringValue(record.errorMessage) || '上下文摘要失败，正在重试…';
        setPendingError(message, true);
        return [{ type: 'error', message, willRetry: true }];
      }
      case 'summarization_retry_attempt_start':
        return [];
      case 'summarization_retry_finished':
        clearRetryError();
        return [];
      case 'compaction_start':
        return [{ type: 'context_compacting' }];
      case 'compaction_end': {
        const out: AgentEvent[] = [];
        if (record.aborted === true) return out;
        if (record.result) {
          out.push({ type: 'context_compacted' });
          out.push(...mapUsage(asRecord(record.result)?.usage));
          if (record.willRetry === true) {
            const message = stringValue(record.errorMessage) || '压缩完成，正在重试…';
            setPendingError(message, true);
            out.push({ type: 'error', message, willRetry: true });
          } else {
            clearRetryError();
          }
        } else if (record.errorMessage) {
          const message = stringValue(record.errorMessage) || '上下文压缩失败';
          setPendingError(message, record.willRetry === true);
          out.push({ type: 'error', message, willRetry: true });
        }
        return out;
      }
      case 'extension_error': {
        const extension = stringValue(record.extensionPath) || '扩展';
        const event = stringValue(record.event);
        const detail = errorText(record.error) || '未提供错误详情';
        const message = `${extension}${event ? `（${event}）` : ''}：${detail}`;
        setPendingError(message, false);
        // Keep the failure visible while the session still has to reach its
        // settled boundary. `willRetry: true` is the normalized non-terminal
        // display state; the final error below is emitted at agent_settled.
        return [{ type: 'error', message, willRetry: true }];
      }
      case 'error': {
        const message = errorText(record.error) || stringValue(record.message) || 'Pi 运行失败';
        const willRetry = record.willRetry === true;
        setPendingError(message, willRetry);
        return [{ type: 'error', message, willRetry: true }];
      }
      case 'response':
        if (record.success === false) {
          const message = stringValue(record.error) || `${stringValue(record.command) || 'Pi 命令'}失败`;
          setPendingError(message, false);
          return [{ type: 'error', message, willRetry: true }];
        }
        return [];
      case 'agent_end': {
        if (record.willRetry === true) return [];
        const messages = asArray(record.messages);
        const last = messages.length ? asRecord(messages[messages.length - 1]) : undefined;
        const message = stringValue(last?.errorMessage);
        if (message) setPendingError(message, last?.stopReason !== 'aborted');
        return [];
      }
      case 'agent_settled': {
        settled = true;
        if (pendingError) {
          return [{ type: 'error', message: pendingError.message, willRetry: false }];
        }
        return [{ type: 'done', turnId }];
      }
      default:
        return [];
    }
  }

  return { map };
}

/** Human-readable pi tool title, shared with native history rendering. */
export function piToolTitle(name: string, args?: Record<string, unknown>): string {
  const arg = (key: string): string => stringValue(args?.[key]);
  switch (name.toLowerCase()) {
    case 'bash':
    case 'powershell':
      return arg('command') || arg('cmd') || name;
    case 'read':
      return `读取 ${arg('path') || arg('file_path') || '文件'}`;
    case 'write':
      return `写入 ${arg('path') || arg('file_path') || '文件'}`;
    case 'edit':
      return `编辑 ${arg('path') || arg('file_path') || '文件'}`;
    case 'grep':
      return `搜索 ${arg('pattern') || arg('query') || ''}`.trim();
    case 'find':
      return `查找 ${arg('pattern') || arg('path') || ''}`.trim();
    case 'ls':
      return `列出 ${arg('path') || '目录'}`;
    default:
      return name || '工具调用';
  }
}

export function piToolKind(name: string): ToolKind {
  switch (name.toLowerCase()) {
    case 'bash':
    case 'powershell':
      return 'command';
    case 'read':
    case 'write':
    case 'edit':
      return 'file';
    case 'grep':
    case 'find':
    case 'ls':
      return 'search';
    default:
      return 'tool';
  }
}

function piToolDetail(name: string, args?: Record<string, unknown>): string | undefined {
  const description = stringValue(args?.description);
  if (description) return description;
  const cwd = stringValue(args?.cwd);
  return name.toLowerCase() === 'bash' && cwd ? cwd : undefined;
}

function piResultText(value: unknown): string | undefined {
  const result = asRecord(value);
  const content = result?.content ?? value;
  if (typeof content === 'string') return content || undefined;
  if (Array.isArray(content)) {
    const text = content.map((part) => {
      const block = asRecord(part);
      if (block?.type === 'text') return stringValue(block.text);
      if (block?.type === 'image') return '[图片]';
      return '';
    }).join('').trim();
    if (text) return text;
  }
  if (result?.details !== undefined) {
    try { return JSON.stringify(result.details, null, 2); } catch { return undefined; }
  }
  return undefined;
}

function asRecord(value: unknown): PiRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as PiRecord : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return numberValue(value);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return record;
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  if (record) return stringValue(record.message) || stringValue(record.error) || stringValue(record.name);
  return '';
}
