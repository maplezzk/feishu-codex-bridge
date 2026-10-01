import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { log } from '../../core/logger';
import type { HistoryTool, HistoryTurn, ThreadHistory, ThreadSummary } from '../types';
import { piToolTitle } from './event-map';

/** Pi's generated session ids are UUIDs. Do not accept prefixes or custom ids
 * from the resume path: a prefix can select the wrong session and a custom id
 * can make a missing session look like a new one. */
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PiSessionHeader {
  type: 'session';
  id: string;
  cwd: string;
  timestamp?: string;
  version?: number;
  parentSession?: string;
}

interface PiEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  [key: string]: any;
}

interface ParsedSession {
  path: string;
  header: PiSessionHeader;
  entries: PiEntry[];
  activePath: PiEntry[];
  name?: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
}

interface MutableTurn extends HistoryTurn {
  _hasContent: boolean;
}

/**
 * Compute the native pi session directory. Pi resolves cwd before replacing
 * separators, so bridge history and pi's own resume picker use the same path.
 * `PI_CODING_AGENT_DIR` is the agent root, not the sessions directory itself.
 */
export function sessionDirectory(cwd: string): string {
  const customSessions = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  // Pi treats this override as the complete, flat session directory. Header
  // validation below still isolates each project's sessions inside it.
  if (customSessions) return resolve(cwd, expandHome(customSessions));
  const configuredDir = process.env.PI_CODING_AGENT_DIR?.trim();
  const rawAgentDir = configuredDir || join(homedir(), '.pi', 'agent');
  const agentDir = expandHome(rawAgentDir);
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return join(resolve(agentDir), 'sessions', safePath);
}

function expandHome(path: string): string {
  return path === '~'
    ? homedir()
    : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/** Find recent native pi sessions for one exact working directory. */
export async function listPiSessions(cwd: string, limit = 15): Promise<ThreadSummary[]> {
  const cleanLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 15;
  if (cleanLimit === 0) return [];
  const dir = sessionDirectory(cwd);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort((a, b) => b.localeCompare(a));
  } catch (err) {
    if (isMissing(err)) return [];
    log.fail('agent', err, { backend: 'pi-rpc', phase: 'history-list', cwd: dir });
    return [];
  }

  const parsed: ParsedSession[] = [];
  for (const name of names) {
    const candidate = await parseSessionFile(join(dir, name), cwd, { phase: 'history-list' });
    if (candidate) parsed.push(candidate);
  }
  parsed.sort((a, b) => b.updatedAt - a.updatedAt || basename(b.path).localeCompare(basename(a.path)));
  return parsed.slice(0, cleanLimit).map((session) => ({
    sessionId: session.header.id,
    preview: session.preview,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    name: session.name,
  }));
}

/**
 * Resolve a full UUID inside the cwd-scoped native directory. Header validation
 * is intentional: a filename or a UUID collision alone is never enough to
 * resume a session from another project.
 */
export async function findPiSession(cwd: string, sessionId: string): Promise<string | undefined> {
  if (!FULL_UUID.test(sessionId)) return undefined;
  const dir = sessionDirectory(cwd);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort((a, b) => b.localeCompare(a));
  } catch (err) {
    if (isMissing(err)) return undefined;
    log.fail('agent', err, { backend: 'pi-rpc', phase: 'history-find', cwd: dir, sessionId });
    return undefined;
  }
  for (const name of names) {
    const parsed = await parseSessionFile(join(dir, name), cwd, { phase: 'history-find', sessionId });
    if (parsed?.header.id === sessionId) return parsed.path;
  }
  return undefined;
}

/** Read the active branch of a native pi session into bridge history cards. */
export async function readPiHistory(cwd: string, sessionId: string, maxTurns = 10): Promise<ThreadHistory> {
  const empty: ThreadHistory = { turns: [], totalTurns: 0 };
  if (!FULL_UUID.test(sessionId)) return empty;
  const path = await findPiSession(cwd, sessionId);
  if (!path) return empty;
  const parsed = await parseSessionFile(path, cwd, { phase: 'history-read', sessionId });
  if (!parsed) return empty;

  const entries = applyLatestCompaction(parsed.activePath, path);
  const folded = foldEntries(entries, maxTurns);
  return {
    turns: folded.turns,
    totalTurns: folded.totalTurns,
    name: parsed.name,
    preview: parsed.preview || undefined,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  };
}

