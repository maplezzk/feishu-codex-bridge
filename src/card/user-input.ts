import { randomUUID } from 'node:crypto';
import type { AgentUserInputQuestion, AgentUserInputRequest } from '../agent/types';
import {
  actions,
  card,
  columns,
  form,
  hr,
  input,
  md,
  selectMenu,
  submitButton,
  type CardElement,
  type CardObject,
} from './cards';
import type { CardActionContext, CardDispatcher } from './dispatcher';

/** The one callback action emitted by a Codex user-input card. */
export const USER_INPUT_ACTION = 'codex.question.submit' as const;

export type UserInputLocale = 'zh' | 'en';

/** Where a question card is posted and where validation notices are sent. */
export interface UserInputScope {
  chatId: string;
  replyToMessageId?: string;
  inThread: boolean;
  requesterOpenId?: string;
  /** Bound conversation, including any permission-tier namespace. */
  sessionKey?: string;
  locale?: UserInputLocale;
}

export type UserInputAnswers = Record<string, { answers: string[] }>;

export type UserInputCardStatus = 'pending' | 'submitting' | 'resolved' | 'rejected' | 'failed';

export interface UserInputCardOptions {
  questions: AgentUserInputQuestion[];
  token: string;
  /** Mention on the initial pending card only; updates do not notify again. */
  requesterOpenId?: string;
  recipientOpenIds?: string[];
  locale?: UserInputLocale;
  status?: UserInputCardStatus;
  answers?: UserInputAnswers;
  reason?: string;
}

export interface UserInputServiceDeps {
  recipients?: (scope: UserInputScope) => Promise<string[]>;
  send: (scope: UserInputScope, card: object) => Promise<{ messageId: string }>;
  update: (messageId: string, card: object) => Promise<boolean>;
  notify: (scope: UserInputScope, text: string) => Promise<unknown>;
  /** Current project access; chat/message binding is checked by the service. */
  canSubmit?: (scope: UserInputScope, openId: string) => boolean | Promise<boolean>;
  onError?: (err: unknown, phase: string) => void;
}

export interface UserInputService {
  open(request: AgentUserInputRequest, scope: UserInputScope): Promise<void>;
  register(dispatcher: CardDispatcher): void;
  closeThread(threadId: string, reason: string): Promise<void>;
  closeAll(reason: string): Promise<void>;
}

