import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { AppServerClient } from '../src/agent/codex-appserver/app-server-client';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import { mapNotification } from '../src/agent/codex-appserver/event-map';
import { withIdleTimeout } from '../src/bot/watchdog';
import { initialState, reduce } from '../src/card/run-state';
import { buildRunCard } from '../src/card/run-card';
import { log } from '../src/core/logger';
import { writeNodeExecutable } from './helpers/node-executable';
import type { AgentEvent, AgentThread } from '../src/agent/types';

const SERVER = `
const readline = require('node:readline');
const send = (msg) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...msg})+'\\n');
const event = (method, extra={}) => send({method,params:{threadId:'host',
 ...(method.startsWith('turn/')?{}:{turnId:'turn'}),...extra}});
let clock;
let scopeCount=0;
const finish = () => {
 clearInterval(clock);
 event('turn/completed',{turn:{id:'turn',status:'completed'}});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line);
 if(typeof msg.id!=='number') return;
 if(msg.method==='test/partial' || msg.method==='test/oversize') {
  process.stderr.write(msg.method==='test/partial'
   ? 'DEBUG codex_api::sse::responses: unhandled responses event: "response.compaction.'
   : 'DEBUG codex_api::sse::responses: '+ 'x'.repeat(70000));
  setTimeout(()=>send({id:msg.id,result:{}}),20);return;
 }
 if(msg.method==='test/flush') {
  process.stderr.write((msg.params?.oversize ? 'PRIVATE_TAIL' : 'compacting"')+'\\n');
  send({id:msg.id,result:{}});return;
 }
 if(msg.method==='test/end') {
  event('turn/completed',{turn:{id:'scope-'+scopeCount}});
  send({id:msg.id,result:{}});return;
 }
 if(msg.method==='turn/interrupt') { send({id:msg.id,result:{}}); finish(); return; }
 if(msg.method!=='turn/start') {
  send({id:msg.id,result:msg.method==='thread/start'?{thread:{id:'host'}}:{}}); return;
 }
 if(!process.env.RUST_LOG.includes('codex_api::sse::responses=debug')) process.exit(2);
 const mode=msg.params.input[0].text;
 if(mode==='scope-only') {
  send({id:msg.id,result:{turn:{id:'scope-'+(++scopeCount)}}});return;
 }
 send({id:msg.id,result:{turn:{id:'turn'}}});
 event('turn/started',{turn:{id:'turn'}});
 let ticks=0;
 clock=setInterval(()=>{
  ticks++;
  if(mode==='noise') {
   process.stderr.write('DEBUG unrelated: response.compaction.compacting\\n');
   process.stderr.write('DEBUG codex_api::sse::responses: payload PRIVATE_MODEL_BODY\\n');
   return;
  }
  if(mode==='json' || mode==='text-spans') {
   const heartbeat = (threadId,turnId) => process.stderr.write(mode==='text-spans'
    ? 'DEBUG codex_api::sse::responses: session_loop{thread_id='+threadId+'}:turn{thread.id="'+threadId+'" turn.id="'+turnId+'"}: unhandled responses event: "response.compaction.compacting"\\n'
    : JSON.stringify({
      level:'DEBUG',target:'codex_api::sse::responses',
      fields:{message:'unhandled responses event: "response.compaction.compacting"'},
      spans:[{thread_id:threadId},{'thread.id':threadId,'turn.id':turnId}]
     })+'\\n');
   heartbeat('child','child-turn');
   heartbeat('host','stale-turn');
   // Stale native boundaries must not retarget diagnostic heartbeats.
   event('turn/started',{turn:{id:'stale-turn'}});
   heartbeat('host','turn');
   event('turn/completed',{turn:{id:'stale-turn'}});
   if(ticks===8) {
    event('item/agentMessage/delta',{itemId:'answer',delta:'Recovered'});
    finish();
   }
   return;
  }
  // A real stderr line can be split at any byte boundary.
  process.stderr.write('DEBUG codex_api::sse::responses: unhandled responses event: "response.compaction.');
  setTimeout(()=>process.stderr.write('compacting"\\n'),5);
  if(mode==='heartbeat' && ticks===8) {
   setTimeout(()=>{
    event('item/completed',{item:{type:'contextCompaction',id:'compact'}});
    event('item/agentMessage/delta',{itemId:'answer',delta:'Recovered'});
    finish();
   },10);
  }
 },50);
});
`;
const dir = mkdtempSync(join(tmpdir(), 'bridge-compaction-'));
const { bin } = writeNodeExecutable(dir, 'codex', SERVER);
afterAll(shutdownResidentClients);

