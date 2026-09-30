import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { log } from '../../core/logger';
import type {
  AgentEvent,
  AgentInput,
  AgentRun,
  AgentThread,
  AgentUserInputQuestion,
  AgentUserInputRequest,
  CompactResult,
  ReasoningEffort,
  TurnOptions,
} from '../types';
import { createPiEventMapper } from './event-map';
import type { PiRecord } from './event-map';
import type { PiRpcClientLike } from './client';
import {
  decodePiGoalRecord,
  sendPiGoalCommand,
  type PiGoalReplyData,
  type PiGoalStateRecord,
} from './goal-protocol';

export interface PiThreadConfig {
  client: PiRpcClientLike;
  sessionId: string;
  cwd: string;
  model?: string;
  effort?: ReasoningEffort;
}

type QueueValue = AgentEvent;

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined as never, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

interface ActiveRun {
  runId: string;
  queue: AsyncQueue<QueueValue>;
  unsubscribeRecord: () => void;
  unsubscribeExit: () => void;
  mapper: { map(record: PiRecord): AgentEvent[] };
  settled: boolean;
  settling: boolean;
  pendingFailure?: Extract<AgentEvent, { type: 'error' }>;
}

interface ActiveGoalRun {
  runId: string;
  objective: string;
  queue: AsyncQueue<QueueValue>;
  unsubscribeRecord: () => void;
  unsubscribeExit: () => void;
  mapper?: { map(record: PiRecord): AgentEvent[] };
  currentTurnId?: string;
  turnSettled: boolean;
  turnDoneEmitted: boolean;
  terminal?: PiGoalStateRecord;
  clearRequested: boolean;
  cancelRequested: boolean;
  starting: boolean;
  settled: boolean;
  pendingFailure?: Extract<AgentEvent, { type: 'error' }>;
}

interface PendingUi {
  request: AgentUserInputRequest;
  pending: boolean;
  resolvedReason?: string;
  listeners: Set<(reason: string) => void>;
}

const CONTROL_TIMEOUT_MS = 20_000;
const COMPACT_TIMEOUT_MS = 120_000;
const ABORT_TIMEOUT_MS = 5_000;

/** A single isolated pi RPC process and one durable pi session. */
export class PiThread implements AgentThread {
  readonly sessionId: string;
  readonly supportsSteer = true;
  private readonly client: PiRpcClientLike;
  private readonly cwd: string;
  private model: string | undefined;
  private effort: ReasoningEffort | undefined;
  private active: ActiveRun | undefined;
  private activeGoal: ActiveGoalRun | undefined;
  private readonly pendingUi = new Map<string, PendingUi>();
  private readonly ignoredUiMethods = new Set<string>();
  private dead = false;
  private closed = false;

  constructor(config: PiThreadConfig) {
    this.client = config.client;
    this.sessionId = config.sessionId;
    this.cwd = config.cwd;
    this.model = config.model;
    this.effort = config.effort;
  }

