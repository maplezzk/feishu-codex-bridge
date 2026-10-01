#!/usr/bin/env node

// Deterministic JSONL pi-RPC fixture. It is intentionally a process fixture,
// rather than a mock AgentBackend: runtime tests exercise framing, request
// correlation, listener ordering, retries, cancellation and child exit through
// the same stdin/stdout boundary as the real CLI.

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const env = process.env;
const mode = env.PI_FIXTURE_MODE ?? 'normal';
const sessionId = valueAfter('--session-id') ?? env.PI_FIXTURE_SESSION_ID ?? randomUUID();
const sessionPath = valueAfter('--session') ?? env.PI_FIXTURE_SESSION_FILE ?? undefined;
const model = { provider: 'fixture', id: 'fixture-model', name: 'Fixture Model', reasoning: true, contextWindow: 100_000 };
let thinkingLevel = 'medium';
let sessionName;
let streaming = false;
let stopped = false;
let currentTimer;
let pendingUiResolve;

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function emit(record) {
  if (stopped) return;
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function response(command, id, data) {
  emit({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) });
}

function failure(command, id, error) {
  emit({ id, type: 'response', command, success: false, error });
}

function modelKey(value) {
  return value && typeof value.provider === 'string' && typeof value.id === 'string'
    ? `${value.provider}/${value.id}`
    : '';
}

function currentState() {
  return {
    model,
    thinkingLevel,
    isStreaming: streaming,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'one-at-a-time',
    sessionFile: sessionPath,
    sessionId,
    ...(sessionName ? { sessionName } : {}),
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
}

async function handle(command) {
  const { id, type } = command;
  if (type === 'extension_ui_response') {
    pendingUiResolve?.(command);
    pendingUiResolve = undefined;
    return;
  }
  if (type === 'get_state') return response(type, id, currentState());
  if (type === 'get_available_models') {
    return response(type, id, { models: [model, { provider: 'fixture', id: 'no-think', name: 'No Think', reasoning: false }] });
  }
  if (type === 'get_available_thinking_levels') return response(type, id, { levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] });
  if (type === 'get_session_stats') return response(type, id, {
    usage: { input: 11, output: 7, totalTokens: 18 },
    contextUsage: { tokens: 42, contextWindow: 100_000, percent: 0.042 },
  });
  if (type === 'set_model') {
    if (command.provider !== 'fixture' || !['fixture-model', 'no-think'].includes(command.modelId)) return failure(type, id, `Model not found: ${command.provider}/${command.modelId}`);
    model.provider = command.provider;
    model.id = command.modelId;
    model.reasoning = command.modelId !== 'no-think';
    return response(type, id, model);
  }
  if (type === 'set_thinking_level') {
    if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(command.level)) return failure(type, id, `Unknown thinking level: ${command.level}`);
    if (!model.reasoning && command.level !== 'off') return failure(type, id, `Thinking not supported for ${modelKey(model)}`);
    thinkingLevel = command.level;
    emit({ type: 'thinking_level_changed', level: thinkingLevel });
    return response(type, id);
  }
  if (type === 'set_auto_compaction') return response(type, id);
  if (type === 'set_session_name') {
    sessionName = String(command.name ?? '').trim() || undefined;
    emit({ type: 'session_info_changed', name: sessionName });
    return response(type, id);
  }
  if (type === 'clear_queue') return response(type, id, { steering: [], followUp: [] });
  if (type === 'compact') {
    if (mode === 'compact-too-small') return failure(type, id, 'Nothing to compact (session too small)');
    emit({ type: 'compaction_start', reason: 'manual' });
    await delay(1);
    emit({ type: 'compaction_end', reason: 'manual', result: { summary: 'fixture summary', tokensBefore: 20, estimatedTokensAfter: 8, usage: { totalTokens: 8, contextWindow: 100_000 } }, aborted: false, willRetry: false });
    if (mode === 'compact-no-usage') return response(type, id, { summary: 'fixture summary', tokensBefore: 20, estimatedTokensAfter: 8 });
    return response(type, id, { summary: 'fixture summary', tokensBefore: 20, estimatedTokensAfter: 8, usage: { totalTokens: 8, contextWindow: 100_000 } });
  }
  if (type === 'abort') {
    if (mode === 'abort-stuck') return response(type, id);
    streaming = false;
    if (currentTimer) clearTimeout(currentTimer);
    currentTimer = undefined;
    emit({ type: 'agent_end', messages: [], willRetry: false });
    emit({ type: 'agent_settled' });
    return response(type, id);
  }
  if (type === 'steer') {
    emit({ type: 'queue_update', steering: [String(command.message ?? '')], followUp: [] });
    return response(type, id, { disposition: 'queued' });
  }
  if (type === 'prompt') return handlePrompt(command);
  return failure(type, id, `Unknown fixture command: ${type}`);
}