async function withThread(fn: (thread: AgentThread) => Promise<void>): Promise<void> {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  let thread: AgentThread | undefined;
  try {
    thread = await new CodexAppServerBackend().startThread({ cwd: dir });
    await fn(thread);
  } finally {
    await thread?.close();
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
}

describe('compaction progress through the real app-server transport', () => {
  it.each(['json', 'text-spans'])('accepts scoped %s diagnostics without letting stale or child turns change their scope', async mode => {
    await withThread(async thread => {
      const run = thread.runStreamed({ text: mode });
      const events: AgentEvent[] = [];
      for await (const event of run.events) events.push(event);
      expect(events.filter(e => e.type === 'context_compacting')).toHaveLength(8);
      expect(events.filter(e => e.type === 'turn_started')).toEqual([{ type: 'turn_started', turnId: 'turn' }]);
      expect(events.at(-1)).toEqual({ type: 'done', turnId: 'turn' });
    });
  });

  it('discards the tail of an oversized diagnostic instead of logging its payload', async () => {
    const warnings = vi.spyOn(log, 'warn');
    const client = new AppServerClient({ bin, cwd: dir });
    try {
      await client.connect();
      await client.request('test/oversize');
      await client.request('test/flush', { oversize: true });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(warnings).toHaveBeenCalledWith('agent', 'stderr-line-too-large', expect.any(Object));
      expect(JSON.stringify(warnings.mock.calls)).not.toContain('PRIVATE_TAIL');
    } finally { await client.close(); warnings.mockRestore(); }
  });

  it('does not reassign a buffered partial heartbeat to the next turn', async () => {
    const client = new AppServerClient({ bin, cwd: dir });
    try {
      await client.connect();
      const start = () => client.request('turn/start', { threadId: 'host', input: [{ text: 'scope-only' }] });
      await start();
      await client.request('test/partial');
      await start();
      await client.request('test/flush');
      await client.request('test/end');
      const events = [];
      for await (const event of client.streamEvents()) {
        events.push(event);
        if (event.method === 'turn/completed') break;
      }
      expect(events.some(e => e.method === 'bridge/contextCompacting')).toBe(false);
    } finally { await client.close(); }
  });
  it('keeps an otherwise silent turn alive and renders compaction until the answer resumes', async () => {
    await withThread(async thread => {
      const run = thread.runStreamed({ text: 'heartbeat' });
      const timeout = vi.fn();
      const events: AgentEvent[] = [];
      let state = initialState;
      for await (const event of withIdleTimeout(run.events, 150, timeout, undefined, run.lastActivity)) {
        events.push(event);
        state = reduce(state, event);
        if (event.type === 'context_compacting') {
          expect(JSON.stringify(buildRunCard({ rs: state }))).toContain('正在压缩上下文');
          expect(state.terminal).toBe('running');
        }
      }
      expect(timeout).not.toHaveBeenCalled();
      expect(events.filter(e => e.type === 'context_compacting')).toHaveLength(8);
      expect(events).toContainEqual({ type: 'context_compacted' });
      expect(events).toContainEqual({ type: 'text_delta', itemId: 'answer', delta: 'Recovered' });
      expect(state.terminal).toBe('done');
      expect(state.footer).toBeNull();
    });
  });

  it('does not treat unrelated stderr as a heartbeat or expose parser payloads', async () => {
    const warnings = vi.spyOn(log, 'warn');
    try {
      await withThread(async thread => {
        const run = thread.runStreamed({ text: 'noise' });
        let aborted: Promise<void> | undefined;
        const timeout = vi.fn(() => { aborted = thread.abort(run.turnId()!); });
        const events: AgentEvent[] = [];
        for await (const event of withIdleTimeout(run.events, 150, timeout, undefined, run.lastActivity)) {
          events.push(event);
        }
        await aborted;
        expect(timeout).toHaveBeenCalledOnce();
        expect(events.some(e => e.type === 'context_compacting')).toBe(false);
        expect(JSON.stringify(warnings.mock.calls)).not.toContain('PRIVATE_MODEL_BODY');
      });
    } finally { warnings.mockRestore(); }
  });

  it('still lets the user stop a turn while compaction heartbeats are arriving', async () => {
    await withThread(async thread => {
      const run = thread.runStreamed({ text: 'stop' });
      let stopped = false;
      const timeout = vi.fn();
      const types: string[] = [];
      for await (const event of withIdleTimeout(run.events, 150, timeout, undefined, run.lastActivity)) {
        types.push(event.type);
        if (event.type === 'context_compacting' && !stopped) {
          stopped = true;
          await thread.abort(run.turnId()!);
        }
      }
      expect(stopped).toBe(true);
      expect(types.at(-1)).toBe('done');
      expect(timeout).not.toHaveBeenCalled();
    });
  });
});

it('maps the current contextCompaction item lifecycle and the legacy completion notification', () => {
  expect(mapNotification({ method: 'item/started', params: {
    threadId: 'host', turnId: 'turn', startedAtMs: 1, item: { type: 'contextCompaction', id: 'compact' },
  } })).toEqual({ type: 'context_compacting' });
  expect(mapNotification({ method: 'item/completed', params: {
    threadId: 'host', turnId: 'turn', completedAtMs: 2, item: { type: 'contextCompaction', id: 'compact' },
  } })).toEqual({ type: 'context_compacted' });
  expect(mapNotification({ method: 'thread/compacted', params: { threadId: 'host', turnId: 'turn' } }))
    .toEqual({ type: 'context_compacted' });
  const state = reduce(reduce(initialState, { type: 'context_compacting' }), { type: 'context_compacted' });
  expect(state.footer).toBe('thinking');
  expect(state.terminal).toBe('running');
});
