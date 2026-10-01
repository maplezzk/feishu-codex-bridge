#!/usr/bin/env node

// Deterministic JSONL fixture for the Pi Goal bridge seam. It behaves like a
// small Pi process: bridge commands arrive as handled prompt messages, Goal
// state/replies arrive as notify UI records, and agent events remain ordinary
// Pi session records. The fixture deliberately exercises multiple turns and
// command/event races without loading the real Goal extension.

import { randomUUID } from 'node:crypto';

const mode = process.env.PI_GOAL_FIXTURE_MODE ?? 'multi-turn';
const oldStatus = process.env.PI_GOAL_OLD_STATUS;
let stopped = false;
let streaming = false;
let goal;
let goalRunId;
let turnNumber = 0;
let timer;
let clearRequested = false;
const goalCommands = [];

function emit(record) {
  if (!stopped) process.stdout.write(`${JSON.stringify(record)}\n`);
}

function response(command, id, data) {
  emit({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) });
}

function failure(command, id, error) {
  emit({ id, type: 'response', command, success: false, error });
}

function notify(value) {
  emit({ type: 'extension_ui_request', id: `goal-notify-${randomUUID()}`, method: 'notify', notifyType: 'info', message: `BRIDGE_PI_GOAL_V1:${JSON.stringify(value)}` });
}

function snapshot() {
  return goal ? { ...goal } : null;
}

function state(status = goal?.status ?? 'active') {
  if (!goal) return;
  goal.status = status;
  notify({
    version: 1,
    kind: 'state',
    runId: goalRunId,
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    tokenBudget: goal.tokenBudget,
    ...(goal.waiting ? { waiting: goal.waiting } : {}),
    ...(status === 'complete' ? { summary: 'Goal fixture 完整结果' } : {}),
  });
}

function reply(command, ok = true, error) {
  const value = ok
    ? { version: 1, kind: 'reply', requestId: command.requestId, ok: true, data: { goal: snapshot(), sessionHeader: { fixture: true } } }
    : { version: 1, kind: 'reply', requestId: command.requestId, ok: false, error: error ?? { code: 'fixture_error', message: 'fixture error' } };
  notify(value);
}

function protocolError(command, code, message) {
  notify({ version: 1, kind: 'error', runId: command.runId, requestId: command.requestId, error: { code, message } });
}

function parseCommand(message) {
  const prefix = '/bridge-goal ';
  if (typeof message !== 'string' || !message.startsWith(prefix)) return undefined;
  try {
    const encoded = message.slice(prefix.length);
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return { requestId: 'invalid', action: 'invalid' };
  }
}

function emitTurnEvents(turn) {
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: `Goal 第 ${turn} 轮` }, usage: { input: turn * 10, output: turn * 3 } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: `Goal 第 ${turn} 轮` }, usage: { input: turn * 10, output: turn * 3 } });
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `Goal 第 ${turn} 轮` }] } });
  emit({ type: 'turn_end', message: { role: 'assistant', content: [] }, toolResults: [] });
}

function settleTurn(turn) {
  if (stopped) return;
  streaming = false;
  if (mode === 'goal-error') {
    emit({ type: 'error', error: 'fixture Goal 失败', willRetry: false });
    emit({ type: 'agent_end', messages: [], willRetry: false });
  } else {
    emit({ type: 'agent_end', messages: [], willRetry: false });
  }
  if (mode === 'terminal-first' && turn === 1) state('complete');
  emit({ type: 'agent_settled' });
  if (mode === 'goal-error') {
    protocolError({ runId: goalRunId }, 'goal_failed', 'fixture Goal 失败');
    return;
  }
  if ((mode === 'multi-turn' || mode === 'turn-gap') && turn === 1 && !clearRequested) {
    goal.tokensUsed = 26;
    goal.timeUsedSeconds = 2;
    state('active');
    timer = setTimeout(() => startTurn(2), mode === 'turn-gap' ? 50 : 5);
    return;
  }
  if (mode === 'waiting') return;
  if (mode !== 'terminal-first') {
    state(['budget_limited', 'usage_limited', 'blocked'].includes(mode) ? mode : 'complete');
  }
}