  runStreamed(input: AgentInput, turn?: TurnOptions): AgentRun {
    if (this.closed || this.dead || !this.client.isAlive()) throw new Error('pi 会话进程已结束，无法开始新一轮');
    if ((this.active && !this.active.settled) || (this.activeGoal && !this.activeGoal.settled)) throw new Error('pi 会话已有运行中的一轮，不能并发发送');

    const runId = randomUUID();
    const queue = new AsyncQueue<QueueValue>();
    const active: ActiveRun = {
      runId,
      queue,
      unsubscribeRecord: () => undefined,
      unsubscribeExit: () => undefined,
      mapper: createPiEventMapper(runId),
      settled: false,
      settling: false,
    };
    this.active = active;

    // Install both listeners before issuing prompt. Pi can complete a handled
    // extension command before the prompt response reaches the caller.
    active.unsubscribeRecord = this.client.onRecord((record) => this.onRecord(active, record));
    active.unsubscribeExit = this.client.onExit((error) => {
      if (this.active !== active || active.settled) return;
      this.dead = true;
      if (active.settling) {
        // The settled terminal event is already queued. A later process exit
        // while the optional stats query is in flight must not add a second
        // terminal error or turn a successful run into a false failure.
        this.finish(active);
        return;
      }
      active.queue.push(active.pendingFailure ?? { type: 'error', message: error?.message ?? 'pi 会话进程已退出', willRetry: false });
      this.finish(active);
    });

    const self = this;
    const start = async (): Promise<void> => {
      try {
        await this.applyTurnOptions(turn);
        const fields: PiRecord = { message: input.text ?? '' };
        const images = await imageContents(input.images ?? []);
        if (images.length) fields.images = images;
        const response = await this.client.request<PiRecord>('prompt', fields, CONTROL_TIMEOUT_MS);
        const disposition = readDisposition(response);
        if (disposition === 'handled') {
          // A handled extension command did not create an agent run. Close this
          // bridge run synthetically so the card cannot wait forever.
          this.onRecord(active, { type: 'agent_settled', disposition: 'handled' });
        }
      } catch (error) {
        if (this.active !== active || active.settled) return;
        active.queue.push(active.pendingFailure ?? { type: 'error', message: toError(error).message, willRetry: false });
        this.finish(active);
      }
    };
    void start();

    async function* events(): AsyncGenerator<AgentEvent> {
      try {
        while (true) {
          const next = await active.queue.next();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        // A caller may stop consuming before the backend reaches settled. Do
        // not leave pi streaming in the background after that early return.
        if (self.active === active && !active.settled) {
          try {
            await self.abortAndWait(active);
          } catch (error) {
            log.fail('agent', error, { backend: 'pi-rpc', phase: 'stream/consumer-closed' });
            await self.terminateAfterAbort(active, toError(error), false);
          }
        }
        self.finish(active);
      }
    }

    return {
      events: events(),
      turnId: () => runId,
      lastActivity: () => this.client.lastActivity(),
    };
  }

  runGoal(objective: string): AgentRun {
    if (this.closed || this.dead || !this.client.isAlive()) throw new Error('pi 会话进程已结束，无法开始 Goal');
    if ((this.active && !this.active.settled) || (this.activeGoal && !this.activeGoal.settled)) throw new Error('pi 会话已有运行中的一轮，不能并发开始 Goal');
    const runId = randomUUID();
    const active: ActiveGoalRun = {
      runId,
      objective,
      queue: new AsyncQueue<QueueValue>(),
      unsubscribeRecord: () => undefined,
      unsubscribeExit: () => undefined,
      turnSettled: true,
      turnDoneEmitted: false,
      clearRequested: false,
      cancelRequested: false,
      starting: true,
      settled: false,
    };
    this.activeGoal = active;

    // Goal protocol notifications must be observed before the first command.
    // The extension can answer a handled prompt synchronously and then start
    // the first agent turn, so this listener owns the whole long-lived stream.
    active.unsubscribeRecord = this.client.onRecord((record) => this.onGoalRecord(active, record));
    active.unsubscribeExit = this.client.onExit((error) => {
      if (this.activeGoal !== active || active.settled) return;
      this.dead = true;
      active.queue.push(active.pendingFailure ?? { type: 'error', message: error?.message ?? 'pi 会话进程已退出', willRetry: false });
      this.finishGoal(active);
    });

    const start = async (): Promise<void> => {
      try {
        if (active.settled || active.clearRequested) return;
        const status = await this.sendGoalCommand(active, 'status');
        if (active.settled || active.clearRequested) return;
        const old = status.goal;
        if (old && normalizeGoalStatus(old.status) !== 'active') {
          // A restored or stopped goal is outside this new managed run. Clear
          // it without borrowing the new runId before acquiring ownership.
          await sendPiGoalCommand(this.client, { action: 'clear', requestId: randomUUID() }, CONTROL_TIMEOUT_MS);
        }
        if (active.settled || active.clearRequested) return;
        active.starting = false;
        await this.sendGoalCommand(active, 'start', { objective });
      } catch (error) {
        if (this.activeGoal !== active || active.settled) return;
        const failure = { type: 'error' as const, message: `Pi Goal 启动失败：${toError(error).message}`, willRetry: false };
        active.pendingFailure = failure;
        active.queue.push(failure);
        this.finishGoal(active);
      }
    };
    void start();

    const self = this;
    async function* events(): AsyncGenerator<AgentEvent> {
      try {
        while (true) {
          const next = await active.queue.next();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        if (self.activeGoal === active && !active.settled) {
          try {
            await self.stopGoalRun(active, true);
          } catch (error) {
            log.fail('agent', error, { backend: 'pi-rpc', phase: 'goal/stream-consumer-closed' });
            await self.terminateAfterGoal(active, toError(error), false);
          }
        }
        // Fatal mapping/provider errors can end the stream while the plugin
        // still owns an active goal. Clear even after local settlement so a
        // later ordinary message cannot silently revive that goal.
        if (self.activeGoal === active && !active.starting && self.client.isAlive()) {
          try {
            await self.sendGoalCommand(active, 'clear');
          } catch (error) {
            log.fail('agent', error, { backend: 'pi-rpc', phase: 'goal/final-cleanup' });
            await self.terminateAfterGoal(active, toError(error), false);
          }
        }
        self.finishGoal(active);
      }
    }

    return {
      events: events(),
      turnId: () => active.currentTurnId ?? active.runId,
      lastActivity: () => this.client.lastActivity(),
    };
  }

  async clearGoal(expectedRunId?: string): Promise<void> {
    const active = this.activeGoal;
    if (!active || active.settled) return;
    if (expectedRunId && expectedRunId !== active.runId) throw new Error('pi Goal 的 run ID 已过期，不能清理当前目标');
    active.clearRequested = true;
    if (active.starting) {
      // No start command has crossed the wire, so the plugin does not own this
      // ID. The pending status path checks clearRequested before starting.
      this.finishGoal(active);
      return;
    }
    try {
      await this.sendGoalCommand(active, 'clear');
    } catch (error) {
      const failure = { type: 'error' as const, message: `Pi Goal 清理失败：${toError(error).message}`, willRetry: false };
      active.queue.push(failure);
      active.pendingFailure = failure;
      this.finishGoal(active);
      throw error;
    }
    // Clear does not interrupt an active turn. An idle/waiting goal can end
    // immediately after the clear acknowledgement; a running turn settles via
    // agent_settled and preserves its final text/tool events first.
    if (!active.mapper || active.turnSettled) this.finishGoal(active);
  }

  async steer(input: AgentInput, expectedTurnId: string): Promise<void> {
    if (this.activeGoal && !this.activeGoal.settled) {
      const goal = this.requireGoalTurn(expectedTurnId, 'steer');
      const fields: PiRecord = { message: input.text ?? '' };
      const images = await imageContents(input.images ?? []);
      if (images.length) fields.images = images;
      if (this.requireGoalTurn(expectedTurnId, 'steer') !== goal) throw new Error('pi Goal steer 的运行轮次已经结束');
      await this.client.request('steer', fields, CONTROL_TIMEOUT_MS);
      if (this.activeGoal !== goal) throw new Error('pi Goal steer 期间运行轮次已经结束');
      return;
    }
    const active = this.requireRun(expectedTurnId, 'steer');
    const fields: PiRecord = { message: input.text ?? '' };
    const images = await imageContents(input.images ?? []);
    if (images.length) fields.images = images;
    // File I/O may have outlived the original run. Check before sending the
    // side effect, otherwise a stale card can steer the next run.
    if (this.requireRun(expectedTurnId, 'steer') !== active) throw new Error('pi steer 的运行轮次已经结束');
    await this.client.request('steer', fields, CONTROL_TIMEOUT_MS);
    if (this.active !== active) throw new Error('pi steer 期间运行轮次已经结束');
  }

  async abort(expectedTurnId: string): Promise<void> {
    if (this.activeGoal && !this.activeGoal.settled) {
      const goal = this.requireGoalTurn(expectedTurnId, 'abort');
      try {
        await this.stopGoalRun(goal, true);
      } catch (error) {
        log.fail('agent', error, { backend: 'pi-rpc', phase: 'goal/abort' });
        await this.terminateAfterGoal(goal, toError(error), true);
      }
      return;
    }
    const active = this.requireRun(expectedTurnId, 'abort');
    try {
      await this.abortAndWait(active);
    } catch (error) {
      // A stuck tool can prevent the abort response. Kill the detached process
      // group so the bridge never leaves an orphaned pi tree behind.
      log.fail('agent', error, { backend: 'pi-rpc', phase: 'abort' });
      await this.terminateAfterAbort(active, toError(error), true);
    }
  }

  async compact(): Promise<CompactResult> {
    if (this.closed || this.dead || !this.client.isAlive()) throw new Error('pi 会话进程已结束，无法压缩');
    if ((this.active && !this.active.settled) || (this.activeGoal && !this.activeGoal.settled)) throw new Error('pi 当前仍在运行，不能开始压缩');
    let result: PiRecord;
    try {
      result = await this.client.request<PiRecord>('compact', {}, COMPACT_TIMEOUT_MS);
    } catch (error) {
      if (toError(error).message !== 'Nothing to compact (session too small)') throw error;
      log.info('agent', 'pi-compact-not-needed', { reason: 'session-too-small' });
      return { compacted: false, usage: null };
    }
    const usage = recordUsage(result);
    const compacted = Boolean(result.compacted ?? result.summary ?? result.firstKeptEntryId ?? result.tokensBefore ?? result.success);
    return { compacted, usage };
  }

  isAlive(): boolean {
    return !this.closed && !this.dead && this.client.isAlive();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const activeGoal = this.activeGoal;
    if (activeGoal && !activeGoal.settled) {
      try {
        await this.stopGoalRun(activeGoal, false);
      } catch (error) {
        log.fail('agent', error, { backend: 'pi-rpc', phase: 'goal/close' });
      }
    }
    this.closed = true;
    this.dead = true;
    for (const pending of [...this.pendingUi.values()]) {
      // Cancel local questions immediately. A blocked stdin must not delay
      // the bounded process-group cleanup below.
      void this.resolveUi(pending, 'thread-closed', true).catch((error: unknown) => {
        log.fail('agent', error, { backend: 'pi-rpc', phase: 'ui/close' });
      });
    }
    const active = this.active;
    if (active && !active.settled) {
      active.queue.push({ type: 'error', message: 'pi 会话已关闭', willRetry: false });
      this.finish(active);
    }
    if (activeGoal && !activeGoal.settled) {
      activeGoal.queue.push({ type: 'error', message: 'pi 会话已关闭', willRetry: false });
      this.finishGoal(activeGoal);
    }
    await this.client.close();
  }

  private onRecord(active: ActiveRun, record: PiRecord): void {
    if (this.active !== active || active.settled) return;
    if (active.settling) return;
    if (record.type === 'extension_ui_request') {
      this.handleUiRequest(active, record);
      return;
    }
    try {
      const events = active.mapper.map(record);
      for (const event of events) {
        if (event.type === 'error' && !event.willRetry) {
          // The mapper holds attempt failures until agent_settled. Its final
          // error is already the terminal event and must reach the consumer.
          if (record.type === 'agent_settled') active.queue.push(event);
          else active.pendingFailure = event;
        }
        else active.queue.push(event);
      }
    } catch (error) {
      active.pendingFailure = { type: 'error', message: `pi 事件转换失败：${toError(error).message}`, willRetry: false };
      active.queue.push(active.pendingFailure);
      this.finish(active);
      return;
    }
    if (record.type === 'agent_settled') {
      active.settling = true;
      void this.finishSettled(active);
    }
  }

  private onGoalRecord(active: ActiveGoalRun, record: PiRecord): void {
    if (this.activeGoal !== active || active.settled) return;
    const protocol = decodePiGoalRecord(record);
    if (protocol) {
      if (protocol.kind === 'state') {
        if (protocol.runId !== active.runId) return;
        this.acceptGoalState(active, protocol);
      } else if (protocol.kind === 'error') {
        if (protocol.runId && protocol.runId !== active.runId) return;
        const failure = { type: 'error' as const, message: `Pi Goal：${protocol.error.message}`, willRetry: false };
        active.pendingFailure = failure;
        active.queue.push(failure);
        if (active.turnSettled) this.finishGoal(active);
      }
      // Replies belong to sendPiGoalCommand's request listener. They are never
      // ordinary UI notifications and must not synthesize a settled turn.
      return;
    }
    if (record.type === 'extension_ui_request') {
      this.handleUiRequest(active, record);
      return;
    }
    // The transport response acknowledges prompt/control delivery. It is not a
    // Pi agent turn and must not create the fallback mapper before agent_start.
    if (record.type === 'response') return;

    if (record.type === 'agent_start') {
      const turnId = randomUUID();
      active.currentTurnId = turnId;
      active.mapper = createPiEventMapper(turnId);
      active.turnSettled = false;
      active.turnDoneEmitted = false;
      active.pendingFailure = undefined;
      active.queue.push({ type: 'turn_started', turnId });
      return;
    }

    try {
      const mapper = active.mapper ?? this.ensureGoalMapper(active);
      const events = mapper.map(record);
      for (const event of events) {
        // The mapper emits turn_started for turn_start. Goal ownership is
        // agent_start, so suppress the duplicate while keeping all content and
        // tool events associated with the current turn id.
        if (event.type === 'turn_started') continue;
        if (event.type === 'done') active.turnDoneEmitted = true;
        if (event.type === 'error' && !event.willRetry) active.pendingFailure = event;
        active.queue.push(event);
      }
    } catch (error) {
      const failure = { type: 'error' as const, message: `pi Goal 事件转换失败：${toError(error).message}`, willRetry: false };
      active.pendingFailure = failure;
      active.queue.push(failure);
      this.finishGoal(active);
      return;
    }

    if (record.type === 'agent_settled') {
      active.turnSettled = true;
      active.mapper = undefined;
      // If a fixture/provider emits agent_settled without agent_start, the
      // fallback mapper above still gives the caller a correctly identified
      // final turn. Do not leave the Goal stream waiting forever.
      if (!active.turnDoneEmitted && !active.pendingFailure) {
        active.turnDoneEmitted = true;
        active.queue.push({ type: 'done', turnId: active.currentTurnId ?? active.runId });
      }
      if (active.terminal || active.clearRequested || active.cancelRequested || active.pendingFailure) this.finishGoal(active);
    }
  }

  private ensureGoalMapper(active: ActiveGoalRun): { map(record: PiRecord): AgentEvent[] } {
    if (active.mapper) return active.mapper;
    const turnId = active.currentTurnId ?? active.runId;
    active.currentTurnId = turnId;
    active.mapper = createPiEventMapper(turnId);
    active.turnSettled = false;
    active.turnDoneEmitted = false;
    return active.mapper;
  }

  private acceptGoalState(active: ActiveGoalRun, state: PiGoalStateRecord): void {
    const normalized: PiGoalStateRecord = { ...state, status: normalizeGoalStatus(state.status) };
    if (active.starting && isGoalStopStatus(normalized.status)) return;
    active.queue.push({
      type: 'goal_update',
      status: normalized.status === 'active' && normalized.waiting ? 'waiting' : normalized.status,
      objective: normalized.objective,
      // These values are the plugin's cumulative Goal counters. Never derive
      // them from a single turn's usage events.
      tokensUsed: normalized.tokensUsed,
      timeUsedSeconds: normalized.timeUsedSeconds,
      tokenBudget: normalized.tokenBudget,
    });
    if (isGoalStopStatus(normalized.status)) {
      if (!active.terminal && normalized.summary) {
        active.queue.push({ type: 'text', itemId: `goal-summary-${active.runId}`, text: normalized.summary });
      }
      active.terminal = normalized;
      if (active.turnSettled) {
        if (!active.turnDoneEmitted) {
          active.turnDoneEmitted = true;
          active.queue.push({ type: 'done', turnId: active.currentTurnId ?? active.runId });
        }
        this.finishGoal(active);
      }
    }
  }

  private async sendGoalCommand(
    active: ActiveGoalRun,
    action: 'start' | 'status' | 'clear' | 'cancel',
    fields: { objective?: string; tokenBudget?: number } = {},
  ): Promise<PiGoalReplyData> {
    const requestId = `goal-${active.runId}-${randomUUID()}`;
    const response = await sendPiGoalCommand(this.client, {
      requestId,
      action,
      runId: active.runId,
      ...fields,
    }, CONTROL_TIMEOUT_MS);
    if (response.goal && !active.settled && (action === 'start' || action === 'cancel' || action === 'clear')) {
      this.acceptGoalState(active, {
        version: 1,
        kind: 'state',
        runId: active.runId,
        ...response.goal,
        status: normalizeGoalStatus(response.goal.status),
      });
    }
    return response;
  }

  private async stopGoalRun(active: ActiveGoalRun, abort: boolean): Promise<void> {
    if (active.settled) return;
    active.clearRequested = true;
    if (active.starting) {
      this.finishGoal(active);
      return;
    }
    // Both user actions clear the persistent Goal first. abort then additionally
    // interrupts the current Pi turn, preventing a late native continuation.
    await this.sendGoalCommand(active, 'clear');
    if (!abort || active.turnSettled) {
      if (active.turnSettled) this.finishGoal(active);
      return;
    }
    active.cancelRequested = true;
    await this.client.request('clear_queue', {}, ABORT_TIMEOUT_MS).catch((error: unknown) => {
      log.fail('agent', error, { backend: 'pi-rpc', phase: 'goal/abort/clear-queue' });
    });
    if (active.settled || active.turnSettled) {
      this.finishGoal(active);
      return;
    }
    await this.client.request('abort', {}, ABORT_TIMEOUT_MS);
    if (active.settled || active.turnSettled) {
      this.finishGoal(active);
      return;
    }
    if (!await waitForGoalTurnSettled(active, ABORT_TIMEOUT_MS)) throw new Error('pi Goal 取消已收到响应，但未在限定时间内收到 agent_settled');
    this.finishGoal(active);
  }

  private async terminateAfterGoal(active: ActiveGoalRun, cause: Error, emitError: boolean): Promise<void> {
    this.dead = true;
    if (!active.settled) {
      if (emitError) active.queue.push({ type: 'error', message: `pi Goal 取消超时，已结束会话进程：${cause.message}`, willRetry: false });
      this.finishGoal(active);
    }
    try {
      await this.client.close(1_000);
    } catch (error) {
      log.fail('agent', error, { backend: 'pi-rpc', phase: 'goal/abort/close' });
    }
  }

  private async finishSettled(active: ActiveRun): Promise<void> {
    if (this.active !== active || active.settled) return;
    try {
      const stats = await this.client.request<PiRecord>('get_session_stats', {}, CONTROL_TIMEOUT_MS);
      if (this.active === active && !active.settled) {
        const usage = contextUsageEvent(stats);
        if (usage) active.queue.push(usage);
      }
    } catch (error) {
      if (this.active === active && !active.settled) {
        log.fail('agent', error, { backend: 'pi-rpc', phase: 'settled/get-session-stats' });
      }
    } finally {
      this.finish(active);
    }
  }

  private finishGoal(active: ActiveGoalRun): void {
    if (active.settled) return;
    active.settled = true;
    active.unsubscribeRecord();
    active.unsubscribeExit();
    for (const pending of [...this.pendingUi.values()]) {
      if (pending.request.turnId !== active.runId && pending.request.turnId !== active.currentTurnId) continue;
      void this.resolveUi(pending, 'goal-ended', true).catch((error: unknown) => {
        log.fail('agent', error, { backend: 'pi-rpc', phase: 'goal/ui-ended' });
      });
    }
    active.queue.end();
  }

  private finish(active: ActiveRun): void {
    if (active.settled) return;
    active.settled = true;
    active.unsubscribeRecord();
    active.unsubscribeExit();
    // Pi may settle while an extension UI request is still visible. Resolve
    // those requests as cancelled so the caller's card does not hang forever.
    for (const pending of [...this.pendingUi.values()]) {
      if (pending.request.turnId !== active.runId) continue;
      void this.resolveUi(pending, 'turn-ended', true).catch((error: unknown) => {
        log.fail('agent', error, { backend: 'pi-rpc', phase: 'ui/turn-ended' });
      });
    }
    active.queue.end();
  }

  private async abortAndWait(active: ActiveRun): Promise<void> {
    await this.client.request('clear_queue', {}, ABORT_TIMEOUT_MS).catch((error: unknown) => {
      // clear_queue is best effort. Still send abort so a queued tool cannot
      // keep the run alive merely because the queue snapshot failed.
      log.fail('agent', error, { backend: 'pi-rpc', phase: 'abort/clear-queue' });
    });
    if (active.settled) return;
    await this.client.request('abort', {}, ABORT_TIMEOUT_MS);
    if (active.settled) return;
    if (!await waitForRunSettled(active, ABORT_TIMEOUT_MS)) {
      throw new Error('pi 取消已收到响应，但未在限定时间内收到 agent_settled');
    }
  }

  private async terminateAfterAbort(active: ActiveRun, cause: Error, emitError: boolean): Promise<void> {
    this.dead = true;
    if (!active.settled) {
      if (emitError) active.queue.push({ type: 'error', message: `pi 取消超时，已结束会话进程：${cause.message}`, willRetry: false });
      this.finish(active);
    }
    try {
      await this.client.close(1_000);
    } catch (error) {
      log.fail('agent', error, { backend: 'pi-rpc', phase: 'abort/close' });
    }
  }

  private requireRun(expectedTurnId: string, action: string): ActiveRun {
    if (!this.active || this.active.settled || this.active.runId !== expectedTurnId) {
      throw new Error(`pi ${action} 的 run ID 已过期，不能影响当前轮次`);
    }
    return this.active;
  }

  private requireGoalTurn(expectedTurnId: string, action: string): ActiveGoalRun {
    const active = this.activeGoal;
    const current = active?.currentTurnId ?? active?.runId;
    if (!active || active.settled || current !== expectedTurnId || (active.currentTurnId && active.turnSettled)) {
      throw new Error(`pi Goal ${action} 的 run ID 已过期，不能影响当前轮次`);
    }
    return active;
  }

  private async applyTurnOptions(turn?: TurnOptions): Promise<void> {
    if (!turn) return;
    let changed = false;
    if (turn.model && turn.model !== this.model) {
      const { provider, modelId } = splitModel(turn.model);
      await this.client.request('set_model', { provider, modelId }, CONTROL_TIMEOUT_MS);
      changed = true;
      // Pi applies per-model defaults and clamps the level during set_model.
      // Invalidate the old effort before deciding whether another set is needed.
      this.model = undefined;
      this.effort = undefined;
      await this.refreshOptions();
      if (this.model !== turn.model) throw new Error(`pi 模型回读不一致：期望 ${turn.model}，实际 ${this.model ?? '缺失'}`);
    }
    if (turn.effort && turn.effort !== this.effort) {
      const level = toPiThinkingLevel(turn.effort);
      const available = await this.client.request<PiRecord>('get_available_thinking_levels', {}, CONTROL_TIMEOUT_MS);
      const levels = Array.isArray(available.levels) ? available.levels.map(String) : [];
      if (!levels.includes(level)) {
        throw new Error(`pi 当前模型不支持思考档位「${turn.effort}」（可用：${levels.join('、') || '未返回'}）`);
      }
      await this.client.request('set_thinking_level', { level }, CONTROL_TIMEOUT_MS);
      changed = true;
    }
    if (changed) {
      await this.refreshOptions();
      if (turn.effort && this.effort !== turn.effort) throw new Error(`pi 思考档位回读不一致：期望 ${turn.effort}，实际 ${this.effort ?? '缺失'}`);
    }
  }

  private async refreshOptions(): Promise<void> {
    const response = await this.client.request<PiRecord>('get_state', {}, CONTROL_TIMEOUT_MS);
    const state = response.data && typeof response.data === 'object' ? response.data as PiRecord : response;
    const model = state.model;
    this.model = model && typeof model.id === 'string'
      ? `${model.provider ? `${model.provider}/` : ''}${model.id}` : undefined;
    const level = state.thinkingLevel;
    this.effort = level === 'off' ? 'none' : ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level) ? level : undefined;
  }

  private handleUiRequest(active: ActiveRun | ActiveGoalRun, record: PiRecord): void {
    const id = typeof record.id === 'string' ? record.id : '';
    const method = typeof record.method === 'string' ? record.method : '';
    if (!id) return;
    if (['setStatus', 'setWidget', 'setTitle', 'set_editor_text', 'notify'].includes(method)) {
      // These are one-way TUI display updates. They do not await a response
      // and are not failed interaction requests. Keep unsupported display
      // methods visible in diagnostics without adding fake errors to cards.
      if (!this.ignoredUiMethods.has(method)) {
        this.ignoredUiMethods.add(method);
        log.info('agent', 'pi-ui-display-not-forwarded', { method });
      }
      if (method === 'notify' && ['warning', 'error'].includes(record.notifyType)) {
        log.warn('agent', 'pi-extension-notification', { level: record.notifyType });
        active.queue.push({ type: 'error', message: `pi 扩展通知：${String(record.message ?? record.notifyType)}`, willRetry: true });
      }
      return;
    }
    if (!['select', 'confirm', 'input'].includes(method)) {
      void this.client.write({ type: 'extension_ui_response', id, cancelled: true }).catch((error: unknown) => {
        log.fail('agent', error, { backend: 'pi-rpc', phase: 'ui/cancel-unsupported', id });
      });
      active.queue.push({ type: 'error', message: `pi 扩展 UI「${method || 'unknown'}」无法在飞书中交互，已取消`, willRetry: true });
      return;
    }
    const questions = [questionForUi(method, record)];
    let state: PendingUi;
    const finish = (reason: string): void => {
      if (!state.pending) return;
      state.pending = false;
      state.resolvedReason = reason;
      this.pendingUi.delete(id);
      for (const listener of state.listeners) {
        try { listener(reason); } catch (error) { log.fail('agent', error, { backend: 'pi-rpc', phase: 'ui-resolved' }); }
      }
      state.listeners.clear();
    };
    const request: AgentUserInputRequest = {
      requestId: id,
      threadId: this.sessionId,
      turnId: 'currentTurnId' in active ? active.currentTurnId ?? active.runId : active.runId,
      itemId: id,
      questions,
      ...(typeof record.timeout === 'number' && record.timeout > 0 ? { autoResolutionMs: record.timeout } : {}),
      isPending: () => state.pending,
      respond: async (answers) => {
        if (!state.pending) throw new Error('pi 扩展 UI 请求已经结束');
        const answer = answers[id]?.answers?.[0] ?? '';
        finish('responded');
        await this.client.write(uiResponse(method, id, answer));
      },
      reject: async (reason) => {
        if (!state.pending) throw new Error('pi 扩展 UI 请求已经结束');
        finish(reason || 'rejected');
        await this.client.write({ type: 'extension_ui_response', id, cancelled: true });
      },
      onResolved: (listener) => {
        if (!state.pending) {
          listener(state.resolvedReason ?? 'resolved');
          return () => undefined;
        }
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
    };
    state = { request, pending: true, listeners: new Set() };
    this.pendingUi.set(id, state);
    active.queue.push({ type: 'user_input_request', request });
  }

  private async resolveUi(state: PendingUi, reason: string, cancel: boolean): Promise<void> {
    if (!state.pending) return;
    state.pending = false;
    state.resolvedReason = reason;
    this.pendingUi.delete(String(state.request.requestId));
    for (const listener of state.listeners) {
      try { listener(reason); } catch (error) { log.fail('agent', error, { backend: 'pi-rpc', phase: 'ui-close-resolved' }); }
    }
    state.listeners.clear();
    if (cancel) await this.client.write({ type: 'extension_ui_response', id: String(state.request.requestId), cancelled: true });
  }
}

function readDisposition(response: PiRecord): string | undefined {
  if (typeof response.disposition === 'string') return response.disposition;
  if (response.data && typeof response.data.disposition === 'string') return response.data.disposition;
  return undefined;
}

function splitModel(model: string): { provider: string; modelId: string } {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) throw new Error(`pi 模型必须使用 provider/model 格式：${model}`);
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

function toPiThinkingLevel(effort: ReasoningEffort): string {
  if (effort === 'none') return 'off';
  if (effort === 'ultra') throw new Error('pi 后端不支持 ultra 思考档位；请改用 max 或更低档位');
  return effort;
}

function questionForUi(method: string, record: PiRecord): AgentUserInputQuestion {
  if (method === 'select') {
    const options = Array.isArray(record.options)
      ? record.options.map((value: unknown) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const option = value as PiRecord;
          return {
            label: String(option.label ?? option.value ?? ''),
            description: String(option.description ?? ''),
          };
        }
        return { label: String(value), description: '' };
      })
      : null;
    return { id: String(record.id), header: String(record.title ?? '请选择'), question: String(record.title ?? '请选择'), isOther: false, isSecret: false, options };
  }
  if (method === 'confirm') {
    return {
      id: String(record.id),
      header: String(record.title ?? '请确认'),
      question: String(record.message ?? record.title ?? '请确认'),
      isOther: false,
      isSecret: false,
      options: [{ label: '是', description: '确认' }, { label: '否', description: '取消' }],
    };
  }
  return {
    id: String(record.id),
    header: String(record.title ?? '请输入'),
    question: String(record.placeholder ?? record.title ?? '请输入'),
    isOther: true,
    isSecret: false,
    options: null,
  };
}

