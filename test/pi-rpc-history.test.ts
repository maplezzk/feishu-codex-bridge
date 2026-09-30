import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findPiSession, listPiSessions, readPiHistory, sessionDirectory } from '../src/agent/pi-rpc/history';

const cwd = resolve('/tmp/pi-bridge-history-project');
const sessionId = '019f0000-0000-7000-8000-000000000001';
const otherSessionId = '019f0000-0000-7000-8000-000000000002';

const tempRoots: string[] = [];

afterEach(async () => {
  const root = tempRoots.pop();
  if (root) await rm(root, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
});

async function writeSession(root: string, id: string, entries: unknown[], targetCwd = cwd): Promise<string> {
  process.env.PI_CODING_AGENT_DIR = root;
  const dir = sessionDirectory(targetCwd);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `2026-09-30T00-00-00-000Z_${id}.jsonl`);
  const header = { type: 'session', version: 3, id, timestamp: '2026-09-30T00:00:00.000Z', cwd: targetCwd };
  await writeFile(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  return file;
}

describe('pi native session history', () => {
  it('honors the native flat session directory override while filtering exact cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-history-custom-'));
    tempRoots.push(root);
    process.env.PI_CODING_AGENT_SESSION_DIR = join(root, 'flat-sessions');
    await writeSession(root, sessionId, []);
    await writeSession(root, otherSessionId, [], '/tmp/other-project');
    expect(sessionDirectory(cwd)).toBe(join(root, 'flat-sessions'));
    expect((await listPiSessions(cwd)).map((session) => session.sessionId)).toEqual([sessionId]);
    expect(await findPiSession(cwd, otherSessionId)).toBeUndefined();
    process.env.PI_CODING_AGENT_SESSION_DIR = 'relative-sessions';
    expect(sessionDirectory(cwd)).toBe(join(cwd, 'relative-sessions'));
  });
  it('uses the exact cwd directory and follows the last entry parent chain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-history-'));
    tempRoots.push(root);
    const entries = [
      { type: 'message', id: 'root-user', parentId: null, timestamp: '2026-09-30T00:00:01.000Z', message: { role: 'user', content: '旧分支' } },
      { type: 'message', id: 'root-assistant', parentId: 'root-user', timestamp: '2026-09-30T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '旧回答' }], usage: {} } },
      { type: 'message', id: 'wrong-user', parentId: 'root-user', timestamp: '2026-09-30T00:00:03.000Z', message: { role: 'user', content: '废弃分支，不应显示' } },
      { type: 'message', id: 'wrong-assistant', parentId: 'wrong-user', timestamp: '2026-09-30T00:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '废弃回答' }], usage: {} } },
      { type: 'message', id: 'right-user', parentId: 'root-assistant', timestamp: '2026-09-30T00:00:05.000Z', message: { role: 'user', content: '当前分支' } },
      { type: 'message', id: 'right-assistant', parentId: 'right-user', timestamp: '2026-09-30T00:00:06.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '当前回答' }], usage: {} } },
      { type: 'session_info', id: 'title-1', parentId: 'right-assistant', timestamp: '2026-09-30T00:00:07.000Z', name: '当前标题' },
    ];
    await writeSession(root, sessionId, entries);

    const file = await findPiSession(cwd, sessionId);
    expect(file).toContain(sessionId);
    const history = await readPiHistory(cwd, sessionId);
    expect(history.name).toBe('当前标题');
    expect(history.preview).toBe('旧分支');
    expect(history.turns).toHaveLength(2);
    expect(history.turns[0]).toMatchObject({ userText: '旧分支', assistantText: '旧回答', reasoning: '', tools: [] });
    expect(history.turns[1]).toMatchObject({ userText: '当前分支', assistantText: '当前回答', reasoning: '', tools: [] });
    expect(history.turns[0]?.startedAt).toEqual(expect.any(Number));
    expect(history.turns[1]?.startedAt).toEqual(expect.any(Number));
    expect(history.turns.some((turn) => turn.userText.includes('废弃'))).toBe(false);
  });

  it('honors compaction retention only on the active branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-history-'));
    tempRoots.push(root);
    const entries = [
      { type: 'message', id: 'old-user', parentId: null, timestamp: '2026-09-30T00:00:01.000Z', message: { role: 'user', content: '压缩前' } },
      { type: 'message', id: 'old-assistant', parentId: 'old-user', timestamp: '2026-09-30T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '旧回复' }], usage: {} } },
      { type: 'message', id: 'sibling-user', parentId: 'old-user', timestamp: '2026-09-30T00:00:03.000Z', message: { role: 'user', content: '错误兄弟分支' } },
      { type: 'message', id: 'active-user', parentId: 'old-assistant', timestamp: '2026-09-30T00:00:04.000Z', message: { role: 'user', content: '保留的当前问题' } },
      { type: 'message', id: 'active-assistant', parentId: 'active-user', timestamp: '2026-09-30T00:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '保留的当前回答' }], usage: {} } },
      { type: 'compaction', id: 'compact-1', parentId: 'active-assistant', timestamp: '2026-09-30T00:00:06.000Z', firstKeptEntryId: 'active-user', summary: '摘要' },
    ];
    await writeSession(root, sessionId, entries);
    const history = await readPiHistory(cwd, sessionId);
    expect(history.turns.map((turn) => turn.userText)).toEqual(['保留的当前问题']);
    expect(history.turns[0]?.assistantText).toBe('保留的当前回答');
    expect(history.turns.some((turn) => turn.userText.includes('兄弟'))).toBe(false);

    const badRetention = [
      ...entries.slice(0, -1),
      { type: 'compaction', id: 'compact-2', parentId: 'active-assistant', timestamp: '2026-09-30T00:00:07.000Z', firstKeptEntryId: 'sibling-user', summary: '跨分支引用' },
    ];
    await writeSession(root, otherSessionId, badRetention);
    const safe = await readPiHistory(cwd, otherSessionId);
    expect(safe.turns.some((turn) => turn.userText.includes('兄弟'))).toBe(false);
    expect(safe.turns.map((turn) => turn.userText)).toContain('保留的当前问题');
  });

  it('normalizes tool calls and tool results, including failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-history-'));
    tempRoots.push(root);
    await writeSession(root, sessionId, [
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-09-30T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: '运行命令' }, { type: 'image', data: 'ignored', mimeType: 'image/png' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-09-30T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'false' } }, { type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: 'src/a.ts' } }, { type: 'thinking', thinking: '先执行' }], usage: {} } },
      { type: 'message', id: 'r1', parentId: 'a1', timestamp: '2026-09-30T00:00:03.000Z', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: 'exit 1' }], isError: true } },
      { type: 'message', id: 'r2', parentId: 'r1', timestamp: '2026-09-30T00:00:04.000Z', message: { role: 'toolResult', toolCallId: 'call-2', toolName: 'read', content: [{ type: 'text', text: 'file' }], isError: false } },
      { type: 'message', id: 'a2', parentId: 'r2', timestamp: '2026-09-30T00:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '完成' }], usage: {} } },
    ]);
    const history = await readPiHistory(cwd, sessionId);
    expect(history.turns[0]).toMatchObject({
      userText: '运行命令',
      assistantText: '完成',
      reasoning: '先执行',
      tools: [
        { title: 'false', output: 'exit 1', failed: true, exitCode: 1 },
        { title: '读取 src/a.ts', output: 'file', exitCode: 0 },
      ],
    });
  });

  it('rejects missing, malformed, non-UUID and cross-cwd sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-history-'));
    tempRoots.push(root);
    await writeSession(root, sessionId, [{ type: 'message', id: 'u1', parentId: null, timestamp: '2026-09-30T00:00:01.000Z', message: { role: 'user', content: 'ok' } }]);
    await writeSession(root, otherSessionId, [{ type: 'message', id: 'u2', parentId: null, timestamp: '2026-09-30T00:00:01.000Z', message: { role: 'user', content: 'other cwd' } }], '/tmp/another-project');

    expect(await findPiSession(cwd, '019f0000-0000-7000-8000-0000000000')).toBeUndefined();
    expect(await findPiSession(cwd, 'not-a-uuid')).toBeUndefined();
    expect(await readPiHistory(cwd, 'not-a-uuid')).toEqual({ turns: [], totalTurns: 0 });
    const listed = await listPiSessions(cwd, 20);
    expect(listed.map((session) => session.sessionId)).toEqual([sessionId]);
    expect(await findPiSession(cwd, otherSessionId)).toBeUndefined();
    expect(await findPiSession('/tmp/another-project', otherSessionId)).toBeDefined();
    await writeFile(join(sessionDirectory(cwd), 'malformed.jsonl'), '{broken JSON}\n', 'utf8');
    await writeFile(join(sessionDirectory(cwd), 'wrong-cwd.jsonl'), JSON.stringify({ type: 'session', id: otherSessionId, cwd: '/tmp/another-project' }) + '\n', 'utf8');
    expect(await findPiSession(cwd, otherSessionId)).toBeUndefined();
    expect((await listPiSessions(cwd)).map((session) => session.sessionId)).toEqual([sessionId]);
  });
});