function startTurn(turn) {
  if (stopped || clearRequested || !goal || goal.status === 'paused') return;
  streaming = true;
  turnNumber = turn;
  goal.tokensUsed = turn === 1 ? 13 : 39;
  goal.timeUsedSeconds = turn;
  state('active');
  if (mode === 'no-agent-start') {
    state('complete');
    return;
  }
  emitTurnEvents(turn);
  timer = setTimeout(() => settleTurn(turn), mode === 'slow' ? 2_000 : 2);
}

function handleGoal(command) {
  if (!command || typeof command.action !== 'string') return;
  goalCommands.push(command.action);
  if (!command.requestId) {
    protocolError(command, 'invalid_request', '缺少 requestId');
    return;
  }
  if (command.action === 'status') {
    if (mode === 'delayed-status') {
      setTimeout(() => reply(command), 30);
      return;
    }
    if (oldStatus && !goal) {
      goal = { goalId: 'old-goal', objective: '旧目标', status: oldStatus, tokensUsed: 8, timeUsedSeconds: 1, tokenBudget: null };
      goalRunId = 'old-run';
    }
    reply(command);
    return;
  }
  if (command.action === 'start') {
    if (mode === 'start-error') {
      reply(command, false, { code: 'start_failed', message: 'fixture refused start' });
      return;
    }
    clearRequested = false;
    goalRunId = command.runId;
    goal = { goalId: `goal-${randomUUID()}`, objective: String(command.objective ?? ''), status: 'active', tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: command.tokenBudget ?? null };
    reply(command);
    state('active');
    if (mode === 'no-agent-start') {
      state('complete');
    } else if (mode === 'waiting' || mode === 'waiting-late-clear') {
      goal.waiting = { question: 'fixture wait' };
      state('active');
    } else {
      startTurn(1);
    }
    return;
  }
  if (command.action === 'clear' || command.action === 'cancel') {
    clearRequested = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (mode === 'waiting-late-clear' && goal) {
      goal.status = 'cleared';
      reply(command);
      setTimeout(() => state('cleared'), 10);
      return;
    }
    if (goal) state(command.action === 'clear' ? 'cleared' : 'paused');
    reply(command);
    return;
  }
  protocolError(command, 'unknown_action', `unknown action ${command.action}`);
}

async function handle(command) {
  const type = command?.type;
  if (type === 'get_fixture_goal_commands') {
    response(type, command.id, { commands: goalCommands });
    return;
  }
  if (type === 'get_state') {
    response(type, command.id, { model: { provider: 'fixture', id: 'fixture-model' }, thinkingLevel: 'medium', sessionId: 'goal-fixture', isStreaming: streaming });
    return;
  }
  if (type === 'get_session_stats') {
    response(type, command.id, { contextUsage: { tokens: goal?.tokensUsed ?? 0, contextWindow: 100_000 } });
    return;
  }
  if (type === 'clear_queue') {
    response(type, command.id, { steering: [], followUp: [] });
    return;
  }
  if (type === 'abort') {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (streaming) {
      streaming = false;
      emit({ type: 'agent_end', messages: [], willRetry: false });
      emit({ type: 'agent_settled' });
    }
    response(type, command.id);
    return;
  }
  if (type === 'steer') {
    response(type, command.id, { disposition: 'queued' });
    return;
  }
  if (type === 'prompt') {
    const goalCommand = parseCommand(command.message);
    if (goalCommand) {
      response(type, command.id, { disposition: 'handled' });
      handleGoal(goalCommand);
      return;
    }
    response(type, command.id, { disposition: 'started' });
    streaming = true;
    emit({ type: 'agent_start' });
    emit({ type: 'turn_start' });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '普通回复' } });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: '普通回复' } });
    emit({ type: 'agent_end', messages: [], willRetry: false });
    emit({ type: 'agent_settled' });
    streaming = false;
    return;
  }
  failure(type, command.id, `unknown fixture command ${type}`);
}

const decoder = new TextDecoder();
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += decoder.decode(chunk, { stream: true });
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      void handle(JSON.parse(line));
    } catch (error) {
      emit({ type: 'response', command: 'parse', success: false, error: String(error?.message ?? error) });
    }
  }
});
process.stdin.on('end', () => {
  stopped = true;
  if (timer) clearTimeout(timer);
  process.exitCode = 0;
});
process.on('SIGTERM', () => { stopped = true; process.exit(0); });
process.on('SIGINT', () => { stopped = true; process.exit(130); });
