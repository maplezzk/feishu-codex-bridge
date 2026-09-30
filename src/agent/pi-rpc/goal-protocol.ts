import type { PiRecord } from './event-map';
import type { PiRpcClientLike } from './client';

/** The private bridge-to-pi Goal command channel. */
export const PI_GOAL_PROTOCOL_VERSION = 1 as const;
export const PI_GOAL_COMMAND_PREFIX = '/bridge-goal ';
export const PI_GOAL_NOTIFY_PREFIX = 'BRIDGE_PI_GOAL_V1:';

export type PiGoalAction = 'start' | 'status' | 'clear' | 'cancel';

export interface PiGoalCommandFields {
  requestId: string;
  action: PiGoalAction;
  runId?: string;
  objective?: string;
  tokenBudget?: number;
}

export interface PiGoalSnapshot {
  goalId: string;
  objective: string;
  status: string;
  tokensUsed: number;
  timeUsedSeconds: number;
  tokenBudget: number | null;
  waiting?: unknown;
}

export interface PiGoalReplyData {
  goal: PiGoalSnapshot | null;
  sessionHeader?: unknown;
}

export interface PiGoalReplyRecord {
  version: typeof PI_GOAL_PROTOCOL_VERSION;
  kind: 'reply';
  requestId: string;
  ok: boolean;
  data?: PiGoalReplyData;
  error?: { code: string; message: string };
}

export interface PiGoalStateRecord {
  version: typeof PI_GOAL_PROTOCOL_VERSION;
  kind: 'state';
  runId: string;
  goalId: string;
  objective: string;
  status: string;
  tokensUsed: number;
  timeUsedSeconds: number;
  tokenBudget: number | null;
  waiting?: unknown;
  summary?: string;
  reason?: string;
}

export interface PiGoalErrorRecord {
  version: typeof PI_GOAL_PROTOCOL_VERSION;
  kind: 'error';
  runId?: string;
  requestId?: string;
  error: { code: string; message: string };
}

export type PiGoalRecord = PiGoalReplyRecord | PiGoalStateRecord | PiGoalErrorRecord;

/** A protocol failure that callers can expose without treating it as a normal prompt. */
export class PiGoalProtocolError extends Error {
  readonly code: string;
  readonly runId?: string;

  constructor(code: string, message: string, runId?: string) {
    super(message);
    this.name = 'PiGoalProtocolError';
    this.code = code;
    this.runId = runId;
  }
}

/**
 * Decode only the private notify channel. Ordinary Pi UI notifications are
 * intentionally ignored, so they continue through the normal UI mapper.
 * A malformed prefixed message is returned as a visible protocol error.
 */
export function decodePiGoalRecord(record: PiRecord): PiGoalRecord | undefined {
  if (record.type !== 'extension_ui_request' || record.method !== 'notify') return undefined;
  if (typeof record.message !== 'string' || !record.message.startsWith(PI_GOAL_NOTIFY_PREFIX)) return undefined;
  const raw = record.message.slice(PI_GOAL_NOTIFY_PREFIX.length).trim();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalidRecord('invalid_json', 'Pi Goal 通知不是有效 JSON');
  }
  if (!isRecord(value) || value.version !== PI_GOAL_PROTOCOL_VERSION || typeof value.kind !== 'string') {
    return invalidRecord('invalid_record', 'Pi Goal 通知缺少有效 version/kind');
  }
  if (value.kind === 'reply') {
    if (typeof value.requestId !== 'string' || typeof value.ok !== 'boolean') return invalidRecord('invalid_reply', 'Pi Goal reply 缺少 requestId/ok');
    if (value.ok && !isGoalReplyData(value.data)) return invalidRecord('invalid_reply_data', 'Pi Goal reply 的 data 无效');
    if (!value.ok && !isGoalError(value.error)) return invalidRecord('invalid_reply_error', 'Pi Goal reply 的 error 无效');
    return value as unknown as PiGoalReplyRecord;
  }
  if (value.kind === 'state') {
    if (typeof value.runId !== 'string' || !value.runId || !isGoalState(value)) return invalidRecord('invalid_state', 'Pi Goal state 字段无效');
    return value as unknown as PiGoalStateRecord;
  }
  if (value.kind === 'error') {
    if (!isGoalError(value.error)) return invalidRecord('invalid_error', 'Pi Goal error 字段无效');
    return value as unknown as PiGoalErrorRecord;
  }
  return invalidRecord('unknown_kind', `Pi Goal 通知 kind 不支持：${value.kind}`);
}

/**
 * Send one bridge Goal command and wait for its structured reply. The record
 * listener is installed before prompt so a fast extension cannot race the
 * request. A prompt "handled" response is only an acknowledgement; completion
 * comes from the matching structured reply.
 */