/** Async input has no outstanding RPC: deliver its answer as a new user input. */
export function createAsyncUserInputRequest(
  event: { threadId: string; turnId: string; itemId: string; questions: AgentUserInputQuestion[] },
  submit: (text: string, responderId?: string) => Promise<void>,
): AgentUserInputRequest {
  let pending = true;
  const listeners = new Set<(reason: string) => void>();
  function finish(reason: string): void {
    if (!pending) throw new Error('user input request is no longer pending');
    pending = false;
    for (const listener of listeners) listener(reason);
    listeners.clear();
  }
  return {
    ...event, requestId: event.itemId, persistsAfterTurn: true,
    isPending: () => pending,
    respond: async (answers, responderId) => {
      finish('responded');
      const text = event.questions.map((q) => `${q.question}\n回答：${answers[q.id]!.answers.join('、')}`).join('\n\n');
      await submit(`用户已回答你的提问：\n\n${text}`, responderId);
    },
    reject: async (reason) => { finish(reason); },
    onResolved: (listener) => {
      if (!pending) { listener('resolved'); return () => undefined; }
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** The normal upper bound for a remote question wait. */
export const DEFAULT_USER_INPUT_TIMEOUT_MS = 30 * 60_000;
/** Do not let malformed or future protocol values create an unbounded timer. */
export const MAX_USER_INPUT_TIMEOUT_MS = DEFAULT_USER_INPUT_TIMEOUT_MS;
const TOMBSTONE_TTL_MS = 5 * 60_000;
const MAX_CUSTOM_TEXT_LENGTH = 1000;

const COPY: Record<UserInputLocale, {
  title: string;
  instructions: string;
  choose: string;
  customOptional: string;
  customPlaceholder: string;
  submit: string;
  submitting: string;
  resolved: string;
  answer: string;
  invalid: string;
  unauthorized: string;
  permissionCheckFailed: string;
  wrongChat: string;
  wrongMessage: string;
  duplicate: string;
  stale: string;
  noOwner: string;
  timeout: string;
  timeoutReject: string;
  secret: string;
  malformed: string;
  sendFailed: string;
  respondFailed: string;
  updateFailed: string;
  closed: string;
  rejected: string;
  genericRejected: string;
}> = {
  zh: {
    title: 'Codex 需要你的回答',
    instructions: '每题选择或填写答案后提交，自填内容优先。',
    choose: '请选择',
    customOptional: '其他答案（可选）',
    customPlaceholder: '输入你的答案',
    submit: '✅ 提交回答',
    submitting: '⏳ 正在提交回答…',
    resolved: '✅ 已收到回答，提问已关闭。',
    answer: '回答',
    invalid: '回答不完整或包含无效选项，请检查后重新提交。',
    unauthorized: '你没有提交这张提问卡答案的权限。',
    permissionCheckFailed: '暂时无法验证你的权限，请稍后再试。',
    wrongChat: '提问卡所属会话不匹配，已忽略这次操作。',
    wrongMessage: '这不是当前提问卡，已忽略这次操作。',
    duplicate: '回答正在提交，请不要重复点击。',
    stale: '这张提问卡已经失效，请等待新的提问卡。',
    noOwner: '提问没有可验证的发起人，出于安全原因不会发送提问卡。本次提问已结束，未提交回答。',
    timeout: '⏱️ 提问已超时，未收到完整回答。',
    timeoutReject: 'user input timed out before a complete answer was received',
    secret: '检测到敏感提问，出于安全原因不会通过飞书发送。本次提问已拒绝，未提交回答。',
    malformed: '提问内容无效，未发送提问卡。本次提问已结束，未提交回答。',
    sendFailed: '提问卡发送失败，已结束这次等待，请回到本机重试。',
    respondFailed: '回答提交失败，提问卡已标记为失败，请回到本机重试。',
    updateFailed: '提问卡状态更新失败，卡片可能仍显示旧状态。',
    closed: '提问已关闭。',
    rejected: '⚠️ 提问已失效，未提交回答。',
    genericRejected: '⚠️ 提问已失效，未提交回答。',
  },
  en: {
    title: 'Codex needs your answer',
    instructions: 'Choose or type an answer for each question. Typed answers take precedence.',
    choose: 'Choose an option',
    customOptional: 'Other answer (optional)',
    customPlaceholder: 'Type your answer',
    submit: '✅ Submit answer',
    submitting: '⏳ Submitting answer…',
    resolved: '✅ Answer received; this question is closed.',
    answer: 'Answer',
    invalid: 'The answer is incomplete or contains an invalid option. Check it and submit again.',
    unauthorized: 'You do not have permission to answer this question.',
    permissionCheckFailed: 'Your access could not be checked. Please try again later.',
    wrongChat: 'This question belongs to another chat. The action was ignored.',
    wrongMessage: 'This is not the current question card. The action was ignored.',
    duplicate: 'The answer is being submitted. Please do not click again.',
    stale: 'This question card has expired. Wait for a new question card.',
    noOwner: 'The question has no verifiable requester, so no card was sent. The question ended without an answer.',
    timeout: '⏱️ The question timed out before a complete answer was received.',
    timeoutReject: 'user input timed out before a complete answer was received',
    secret: 'This question may contain sensitive information, so it will not be sent through Feishu. The question was rejected without an answer.',
    malformed: 'The question payload is invalid. No card was sent; the question ended without an answer.',
    sendFailed: 'The question card could not be sent. The wait has ended; retry from the local machine.',
    respondFailed: 'The answer could not be submitted. The card is marked as failed; retry from the local machine.',
    updateFailed: 'The question card could not be updated and may still show its old state.',
    closed: 'The question was closed.',
    rejected: '⚠️ The question is no longer active; no answer was submitted.',
    genericRejected: '⚠️ The question is no longer active; no answer was submitted.',
  },
};

function localeOf(locale?: UserInputLocale): UserInputLocale {
  return locale === 'en' ? 'en' : 'zh';
}

/** Stable form field names. They contain no user-controlled question id. */
export function questionField(index: number): string {
  return `q${index}_option`;
}

/** Stable custom-answer field names. */
export function customField(index: number): string {
  return `q${index}_custom`;
}

function hasOptions(question: AgentUserInputQuestion): question is AgentUserInputQuestion & {
  options: Array<{ label: string; description: string }>;
} {
  return Array.isArray(question.options) && question.options.length > 0;
}

function optionDisplay(option: { label: string; description: string }): string {
  return option.description ? `${option.label} — ${option.description}` : option.label;
}

function answerLines(
  questions: AgentUserInputQuestion[],
  answers: UserInputAnswers | undefined,
  locale: UserInputLocale,
): string[] {
  if (!answers) return [];
  return questions.flatMap((question) => {
    const value = answers[question.id]?.answers;
    if (!value?.length) return [];
    return [question.question, `${COPY[locale].answer}：${value.join('、')}`];
  });
}

function displayReason(reason: string | undefined, locale: UserInputLocale): string {
  if (!reason) return COPY[locale].genericRejected;
  if (reason === 'timeout' || /timed out|timeout/i.test(reason)) return COPY[locale].timeout;
  if (reason === 'run-ended' || reason === 'thread-closed' || reason === 'closed') return COPY[locale].closed;
  return COPY[locale].genericRejected;
}

/**
 * Build a question card. This function deliberately refuses secret questions:
 * callers should reject those requests before calling the builder, so a future
 * integration cannot accidentally send a redacted-looking copy of a secret.
 */
export function buildUserInputCard(opts: UserInputCardOptions): CardObject {
  const locale = localeOf(opts.locale);
  const text = COPY[locale];
  if (opts.questions.some((question) => question.isSecret)) {
    throw new Error('secret user-input questions cannot be rendered as a Feishu card');
  }

  const status = opts.status ?? 'pending';
  const common: CardElement[] = [];
  if (status === 'pending') {
    const recipients = opts.recipientOpenIds ?? (opts.requesterOpenId ? [opts.requesterOpenId] : []);
    const mention = [...new Set(recipients)].map((id) => `<at id=${id}></at> `).join('');
    common.push(md(`${mention}${text.instructions}`));
  } else if (status === 'submitting') {
    common.push(md(text.submitting));
  } else if (status === 'resolved') {
    common.push(md(text.resolved));
    const lines = answerLines(opts.questions, opts.answers, locale);
    common.push(...lines.map(line => md(line)));
  } else if (status === 'failed') {
    common.push(md(`❌ ${opts.reason ?? text.respondFailed}`));
  } else {
    common.push(md(displayReason(opts.reason, locale)));
  }

  if (status !== 'pending') {
    return card(common, {
      header: { title: text.title, template: status === 'failed' ? 'red' : status === 'resolved' ? 'green' : 'grey' },
      summary: status === 'resolved' ? text.resolved : text.rejected,
      forward: false,
    });
  }

  const formElements: CardElement[] = [];
  for (const [index, question] of opts.questions.entries()) {
    formElements.push(md(question.question));
    const fields: CardElement[] = [];

    if (hasOptions(question)) {
      fields.push({ ...selectMenu({
        name: questionField(index),
        placeholder: text.choose,
        // Values are indexes, never labels. The service resolves them against
        // this original array after validating the callback payload.
        options: question.options.map((option, optionIndex) => ({
          label: optionDisplay(option),
          value: String(optionIndex),
        })),
      }), width: 'fill' });
    }

    if (question.isOther || !hasOptions(question)) {
      fields.push(input({
        name: customField(index),
        placeholder: hasOptions(question) ? text.customOptional : text.customPlaceholder,
        inputType: 'text',
        maxLength: MAX_CUSTOM_TEXT_LENGTH,
        width: 'fill',
        required: !hasOptions(question),
      }));
    }
    formElements.push(fields.length > 1
      ? columns(fields.map((field) => ({ elements: [field], width: 'weighted', weight: 1 })))
      : fields[0]!);
    if (index < opts.questions.length - 1) formElements.push(hr());
  }

  formElements.push(actions([submitButton(text.submit, { a: USER_INPUT_ACTION, token: opts.token })]));
  common.push(form('codex_user_input', formElements));
  return card(common, {
    header: { title: text.title, template: 'blue' },
    summary: text.title,
    forward: false,
    widthMode: 'default',
  });
}

interface ActiveRequest {
  token: string;
  request: AgentUserInputRequest;
  scope: UserInputScope;
  locale: UserInputLocale;
  questions: AgentUserInputQuestion[];
  card: CardObject;
  phase: 'sending' | 'pending' | 'submitting' | 'terminal';
  messageId?: string;
  sendFinished: boolean;
  timer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
  terminalCard?: CardObject;
  answers?: UserInputAnswers;
  answerSubmitted: boolean;
  respondInFlight: boolean;
  finalizing?: Promise<void>;
  rejectStarted: boolean;
  updateQueue: Promise<void>;
}

interface Tombstone {
  scope: UserInputScope;
  locale: UserInputLocale;
  messageId?: string;
  expiresAt: number;
}

function isTerminal(state: ActiveRequest): boolean {
  return state.phase === 'terminal';
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function validQuestionSet(questions: unknown): questions is AgentUserInputQuestion[] {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3) return false;
  const ids = new Set<string>();
  for (const question of questions) {
    if (!question || typeof question.id !== 'string' || question.id.length === 0 || ids.has(question.id)) return false;
    if (typeof question.header !== 'string' || typeof question.question !== 'string') return false;
    if (typeof question.isOther !== 'boolean' || typeof question.isSecret !== 'boolean') return false;
    if (question.options !== null && !Array.isArray(question.options)) return false;
    for (const option of question.options ?? []) {
      if (!option || typeof option.label !== 'string' || typeof option.description !== 'string') return false;
    }
    ids.add(question.id);
  }
  return true;
}

function timeoutFor(request: AgentUserInputRequest): number {
  const requested = request.autoResolutionMs;
  if (requested === null || requested === undefined) return DEFAULT_USER_INPUT_TIMEOUT_MS;
  if (!Number.isFinite(requested) || requested < 0) return DEFAULT_USER_INPUT_TIMEOUT_MS;
  return Math.min(Math.floor(requested), MAX_USER_INPUT_TIMEOUT_MS);
}

function answerValues(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.every((item) => typeof item === 'string') ? value : undefined;
  return typeof value === 'string' ? [value] : undefined;
}

interface ParsedAnswers {
  ok: true;
  answers: UserInputAnswers;
}

interface InvalidAnswers {
  ok: false;
  reason: string;
}

function parseAnswers(
  questions: AgentUserInputQuestion[],
  formValue: Record<string, unknown> | undefined,
  locale: UserInputLocale,
): ParsedAnswers | InvalidAnswers {
  const text = COPY[locale];
  if (!formValue || typeof formValue !== 'object' || Array.isArray(formValue)) return { ok: false, reason: text.invalid };

  const answers: UserInputAnswers = Object.create(null);
  for (const [index, question] of questions.entries()) {
    const customRaw = formValue[customField(index)];
    const custom = typeof customRaw === 'string' ? customRaw.trim() : '';
    // A custom answer is allowed only for an explicit "other" question or a
    // question without options. It wins over any selected option.
    if (custom && (question.isOther || !hasOptions(question))) {
      if (custom.length > MAX_CUSTOM_TEXT_LENGTH) return { ok: false, reason: text.invalid };
      answers[question.id] = { answers: [custom] };
      continue;
    }

    if (!hasOptions(question)) return { ok: false, reason: text.invalid };
    const values = answerValues(formValue[questionField(index)]);
    if (!values?.length) return { ok: false, reason: text.invalid };
    const selected = new Set<number>();
    const labels: string[] = [];
    for (const value of values) {
      // Strict decimal indexes stop a callback from substituting a label or an
      // out-of-range index. Repeated indexes are also rejected explicitly.
      if (!/^(0|[1-9]\d*)$/.test(value)) return { ok: false, reason: text.invalid };
      const optionIndex = Number(value);
      if (!Number.isSafeInteger(optionIndex) || optionIndex < 0 || optionIndex >= question.options.length) {
        return { ok: false, reason: text.invalid };
      }
      if (selected.has(optionIndex)) return { ok: false, reason: text.invalid };
      selected.add(optionIndex);
      labels.push(question.options[optionIndex]!.label);
    }
    answers[question.id] = { answers: labels };
  }
  return { ok: true, answers };
}

function tokenFromContext(ctx: CardActionContext): string | undefined {
  return asString(ctx.value.token);
}

function eventOpenId(ctx: CardActionContext): string | undefined {
  const event = ctx.evt as unknown as { operator?: { openId?: string } };
  return event.operator?.openId;
}

function eventChatId(ctx: CardActionContext): string | undefined {
  return asString((ctx.evt as unknown as { chatId?: unknown }).chatId);
}

function eventMessageId(ctx: CardActionContext): string | undefined {
  return asString((ctx.evt as unknown as { messageId?: unknown }).messageId);
}

function reasonText(reason: string | undefined, fallback: string): string {
  const trimmed = reason?.trim();
  return trimmed ? trimmed.slice(0, 500) : fallback;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const candidate = timer as unknown as { unref?: () => void };
  candidate.unref?.();
}

export function createUserInputService(deps: UserInputServiceDeps): UserInputService {
  const active = new Map<string, ActiveRequest>();
  const requestTokens = new WeakMap<object, string>();
  const tombstones = new Map<string, Tombstone>();
  let registered = false;

  function report(err: unknown, phase: string): void {
    try {
      deps.onError?.(err, phase);
    } catch {
      // An injected diagnostic sink must never break the request lifecycle.
    }
  }

  async function notify(scope: UserInputScope, message: string): Promise<void> {
    try {
      await deps.notify(scope, message);
    } catch (err) {
      report(err, 'notify');
    }
  }

  function isPending(request: AgentUserInputRequest): boolean {
    return request.isPending();
  }

  async function rejectRequest(state: ActiveRequest, reason: string): Promise<void> {
    if (state.rejectStarted || !isPending(state.request)) return;
    state.rejectStarted = true;
    try {
      await state.request.reject(reason);
    } catch (err) {
      report(err, 'reject');
    }
  }

  async function rejectUnsent(
    request: AgentUserInputRequest,
    scope: UserInputScope,
    reason: string,
    notice: string,
  ): Promise<void> {
    if (isPending(request)) {
      try {
        await request.reject(reason);
      } catch (err) {
        report(err, 'reject');
      }
    }
    await notify(scope, notice);
  }

  function addTombstone(state: ActiveRequest): void {
    const tombstone: Tombstone = {
      scope: state.scope,
      locale: state.locale,
      ...(state.messageId ? { messageId: state.messageId } : {}),
      expiresAt: Date.now() + TOMBSTONE_TTL_MS,
    };
    tombstones.set(state.token, tombstone);
    const timer = setTimeout(() => {
      const current = tombstones.get(state.token);
      if (current === tombstone && current.expiresAt <= Date.now()) tombstones.delete(state.token);
    }, TOMBSTONE_TTL_MS + 1);
    unrefTimer(timer);
  }

  function cleanup(state: ActiveRequest): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    try {
      state.unsubscribe?.();
    } catch (err) {
      report(err, 'unsubscribe');
    }
    state.unsubscribe = undefined;
    active.delete(state.token);
    requestTokens.delete(state.request as unknown as object);
    addTombstone(state);
  }

  async function updateCard(state: ActiveRequest, nextCard: CardObject, phase = 'update'): Promise<boolean> {
    if (!state.messageId) return false;
    let ok = false;
    const run = state.updateQueue.then(async () => {
      try {
        ok = await deps.update(state.messageId!, nextCard);
        if (!ok) {
          await notify(state.scope, COPY[state.locale].updateFailed);
          report(new Error('user-input card update returned false'), phase);
        }
      } catch (err) {
        report(err, phase);
        await notify(state.scope, COPY[state.locale].updateFailed);
      }
    });
    state.updateQueue = run.then(() => undefined, () => undefined);
    await run;
    return ok;
  }

  async function refreshPendingCard(state: ActiveRequest): Promise<void> {
    // Managed cards carry a fresh render token on every update. Refreshing the
    // unchanged pending view after a bad submit is therefore significant: the
    // SDK's callback deduplication otherwise drops the user's next attempt for
    // the same form value.
    if (state.phase === 'pending') {
      await updateCard(state, buildUserInputCard({
        questions: state.questions, token: state.token, locale: state.locale,
      }), 'update-invalid');
      if (state.phase === 'pending' && !isPending(state.request)) setTerminal(state, 'rejected', 'resolved');
    }
  }

  async function finalize(state: ActiveRequest): Promise<void> {
    if (!state.terminalCard || !state.sendFinished || !state.messageId) return;
    if (state.finalizing) return state.finalizing;
    state.finalizing = (async () => {
      const queued = state.updateQueue;
      await queued;
      if (state.updateQueue !== queued) await state.updateQueue;
      await updateCard(state, state.terminalCard!, 'update-terminal');
      cleanup(state);
    })();
    await state.finalizing;
  }

  function terminalCard(
    state: ActiveRequest,
    status: Exclude<UserInputCardStatus, 'pending' | 'submitting'>,
    reason?: string,
  ): CardObject {
    return buildUserInputCard({
      questions: state.questions,
      token: state.token,
      locale: state.locale,
      status,
      answers: state.answers,
      reason,
    });
  }

  function setTerminal(
    state: ActiveRequest,
    status: Exclude<UserInputCardStatus, 'pending' | 'submitting'>,
    reason?: string,
  ): void {
    if (state.phase === 'terminal') return;
    state.phase = 'terminal';
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    try {
      state.terminalCard = terminalCard(state, status, reason);
    } catch (err) {
      report(err, 'build-terminal-card');
      state.terminalCard = card([md(status === 'failed' ? COPY[state.locale].respondFailed : COPY[state.locale].genericRejected)], {
        header: { title: COPY[state.locale].title, template: status === 'failed' ? 'red' : 'grey' },
        forward: false,
      });
    }
    void finalize(state);
  }

  function onResolved(state: ActiveRequest, rawReason: string): void {
    if (state.phase === 'terminal') return;
    const reason = reasonText(rawReason, 'resolved');
    // The app-server marks the request resolved before its response write has
    // completed. Wait for respond() so an RPC write failure can still render a
    // failed card and notify the user.
    if (state.respondInFlight) {
      return;
    }
    if (state.answerSubmitted) setTerminal(state, 'resolved', reason);
    else setTerminal(state, 'rejected', reason);
  }

  async function expire(state: ActiveRequest): Promise<void> {
    if (state.phase === 'terminal' || state.respondInFlight || !isPending(state.request)) return;
    const text = COPY[state.locale];
    setTerminal(state, 'rejected', 'timeout');
    await rejectRequest(state, text.timeoutReject);
    await notify(state.scope, text.timeout);
  }

  async function handleSubmit(ctx: CardActionContext): Promise<void> {
    const token = tokenFromContext(ctx);
    const tombstone = token ? tombstones.get(token) : undefined;
    const state = token ? active.get(token) : undefined;
    if (!state) {
      if (tombstone) {
        await notify(tombstone.scope, COPY[tombstone.locale].stale);
      } else {
        const chatId = eventChatId(ctx);
        if (chatId) {
          const messageId = eventMessageId(ctx);
          await notify({
            chatId,
            inThread: false,
            ...(messageId ? { replyToMessageId: messageId } : {}),
          }, COPY.zh.stale);
        }
      }
      return;
    }

    const locale = state.locale;
    const text = COPY[locale];
    const openId = eventOpenId(ctx);
    if (!openId) {
      await notify(state.scope, text.unauthorized);
      return;
    }
    if (eventChatId(ctx) !== state.scope.chatId) {
      await notify(state.scope, text.wrongChat);
      return;
    }
    if (!state.messageId || eventMessageId(ctx) !== state.messageId) {
      await notify(state.scope, text.wrongMessage);
      return;
    }
    try {
      if (deps.canSubmit && !await deps.canSubmit(state.scope, openId)) {
        await notify(state.scope, text.unauthorized);
        return;
      }
    } catch (err) {
      report(err, 'check-submit-access');
      await notify(state.scope, text.permissionCheckFailed);
      await refreshPendingCard(state);
      return;
    }
    // Permission lookup can await: recheck the live request before claiming it.
    if (state.phase === 'submitting') {
      await notify(state.scope, text.duplicate);
      return;
    }
    if (state.phase !== 'pending' || !isPending(state.request)) {
      await notify(state.scope, text.stale);
      return;
    }

    const formValue = ctx.formValue ?? ((ctx.evt as unknown as { action?: { form_value?: Record<string, unknown> } }).action?.form_value);
    const parsed = parseAnswers(state.questions, formValue, locale);
    if (!parsed.ok) {
      await notify(state.scope, parsed.reason);
      await refreshPendingCard(state);
      return;
    }

    state.phase = 'submitting';
    state.answers = parsed.answers;
    const submitting = buildUserInputCard({
      questions: state.questions,
      token: state.token,
      locale,
      status: 'submitting',
    });
    await updateCard(state, submitting, 'update-submitting');

    // Updating the card yields to the callback network. A thread close,
    // timeout, or server resolution can happen during that await; never send a
    // response after such a transition.
    if (state.phase !== 'submitting' || !isPending(state.request)) {
      if (!isTerminal(state)) setTerminal(state, 'rejected', 'resolved');
      return;
    }

    state.answerSubmitted = true;
    state.respondInFlight = true;
    try {
      await state.request.respond(parsed.answers, openId);
      state.respondInFlight = false;
      if (!isTerminal(state)) {
        setTerminal(state, 'resolved', 'responded');
      }
    } catch (err) {
      state.respondInFlight = false;
      report(err, 'respond');
      if (!isTerminal(state)) {
        state.answerSubmitted = false;
        setTerminal(state, 'failed', text.respondFailed);
      }
      await rejectRequest(state, text.respondFailed);
      await notify(state.scope, text.respondFailed);
    }
  }

  function register(dispatcher: CardDispatcher): void {
    if (registered) return;
    registered = true;
    dispatcher.on(USER_INPUT_ACTION, (ctx) => handleSubmit(ctx));
  }

  async function open(request: AgentUserInputRequest, scope: UserInputScope): Promise<void> {
    const locale = localeOf(scope.locale);
    const text = COPY[locale];
    if (!isPending(request)) return;
    if (!validQuestionSet(request.questions)) {
      await rejectUnsent(request, scope, 'invalid user input request', text.malformed);
      return;
    }
    if (request.questions.some((question) => question.isSecret)) {
      await rejectUnsent(request, scope, 'secret user input is not supported by Feishu', text.secret);
      return;
    }
    if (!scope.requesterOpenId) {
      await rejectUnsent(request, scope, 'user input requester is missing', text.noOwner);
      return;
    }
    const existing = requestTokens.get(request as unknown as object);
    if (existing && active.has(existing)) return;

    const token = randomUUID();
    const state: ActiveRequest = {
      token,
      request,
      scope: { ...scope, locale },
      locale,
      questions: request.questions,
      card: buildUserInputCard({ questions: request.questions, token, locale, requesterOpenId: scope.requesterOpenId }),
      phase: 'sending',
      sendFinished: false,
      answerSubmitted: false,
      respondInFlight: false,
      rejectStarted: false,
      updateQueue: Promise.resolve(),
    };
    active.set(token, state);
    requestTokens.set(request as unknown as object, token);
    try {
      state.unsubscribe = request.onResolved((reason) => onResolved(state, reason));
    } catch (err) {
      report(err, 'on-resolved');
    }
    const timeoutTimer = setTimeout(() => { void expire(state); }, timeoutFor(request));
    state.timer = timeoutTimer;
    unrefTimer(timeoutTimer);

    let sent: { messageId: string };
    try {
      if (deps.recipients) {
        const recipientOpenIds = await deps.recipients(state.scope);
        if (!isPending(request) || state.phase === 'terminal') {
          cleanup(state);
          return;
        }
        state.card = buildUserInputCard({ questions: request.questions, token, locale,
          requesterOpenId: scope.requesterOpenId, recipientOpenIds });
      }
      sent = await deps.send(state.scope, state.card);
      if (!sent || typeof sent.messageId !== 'string' || sent.messageId.length === 0) {
        throw new Error('user-input send returned no messageId');
      }
    } catch (err) {
      state.sendFinished = true;
      report(err, 'send');
      await rejectRequest(state, text.sendFailed);
      await notify(state.scope, text.sendFailed);
      cleanup(state);
      return;
    }

    state.messageId = sent.messageId;
    state.sendFinished = true;
    if (state.phase === 'sending') state.phase = 'pending';
    if (state.terminalCard) await finalize(state);
  }

  async function closeThread(threadId: string, reason: string): Promise<void> {
    const closing = [...active.values()].filter((state) => state.request.threadId === threadId &&
      !(reason === 'run-ended' && state.request.persistsAfterTurn));
    await Promise.all(closing.map(async (state) => {
      if (state.phase === 'terminal') return;
      const resolvedReason = reasonText(reason, 'thread closed');
      setTerminal(state, 'rejected', reason || 'thread-closed');
      await rejectRequest(state, resolvedReason);
      await notify(state.scope, COPY[state.locale].closed);
    }));
  }

  async function closeAll(reason: string): Promise<void> {
    await Promise.all([...new Set([...active.values()].map((state) => state.request.threadId))]
      .map((threadId) => closeThread(threadId, reason)));
  }

  return { open, register, closeThread, closeAll };
}
