import { describe, expect, it } from 'vitest';
import { createPiEventMapper, type PiRecord } from '../src/agent/pi-rpc/event-map';
import { initialState, reduce } from '../src/card/run-state';

const record = (value: PiRecord): PiRecord => value;

describe('pi RPC event mapper', () => {
  it('uses the final call ID without leaving a phantom running tool from native toolcall_start', () => {
    const mapper = createPiEventMapper('native-tools');
    const call = { type: 'toolCall', id: 'native-call', name: 'read', arguments: { path: 'marker.txt' } };
    const events = [
      mapper.map({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial: { content: [call] } } }),
      mapper.map({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: call } }),
      mapper.map({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments }),
      mapper.map({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result: { content: [{ type: 'text', text: 'marker' }] }, isError: false }),
      mapper.map({ type: 'agent_settled' }),
    ].flat();
    const state = events.reduce(reduce, initialState);
    expect(state.blocks.filter((block) => block.kind === 'tool')).toEqual([
      { kind: 'tool', tool: expect.objectContaining({ id: call.id, title: '读取 marker.txt', status: 'done', output: 'marker' }) },
    ]);
  });
  it('keeps content identity across deltas and authoritative finals, and settles only at agent_settled', () => {
    const mapper = createPiEventMapper('run-1');
    const events = [
      mapper.map(record({ type: 'message_start', message: { role: 'assistant', content: [] } })),
      mapper.map(record({ type: 'turn_end', message: { role: 'assistant', content: [] }, toolResults: [] })),
      mapper.map(record({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 }, usage: { input: 3, output: 0 } })),
      mapper.map(record({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '你好' }, usage: { input: 3, output: 1 } })),
      mapper.map(record({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: '你好，世界' }, usage: { input: 3, output: 2 } })),
      mapper.map(record({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '你好，世界' }], usage: { input: 3, output: 2 } } })),
      mapper.map(record({ type: 'agent_end', willRetry: false, messages: [] })),
      mapper.map(record({ type: 'agent_settled' })),
    ].flat();

    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', itemId: 'pi:run-1:m1:0', delta: '你好' },
    ]);
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', itemId: 'pi:run-1:m1:0', text: '你好，世界' },
    ]);
    expect(events.filter((event) => event.type === 'usage')).toEqual([
      { type: 'usage', inputTokens: 3, outputTokens: 0 },
      { type: 'usage', inputTokens: 3, outputTokens: 1 },
      { type: 'usage', inputTokens: 3, outputTokens: 2 },
    ]);
    expect(events.slice(0, -1).some((event) => event.type === 'done')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done', turnId: 'run-1' });
  });

  it('uses contentIndex to keep multiple text/thinking blocks separate', () => {
    const mapper = createPiEventMapper('run-2');
    mapper.map(record({ type: 'message_start', message: { role: 'assistant', content: [] } }));
    const events = [
      mapper.map(record({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } })),
      mapper.map(record({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '先想' } })),
      mapper.map(record({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: '先想完' } })),
      mapper.map(record({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 1 } })),
      mapper.map(record({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: '答案' } })),
      mapper.map(record({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '先想完' }, { type: 'text', text: '答案' }] } })),
    ].flat();

    expect(events).toContainEqual({ type: 'thinking_delta', itemId: 'pi:run-2:m1:0', delta: '先想' });
    expect(events).toContainEqual({ type: 'thinking', itemId: 'pi:run-2:m1:0', text: '先想完' });
    expect(events).toContainEqual({ type: 'text_delta', itemId: 'pi:run-2:m1:1', delta: '答案' });
    expect(events).toContainEqual({ type: 'text', itemId: 'pi:run-2:m1:1', text: '答案' });
  });

  it('maps tool categories and preserves failing exit codes', () => {
    const mapper = createPiEventMapper('run-3');
    const start = mapper.map(record({ type: 'tool_execution_start', toolCallId: 'bash-1', toolName: 'bash', args: { command: 'npm test' } }));
    const update = mapper.map(record({ type: 'tool_execution_update', toolCallId: 'bash-1', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'still running' }] } }));
    const end = mapper.map(record({
      type: 'tool_execution_end',
      toolCallId: 'bash-1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'failed' }], exitCode: 17 },
      isError: true,
    }));
    const search = mapper.map(record({ type: 'tool_execution_start', toolCallId: 'grep-1', toolName: 'grep', args: { pattern: 'needle' } }));
    const generic = mapper.map(record({ type: 'tool_execution_start', toolCallId: 'custom-1', toolName: 'mcp_search', args: { query: 'x' } }));

    expect(start).toEqual([{ type: 'tool_use', itemId: 'bash-1', title: 'npm test', kind: 'command' }]);
    expect(update).toEqual([]); // partial snapshots do not mark a running tool done
    expect(end).toEqual([{ type: 'tool_result', itemId: 'bash-1', output: 'failed', exitCode: 17 }]);
    expect(search).toEqual([{ type: 'tool_use', itemId: 'grep-1', title: '搜索 needle', kind: 'search' }]);
    expect(generic).toEqual([{ type: 'tool_use', itemId: 'custom-1', title: 'mcp_search', detail: undefined, kind: 'tool' }]);
  });

  it('does not turn a recovered retry into a final error', () => {
    const mapper = createPiEventMapper('run-4');
    mapper.map(record({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '429' } }));
    expect(mapper.map(record({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: '429' }))).toEqual([
      { type: 'error', message: '429', willRetry: true },
    ]);
    expect(mapper.map(record({ type: 'agent_end', willRetry: true, messages: [] }))).toEqual([]);
    expect(mapper.map(record({ type: 'auto_retry_end', success: true, attempt: 2 }))).toEqual([]);
    expect(mapper.map(record({ type: 'agent_settled' }))).toEqual([{ type: 'done', turnId: 'run-4' }]);

    const failed = createPiEventMapper('run-5');
    failed.map(record({ type: 'auto_retry_start', attempt: 1, maxAttempts: 1, delayMs: 0, errorMessage: '服务不可用' }));
    failed.map(record({ type: 'auto_retry_end', success: false, attempt: 1, finalError: '最终失败' }));
    expect(failed.map(record({ type: 'agent_settled' }))).toEqual([
      { type: 'error', message: '最终失败', willRetry: false },
    ]);
  });

  it('surfaces extension errors while deferring terminal state until settled', () => {
    const mapper = createPiEventMapper('run-6');
    expect(mapper.map(record({ type: 'extension_error', extensionPath: '/tmp/ext.ts', event: 'tool_call', error: 'boom' }))).toEqual([
      { type: 'error', message: '/tmp/ext.ts（tool_call）：boom', willRetry: true },
    ]);
    expect(mapper.map(record({ type: 'agent_settled' }))).toEqual([
      { type: 'error', message: '/tmp/ext.ts（tool_call）：boom', willRetry: false },
    ]);
  });

  it('maps compaction progress and summary usage without closing the run early', () => {
    const mapper = createPiEventMapper('run-7');
    expect(mapper.map(record({ type: 'compaction_start', reason: 'manual' }))).toEqual([
      { type: 'context_compacting' },
    ]);
    expect(mapper.map(record({
      type: 'compaction_end',
      reason: 'manual',
      result: { summary: '摘要', firstKeptEntryId: 'e1', usage: { input: 20, output: 4 } },
      aborted: false,
      willRetry: false,
    }))).toEqual([
      { type: 'context_compacted' },
      { type: 'usage', inputTokens: 20, outputTokens: 4 },
    ]);
    expect(mapper.map(record({ type: 'turn_end' }))).toEqual([]);
    expect(mapper.map(record({ type: 'agent_settled' }))).toEqual([{ type: 'done', turnId: 'run-7' }]);
  });
});