export async function sendPiGoalCommand(
  client: PiRpcClientLike,
  commandFields: PiGoalCommandFields,
  timeoutMs = 20_000,
): Promise<PiGoalReplyData> {
  const payload = encodeCommand(commandFields);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeListener: (() => void) | undefined;
  let removeExit: (() => void) | undefined;
  let settled = false;

  const reply = new Promise<PiGoalReplyData>((resolve, reject) => {
    const finish = (error?: Error, data?: PiGoalReplyData): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      removeListener?.();
      removeExit?.();
      if (error) reject(error);
      else resolve(data!);
    };
    removeListener = client.onRecord((record) => {
      const decoded = decodePiGoalRecord(record);
      if (!decoded) return;
      if (decoded.kind === 'reply') {
        if (decoded.requestId !== commandFields.requestId) return;
        if (decoded.ok) finish(undefined, decoded.data!);
        else finish(new PiGoalProtocolError(decoded.error?.code ?? 'goal_command_failed', decoded.error?.message ?? 'Pi Goal 命令失败', commandFields.runId));
        return;
      }
      if (decoded.kind === 'error') {
        if (decoded.requestId === commandFields.requestId || (!decoded.requestId && (decoded.error.code.startsWith('invalid_') || decoded.error.code === 'unknown_kind'))) {
          finish(new PiGoalProtocolError(decoded.error.code, decoded.error.message, decoded.runId ?? commandFields.runId));
        }
      }
    });
    removeExit = client.onExit((error) => {
      finish(error ?? new PiGoalProtocolError('process_exit', 'Pi Goal 进程已退出', commandFields.runId));
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish(new PiGoalProtocolError('timeout', `Pi Goal ${commandFields.action} 等待回复超时`, commandFields.runId)), timeoutMs);
    }
  });
  // A fast malformed/error notify can reject before the prompt acknowledgement
  // resolves. Attach a handler immediately so the rejection is never reported
  // as an unhandled promise, while the awaited path below still exposes it.
  void reply.catch(() => undefined);

  try {
    const ackPromise = client.request<PiRecord>('prompt', { message: `${PI_GOAL_COMMAND_PREFIX}${payload}` }, timeoutMs);
    void ackPromise.catch(() => undefined);
    // Whichever side fails first must unblock the command immediately. Once the
    // notify succeeds, still await the transport acknowledgement so a broken
    // prompt write cannot be mistaken for a successful Goal command.
    await Promise.race([
      reply.then(() => undefined),
      ackPromise.then(() => undefined, (error: unknown) => { throw toError(error); }),
    ]);
    const response = await ackPromise;
    const disposition = typeof response.disposition === 'string'
      ? response.disposition
      : response.data && typeof response.data === 'object' && typeof response.data.disposition === 'string'
        ? response.data.disposition
        : undefined;
    if (disposition && disposition !== 'handled') {
      throw new PiGoalProtocolError('not_handled', `Pi 未处理 Goal 命令：${disposition}`, commandFields.runId);
    }
  } catch (error) {
    if (!settled) {
      settled = true;
      if (timer) clearTimeout(timer);
      removeListener?.();
      removeExit?.();
    }
    throw toError(error);
  }
  return reply;
}

function encodeCommand(command: PiGoalCommandFields): string {
  return Buffer.from(JSON.stringify(command), 'utf8').toString('base64url');
}

function invalidRecord(code: string, message: string): PiGoalErrorRecord {
  return { version: PI_GOAL_PROTOCOL_VERSION, kind: 'error', error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isGoalError(value: unknown): value is { code: string; message: string } {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string';
}

function isGoalReplyData(value: unknown): value is PiGoalReplyData {
  return isRecord(value) && (value.goal === null || isGoalState(value.goal));
}

function isGoalState(value: unknown): value is PiGoalSnapshot {
  return isRecord(value)
    && typeof value.goalId === 'string'
    && value.goalId.length > 0
    && typeof value.objective === 'string'
    && typeof value.status === 'string'
    && typeof value.tokensUsed === 'number'
    && Number.isFinite(value.tokensUsed)
    && value.tokensUsed >= 0
    && typeof value.timeUsedSeconds === 'number'
    && Number.isFinite(value.timeUsedSeconds)
    && value.timeUsedSeconds >= 0
    && (value.summary === undefined || typeof value.summary === 'string')
    && (value.reason === undefined || typeof value.reason === 'string')
    && (value.tokenBudget === null || (Number.isSafeInteger(value.tokenBudget) && value.tokenBudget > 0));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