async function handlePrompt(command) {
  if (String(command.message ?? '').startsWith('/handled') || mode === 'handled') {
    return response('prompt', command.id, { disposition: 'handled' });
  }
  if (streaming) return failure('prompt', command.id, 'already streaming');
  streaming = true;
  if (mode === 'early-settled') {
    streaming = false;
    emit({ type: 'agent_settled' });
    return response('prompt', command.id, { disposition: 'started' });
  }
  if (mode === 'exit') {
    process.stdout.write('this is not valid JSON\n');
    setImmediate(() => process.exit(17));
    return;
  }
  response('prompt', command.id, { disposition: 'started' });
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  emit({ type: 'message_start', message: { role: 'user', content: String(command.message ?? ''), timestamp: Date.now() } });
  emit({ type: 'message_end', message: { role: 'user', content: String(command.message ?? ''), timestamp: Date.now() } });
  emit({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } });
  if (mode === 'display-ui') {
    emit({ type: 'extension_ui_request', id: 'status-1', method: 'setStatus', statusKey: 'progress', statusText: 'working' });
    emit({ type: 'extension_ui_request', id: 'widget-1', method: 'setWidget', widgetKey: 'steps', widgetLines: ['working'] });
  }

  if (Array.isArray(command.images)) {
    const first = command.images[0];
    emit({
      type: 'fixture_images',
      count: command.images.length,
      firstType: first?.mimeType,
      firstDataLength: typeof first?.data === 'string' ? first.data.length : 0,
    });
  }

  if (mode === 'ui') {
    emit({ type: 'extension_ui_request', id: 'fixture-ui-1', method: 'confirm', title: 'Fixture confirmation', message: 'Continue?' });
    await new Promise((resolveUi) => { pendingUiResolve = resolveUi; });
  }
  if (mode === 'unicode') {
    const bytes = Buffer.from(JSON.stringify({ type: 'message_update', usage: usage(), assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: `前半\u2028中间\u2029后半` } }) + '\n');
    const splitAt = bytes.indexOf(Buffer.from('前')) + 1;
    process.stdout.write(bytes.subarray(0, splitAt));
    await delay(5); // Split inside a Chinese UTF-8 code point, not between characters.
    process.stdout.write(bytes.subarray(splitAt));
  } else {
    emit({ type: 'message_update', usage: usage(), assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'fixture reply' } });
  }
  emit({ type: 'message_update', usage: usage(), assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: mode === 'unicode' ? `前半\u2028中间\u2029后半` : 'fixture reply' } });
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: mode === 'unicode' ? `前半\u2028中间\u2029后半` : 'fixture reply' }], usage: usage() } });
  if (mode === 'tool') {
    emit({ type: 'tool_execution_start', toolCallId: 'fixture-tool-1', toolName: 'bash', args: { command: 'printf fixture' } });
    emit({ type: 'tool_execution_end', toolCallId: 'fixture-tool-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'fixture output' }] }, isError: false });
  }
  emit({ type: 'turn_end', message: { role: 'assistant', content: [] }, toolResults: [] });

  const settle = () => {
    if (stopped) return;
    streaming = false;
    if (mode === 'retry') {
      emit({ type: 'agent_end', messages: [], willRetry: true });
      emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 1, errorMessage: 'fixture retry' });
      emit({ type: 'auto_retry_end', success: true, attempt: 2 });
    } else if (mode === 'error') {
      emit({ type: 'error', error: 'fixture final failure', willRetry: false });
      emit({ type: 'agent_end', messages: [], willRetry: false });
    } else {
      emit({ type: 'agent_end', messages: [], willRetry: false });
    }
    emit({ type: 'agent_settled' });
    currentTimer = undefined;
  };
  if (mode !== 'abort-stuck') currentTimer = setTimeout(settle, mode === 'slow' ? 2000 : 1);
}

function usage() {
  return { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

const decoder = new TextDecoder();
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += decoder.decode(chunk, { stream: true });
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    let line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.trim()) continue;
    try {
      const command = JSON.parse(line);
      void handle(command).catch((error) => failure(command.type, command.id, String(error?.message ?? error)));
    } catch (error) {
      emit({ type: 'response', command: 'parse', success: false, error: String(error?.message ?? error) });
    }
  }
});
process.stdin.on('end', () => {
  stopped = true;
  if (currentTimer) clearTimeout(currentTimer);
  process.exitCode = 0;
});
process.on('SIGTERM', () => { stopped = true; process.exit(0); });
process.on('SIGINT', () => { stopped = true; process.exit(130); });

// Keep the fixture independent of the host's project/session configuration.
void mkdir(resolve(env.PI_FIXTURE_DIR ?? '/tmp/pi-rpc-fixture'), { recursive: true });