function uiResponse(method: string, id: string, answer: string): PiRecord {
  if (method === 'confirm') {
    const yes = ['是', 'yes', 'y', 'true', '确认', '允许'].includes(answer.trim().toLowerCase());
    return { type: 'extension_ui_response', id, confirmed: yes };
  }
  return { type: 'extension_ui_response', id, value: answer };
}

function recordUsage(record: PiRecord): CompactResult['usage'] {
  const usage = record.usage && typeof record.usage === 'object' ? record.usage as PiRecord : record;
  const contextUsage = usage.contextUsage && typeof usage.contextUsage === 'object' ? usage.contextUsage as PiRecord : undefined;
  const usedTokens = numberValue(usage.totalTokens ?? usage.usedTokens ?? contextUsage?.tokens);
  const contextRaw = usage.contextWindow ?? usage.maxTokens ?? contextUsage?.contextWindow;
  const contextWindow = contextRaw === null ? null : numberValue(contextRaw);
  if (usedTokens === undefined || contextWindow === undefined) return null;
  return { usedTokens, contextWindow };
}

function contextUsageEvent(record: PiRecord): Extract<AgentEvent, { type: 'context_usage' }> | undefined {
  const raw = record.contextUsage && typeof record.contextUsage === 'object'
    ? record.contextUsage as PiRecord
    : record.usage && typeof record.usage === 'object'
      ? record.usage as PiRecord
      : undefined;
  if (!raw) return undefined;
  const usedTokens = numberValue(raw.tokens ?? raw.usedTokens ?? raw.totalTokens);
  if (usedTokens === undefined) return undefined;
  const contextRaw = raw.contextWindow ?? raw.maxTokens;
  const contextWindow = contextRaw === null ? null : numberValue(contextRaw) ?? null;
  return { type: 'context_usage', usedTokens, contextWindow };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function imageContents(paths: readonly string[]): Promise<Array<{ type: 'image'; data: string; mimeType: string }>> {
  const out: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  for (const path of paths) {
    try {
      const bytes = await readFile(path);
      const mimeType = sniffImageType(bytes);
      if (!mimeType || bytes.length === 0 || bytes.length > 20 * 1024 * 1024) {
        log.warn('agent', 'pi-image-skip', {
          path,
          reason: !mimeType ? 'unsupported image type' : bytes.length === 0 ? 'empty image' : 'image exceeds 20 MiB',
        });
        continue;
      }
      out.push({ type: 'image', data: bytes.toString('base64'), mimeType });
    } catch (error) {
      log.warn('agent', 'pi-image-skip', { path, reason: toError(error).message.slice(0, 120) });
    }
  }
  return out;
}

function sniffImageType(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function waitForRunSettled(active: ActiveRun, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (!active.settled && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
  return active.settled;
}

async function waitForGoalTurnSettled(active: ActiveGoalRun, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (!active.settled && !active.turnSettled && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
  return active.turnSettled || active.settled;
}

function normalizeGoalStatus(status: string): string {
  if (status === 'cleared') return 'paused';
  if (status === 'usage_limited' || status === 'usage-limited') return 'usageLimited';
  if (status === 'budget_limited' || status === 'budget-limited') return 'budgetLimited';
  return status;
}

function isGoalStopStatus(status: string): boolean {
  return ['complete', 'blocked', 'paused', 'budgetLimited', 'usageLimited'].includes(status);
}