async function parseSessionFile(
  path: string,
  cwd: string,
  context: { phase: string; sessionId?: string },
): Promise<ParsedSession | undefined> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (err) {
    if (!isMissing(err)) log.fail('agent', err, { backend: 'pi-rpc', ...context, path });
    return undefined;
  }

  const lines = content.split(/\r?\n/);
  let header: PiSessionHeader | undefined;
  const entries: PiEntry[] = [];
  let malformed = false;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformed = true;
      log.warn('agent', 'pi-history-malformed-line', { backend: 'pi-rpc', ...context, path, line: index + 1 });
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      malformed = true;
      log.warn('agent', 'pi-history-invalid-record', { backend: 'pi-rpc', ...context, path, line: index + 1 });
      continue;
    }
    const record = value as PiEntry;
    if (!header) {
      if (record.type !== 'session' || typeof record.id !== 'string' || typeof record.cwd !== 'string') {
        log.warn('agent', 'pi-history-invalid-header', { backend: 'pi-rpc', ...context, path });
        return undefined;
      }
      header = { type: 'session', id: record.id, cwd: record.cwd, timestamp: record.timestamp, version: record.version, parentSession: record.parentSession };
      continue;
    }
    if (typeof record.id !== 'string' || typeof record.parentId !== 'string' && record.parentId !== null) {
      malformed = true;
      log.warn('agent', 'pi-history-invalid-entry', { backend: 'pi-rpc', ...context, path, line: index + 1 });
      continue;
    }
    entries.push(record);
  }
  if (!header) {
    log.warn('agent', 'pi-history-missing-header', { backend: 'pi-rpc', ...context, path });
    return undefined;
  }
  if (!FULL_UUID.test(header.id)) {
    log.warn('agent', 'pi-history-non-uuid', { backend: 'pi-rpc', ...context, path, id: header.id });
    return undefined;
  }
  if (context.sessionId && header.id !== context.sessionId) return undefined;
  if (resolve(header.cwd) !== resolve(cwd)) {
    // A flat custom directory normally contains multiple projects.
    if (!process.env.PI_CODING_AGENT_SESSION_DIR?.trim()) {
      log.warn('agent', 'pi-history-cwd-mismatch', { backend: 'pi-rpc', ...context, path, headerCwd: header.cwd, requestedCwd: cwd });
    }
    return undefined;
  }
  if (malformed) log.warn('agent', 'pi-history-partial', { backend: 'pi-rpc', ...context, path });

  const activePath = activeBranch(entries, path);
  const name = sessionName(activePath);
  const preview = firstUserText(activePath);
  const createdAt = toUnixSeconds(header.timestamp) || await fileMtime(path);
  const updatedAt = latestEntryTime(activePath) || createdAt || await fileMtime(path);
  return { path, header, entries, activePath, name, preview, createdAt, updatedAt };
}

function activeBranch(entries: PiEntry[], path: string): PiEntry[] {
  if (entries.length === 0) return [];
  const byId = new Map<string, PiEntry>();
  for (const entry of entries) {
    if (entry.id) byId.set(entry.id, entry);
  }
  const leaf = entries[entries.length - 1];
  if (!leaf?.id) return [];
  const branch: PiEntry[] = [];
  const seen = new Set<string>();
  let current: PiEntry | undefined = leaf;
  while (current?.id) {
    if (seen.has(current.id)) {
      log.warn('agent', 'pi-history-parent-cycle', { backend: 'pi-rpc', path, entryId: current.id });
      break;
    }
    seen.add(current.id);
    branch.push(current);
    if (current.parentId === null) break;
    const parent: PiEntry | undefined = current.parentId ? byId.get(current.parentId) : undefined;
    if (!parent) {
      log.warn('agent', 'pi-history-parent-missing', { backend: 'pi-rpc', path, entryId: current.id, parentId: current.parentId });
      break;
    }
    current = parent;
  }
  branch.reverse();
  return branch;
}

/** Apply pi's latest compaction boundary without ever crossing active branches. */
function applyLatestCompaction(activePath: PiEntry[], path: string): PiEntry[] {
  let compactionIndex = -1;
  for (let i = activePath.length - 1; i >= 0; i--) {
    if (activePath[i]?.type === 'compaction') {
      compactionIndex = i;
      break;
    }
  }
  if (compactionIndex < 0) return activePath;
  const compaction = activePath[compactionIndex];
  if (!compaction) return activePath;
  const retainedId = typeof compaction.firstKeptEntryId === 'string' ? compaction.firstKeptEntryId : undefined;
  if (!retainedId) {
    log.warn('agent', 'pi-history-compaction-missing-retained-id', { backend: 'pi-rpc', path });
    return activePath;
  }
  const retainedIndex = activePath.findIndex((entry) => entry.id === retainedId);
  if (retainedIndex < 0 || retainedIndex > compactionIndex) {
    // A corrupted/sibling reference must never make us look up an entry from a
    // different branch. Keep the already validated active branch as a safe view.
    log.warn('agent', 'pi-history-compaction-cross-branch', { backend: 'pi-rpc', path, retainedId });
    return activePath;
  }
  return activePath.slice(retainedIndex);
}

function foldEntries(entries: PiEntry[], maxTurns: number): { turns: HistoryTurn[]; totalTurns: number } {
  const turns: HistoryTurn[] = [];
  const toolById = new Map<string, HistoryTool>();
  let current: MutableTurn | undefined;
  const flush = (): void => {
    if (current?._hasContent) {
      const { _hasContent, ...turn } = current;
      void _hasContent;
      turns.push(turn);
    }
    current = undefined;
  };
  const ensure = (): MutableTurn => {
    if (!current) current = { userText: '', assistantText: '', reasoning: '', tools: [], _hasContent: false };
    return current;
  };
  const ensureTool = (turn: MutableTurn, id: string, name: string, args?: Record<string, unknown>): HistoryTool => {
    const existing = toolById.get(id);
    if (existing) return existing;
    const tool: HistoryTool = { title: piToolTitle(name, args) };
    turn.tools.push(tool);
    toolById.set(id, tool);
    turn._hasContent = true;
    return tool;
  };

  for (const entry of entries) {
    if (entry.type === 'message') {
      const message = asRecord(entry.message);
      if (!message) continue;
      const role = stringValue(message.role);
      if (role === 'user') {
        const text = messageText(message.content).filter((part) => !isBoilerplateUserText(part)).join('\n').trim();
        if (text) {
          flush();
          current = ensure();
          current.userText = text;
          current.startedAt = toUnixSeconds(entry.timestamp) || numberToUnix(message.timestamp);
          current._hasContent = true;
        }
      } else if (role === 'assistant') {
        const turn = ensure();
        for (const part of asArray(message.content)) {
          const block = asRecord(part);
          if (!block) continue;
          if (block.type === 'text') {
            const text = stringValue(block.text);
            if (text) {
              turn.assistantText = turn.assistantText ? `${turn.assistantText}\n\n${text}` : text;
              turn._hasContent = true;
            }
          } else if (block.type === 'thinking') {
            const thinking = stringValue(block.thinking);
            if (thinking) {
              turn.reasoning = turn.reasoning ? `${turn.reasoning}\n\n${thinking}` : thinking;
              turn._hasContent = true;
            }
          } else if (block.type === 'toolCall') {
            const id = stringValue(block.id);
            const name = stringValue(block.name) || '工具';
            if (id) ensureTool(turn, id, name, objectValue(block.arguments));
          }
        }
        const error = stringValue(message.errorMessage);
        if (error) {
          turn.assistantText = turn.assistantText ? `${turn.assistantText}\n\n${error}` : error;
          turn._hasContent = true;
        }
      } else if (role === 'toolResult') {
        const turn = ensure();
        const id = stringValue(message.toolCallId);
        const name = stringValue(message.toolName) || '工具';
        const tool = id ? ensureTool(turn, id, name) : undefined;
        if (tool) {
          tool.output = messageText(message.content).join('').trim() || undefined;
          tool.failed = message.isError === true;
          tool.exitCode = message.isError === true ? 1 : 0;
        }
        turn._hasContent = true;
      }
    } else if (entry.type === 'compaction') {
      // The compacted summary is intentionally omitted from the visible digest;
      // the retained active entries around it are the actual conversation card.
      continue;
    }
  }
  flush();
  const totalTurns = turns.length;
  const count = Number.isFinite(maxTurns) ? Math.max(0, Math.floor(maxTurns)) : 10;
  const kept = totalTurns > count ? turns.slice(totalTurns - count) : turns;
  return { turns: kept, totalTurns };
}

function sessionName(entries: PiEntry[]): string | undefined {
  let name: string | undefined;
  for (const entry of entries) {
    if (entry.type !== 'session_info') continue;
    const value = stringValue(entry.name).trim();
    name = value || undefined;
  }
  return name;
}

function firstUserText(entries: PiEntry[]): string {
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const message = asRecord(entry.message);
    if (message?.role !== 'user') continue;
    const text = messageText(message.content).filter((part) => !isBoilerplateUserText(part)).join('\n').trim();
    if (text) return text;
  }
  return '';
}

function latestEntryTime(entries: PiEntry[]): number {
  let latest = 0;
  for (const entry of entries) latest = Math.max(latest, toUnixSeconds(entry.timestamp), numberToUnix(asRecord(entry.message)?.timestamp));
  return latest;
}

async function fileMtime(path: string): Promise<number> {
  try { return Math.floor((await stat(path)).mtimeMs / 1000); } catch { return 0; }
}

function messageText(content: unknown): string[] {
  if (typeof content === 'string') return content ? [content] : [];
  return asArray(content).flatMap((part) => {
    const block = asRecord(part);
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  });
}

function isBoilerplateUserText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<environment_context>') || t.startsWith('# AGENTS.md') || t.startsWith('<system-reminder>') || t.startsWith('Caveat:');
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value);
}

function numberToUnix(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value / 1000) : 0;
}

function toUnixSeconds(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function isMissing(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT');
}
