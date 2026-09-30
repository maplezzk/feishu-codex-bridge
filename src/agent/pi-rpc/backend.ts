import { randomUUID } from 'node:crypto';
import { log } from '../../core/logger';
import type {
  AgentBackend,
  AgentCapabilities,
  AgentThread,
  BackendProbe,
  GenerateSessionTitleOptions,
  ModelInfo,
  PermissionMode,
  ReasoningEffort,
  ResumeThreadOptions,
  StartThreadOptions,
  ThreadHistory,
  ThreadSummary,
} from '../types';
import type { PiRecord } from './event-map';
import { PiRpcClient, type PiRpcClientLike, type PiRpcClientOptions } from './client';
import { findPiSession, listPiSessions, readPiHistory } from './history';
import { piVersionAsync, probePi, resolvePiBin, type PiProbe } from './locate';
import { assertPiPermission } from './permission';
import { PiThread } from './thread';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const PI_EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EMPTY_HISTORY: ThreadHistory = { turns: [], totalTurns: 0 };

export interface PiBackendDeps {
  resolveBin: typeof resolvePiBin;
  probe: typeof probePi;
  createClient: (options: PiRpcClientOptions) => PiRpcClientLike;
  listSessions: typeof listPiSessions;
  findSession: typeof findPiSession;
  readHistory: typeof readPiHistory;
}

const DEFAULT_DEPS: PiBackendDeps = {
  resolveBin: resolvePiBin,
  probe: probePi,
  createClient: (options) => new PiRpcClient(options),
  listSessions: listPiSessions,
  findSession: findPiSession,
  readHistory: readPiHistory,
};

/** AgentBackend adapter for the installed pi RPC CLI. */
export class PiRpcBackend implements AgentBackend {
  readonly id = 'pi-rpc';
  readonly displayName = 'pi';
  readonly capabilities: AgentCapabilities = {
    goal: false,
    steer: true,
    compact: true,
    resume: true,
    approvals: false,
  };
  readonly supportedModes: readonly PermissionMode[] = ['full'];

  constructor(private readonly deps: PiBackendDeps = DEFAULT_DEPS) {}

  async isAvailable(): Promise<boolean> {
    return (await this.doctor()).ok;
  }

  async doctor(opts?: { force?: boolean }): Promise<BackendProbe> {
    try {
      const result = await this.deps.probe({ force: opts?.force });
      return {
        ok: result.ok,
        version: result.version,
        ...(result.location ? { location: result.location } : {}),
        ...(result.hint ? { hint: result.hint } : {}),
        depState: result.ok ? 'installed' : 'external-missing',
      };
    } catch (error) {
      log.fail('agent', error, { backend: 'pi-rpc', phase: 'doctor' });
      return { ok: false, version: null, hint: `pi 探测失败：${toError(error).message}`, depState: 'external-missing' };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const client = await this.openEphemeral();
    let failed = false;
    try {
      const response = unwrap(await client.request<PiRecord>('get_available_models'));
      const models = Array.isArray(response.models) ? response.models : [];
      if (!models.length) throw new Error('pi 没有返回可用模型；请检查 pi 本机配置与登录状态');
      // The first entry is not necessarily pi's configured default (large
      // provider catalogs commonly sort by provider). Ask pi for the actual
      // state and use its provider/id as the sole default marker.
      const state = normalizeState(await client.request<PiRecord>('get_state'));
      const defaultModel = modelFromState(state);
      const defaultValue = models.find((model) => modelKey(model) === defaultModel);
      let defaultEfforts: ReasoningEffort[] = [];
      if (defaultValue && isReasoningModel(defaultValue)) {
        try {
          defaultEfforts = await availableEfforts(client);
        } catch (error) {
          // Keep the catalog usable when a test seam or an older pi omits this
          // optional query. Model metadata remains the truthful fallback.
          log.warn('agent', 'pi-model-efforts-unavailable', { backend: 'pi-rpc', phase: 'listModels/efforts', reason: toError(error).message });
          defaultEfforts = piEfforts(defaultValue as PiRecord);
        }
      }
      return models.map((model: unknown) => mapPiModel(model, defaultModel, defaultEfforts, effortFromState(state)));
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await closeWithLog(client, 'listModels/close', failed);
    }
  }

  async listThreads(cwd: string, limit = 15): Promise<ThreadSummary[]> {
    try {
      return await this.deps.listSessions(cwd, limit);
    } catch (error) {
      log.fail('agent', error, { backend: 'pi-rpc', phase: 'listSessions', cwd });
      return [];
    }
  }

  async readHistory(cwd: string, sessionId: string, maxTurns = 10): Promise<ThreadHistory> {
    try {
      if (!isPiSessionId(sessionId)) return EMPTY_HISTORY;
      return await this.deps.readHistory(cwd, sessionId, maxTurns);
    } catch (error) {
      log.fail('agent', error, { backend: 'pi-rpc', phase: 'readHistory', cwd, sessionId });
      return EMPTY_HISTORY;
    }
  }

  async readSessionTitle(cwd: string, sessionId: string): Promise<string | undefined> {
    const history = await this.readHistory(cwd, sessionId, 1);
    const title = history.name?.trim();
    return title || undefined;
  }

  async setSessionTitle(cwd: string, sessionId: string, title: string): Promise<void> {
    const clean = title.trim();
    if (!clean) throw new Error('不能设置空的 pi 会话标题');
    const sessionPath = await this.findExistingSession(cwd, sessionId);
    const client = await this.openClient(cwd, ['--session', sessionPath]);
    let failed = false;
    try {
      await client.request('set_session_name', { name: clean });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await closeWithLog(client, 'setSessionTitle/close', failed);
    }
  }

  async generateSessionTitle(opts: GenerateSessionTitleOptions): Promise<string | undefined> {
    const args = ['--no-session', ...modelArgs(opts.model), '--thinking', toPiLevel(opts.effort)];
    const client = await this.openClient(opts.cwd, args);
    let failed = false;
    try {
      const state = normalizeState(await client.request<PiRecord>('get_state'));
      const thread = new PiThread({
        client,
        cwd: opts.cwd,
        sessionId: String(state.sessionId ?? randomUUID()),
        model: modelFromState(state),
        effort: opts.effort,
      });
      let text = '';
      for await (const event of thread.runStreamed({ text: opts.prompt }, { model: opts.model, effort: opts.effort }).events) {
        if (event.type === 'text') text = event.text;
        else if (event.type === 'text_delta') text += event.delta;
        else if (event.type === 'error' && !event.willRetry) throw new Error(event.message);
      }
      return parseTitle(text);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await closeWithLog(client, 'generateSessionTitle/close', failed);
    }
  }

  async startThread(opts: StartThreadOptions): Promise<AgentThread> {
    assertPiPermission(opts.mode);
    const sessionId = randomUUID();
    const client = await this.openClient(opts.cwd, [
      '--session-id', sessionId,
      ...modelArgs(opts.model),
      ...(opts.effort ? ['--thinking', toPiLevel(opts.effort)] : []),
    ]);
    try {
      const state = normalizeState(await client.request<PiRecord>('get_state'));
      ensureSessionId(state, sessionId, '新建');
      await configureSession(client, state, opts);
      const applied = normalizeState(await client.request<PiRecord>('get_state'));
      verifyAppliedOptions(applied, opts);
      return new PiThread({
        client,
        cwd: opts.cwd,
        sessionId,
        model: opts.model ?? modelFromState(applied),
        effort: opts.effort ?? effortFromState(applied),
      });
    } catch (error) {
      await closeWithLog(client, 'startThread/close');
      throw error;
    }
  }

  async resumeThread(opts: ResumeThreadOptions): Promise<AgentThread> {
    assertPiPermission(opts.mode);
    if (!isPiSessionId(opts.sessionId)) throw new Error(`无效的 pi 会话 ID：${opts.sessionId}`);
    const sessionPath = await this.findExistingSession(opts.cwd, opts.sessionId);
    const client = await this.openClient(opts.cwd, ['--session', sessionPath]);
    try {
      const state = normalizeState(await client.request<PiRecord>('get_state'));
      ensureSessionId(state, opts.sessionId, '恢复');
      await configureSession(client, state, opts);
      const applied = normalizeState(await client.request<PiRecord>('get_state'));
      verifyAppliedOptions(applied, opts);
      return new PiThread({
        client,
        cwd: opts.cwd,
        sessionId: opts.sessionId,
        model: opts.model ?? modelFromState(applied),
        effort: opts.effort ?? effortFromState(applied),
      });
    } catch (error) {
      await closeWithLog(client, 'resumeThread/close');
      throw error;
    }
  }

  private async openClient(cwd: string, args: readonly string[]): Promise<PiRpcClientLike> {
    const bin = this.deps.resolveBin();
    if (!bin) throw new Error('未找到 pi CLI（设置 PI_BIN 或安装 pi 后再选择 pi 后端）');
    const client = this.deps.createClient({ bin, cwd, args });
    if (!client.isAlive()) {
      await closeWithLog(client, 'openClient/close-dead');
      throw new Error('pi RPC 进程启动后立即退出');
    }
    return client;
  }

  private async openEphemeral(): Promise<PiRpcClientLike> {
    return this.openClient(process.cwd(), ['--no-session']);
  }

  private async findExistingSession(cwd: string, sessionId: string): Promise<string> {
    if (!isPiSessionId(sessionId)) throw new Error(`无效的 pi 会话 ID：${sessionId}`);
    const path = await this.deps.findSession(cwd, sessionId);
    if (!path) throw new Error(`在当前项目中找不到 pi 会话「${sessionId}」，已拒绝伪造恢复`);
    return path;
  }
}

function mapPiModel(value: unknown, defaultModel?: string, defaultEfforts: ReasoningEffort[] = [], configuredEffort?: ReasoningEffort): ModelInfo {
  const model = value && typeof value === 'object' ? value as PiRecord : {};
  const provider = String(model.provider ?? '');
  const id = String(model.id ?? '');
  const fullId = provider ? `${provider}/${id}` : id;
  const advertised = piEfforts(model);
  const isDefault = defaultModel === fullId;
  const efforts = isDefault && defaultEfforts.length ? [...defaultEfforts] : advertised;
  return {
    id: fullId,
    displayName: String(model.name ?? fullId),
    description: provider ? `provider: ${provider}` : '',
    supportedEfforts: efforts,
    defaultEffort: isDefault && configuredEffort && efforts.includes(configuredEffort)
      ? configuredEffort : efforts.includes('medium') ? 'medium' : (efforts[0] ?? 'none'),
    isDefault,
    hidden: false,
  };
}

async function availableEfforts(client: PiRpcClientLike): Promise<ReasoningEffort[]> {
  const response = unwrap(await client.request<PiRecord>('get_available_thinking_levels'));
  const levels = Array.isArray(response.levels) ? response.levels : [];
  return levels.map(normalizePiEffort).filter((value): value is ReasoningEffort => value !== undefined);
}

function piEfforts(model: PiRecord): ReasoningEffort[] {
  if (!isReasoningModel(model)) return ['none'];
  const thinkingLevelMap = model.thinkingLevelMap;
  if (thinkingLevelMap && typeof thinkingLevelMap === 'object' && !Array.isArray(thinkingLevelMap)) {
    const map = thinkingLevelMap as PiRecord;
    return [
      ['none', 'off'],
      ['minimal', 'minimal'],
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['xhigh', 'xhigh'],
      ['max', 'max'],
    ].filter(([, level]) => {
      if (!level) return false;
      const mapped = map[level];
      if (level === 'xhigh' || level === 'max') return mapped !== undefined && mapped !== null;
      return mapped !== null;
    }).map(([effort]) => effort as ReasoningEffort);
  }
  const values = model.thinkingLevels ?? model.supportedThinkingLevels ?? model.supportedEfforts;
  // Base levels are Pi's native behavior without a map. Selection also checks
  // the actual selected model over RPC before changing its effort.
  if (!Array.isArray(values)) return ['none', 'minimal', 'low', 'medium', 'high'];
  return values.map(normalizePiEffort).filter((value): value is ReasoningEffort => value !== undefined);
}

function normalizePiEffort(value: unknown): ReasoningEffort | undefined {
  const text = String(value ?? '');
  if (text === 'off') return 'none';
  return PI_EFFORTS.includes(text as ReasoningEffort) ? text as ReasoningEffort : undefined;
}

function isReasoningModel(value: unknown): boolean {
  return value !== null && typeof value === 'object' && (value as PiRecord).reasoning !== false;
}

function modelKey(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const model = value as PiRecord;
  if (typeof model.id !== 'string') return undefined;
  return typeof model.provider === 'string' && model.provider ? `${model.provider}/${model.id}` : model.id;
}

async function configureSession(client: PiRpcClientLike, state: PiRecord, opts: StartThreadOptions): Promise<void> {
  if (opts.model && modelFromState(state) && modelFromState(state) !== opts.model) {
    const { provider, modelId } = splitModel(opts.model);
    await client.request('set_model', { provider, modelId });
  }
  if (opts.effort) {
    const level = toPiLevel(opts.effort);
    const available = unwrap(await client.request<PiRecord>('get_available_thinking_levels'));
    const levels = Array.isArray(available.levels) ? available.levels.map(String) : [];
    if (!levels.includes(level)) {
      throw new Error(`pi 当前模型不支持思考档位「${opts.effort}」（可用：${levels.join('、') || '未返回'}）`);
    }
    await client.request('set_thinking_level', { level });
  }
  if (opts.autoCompact !== undefined) {
    await client.request('set_auto_compaction', { enabled: opts.autoCompact });
  }
}

function verifyAppliedOptions(state: PiRecord, opts: StartThreadOptions): void {
  if (opts.model && modelFromState(state) !== opts.model) {
    throw new Error(`pi 模型回读不一致：期望 ${opts.model}，实际 ${modelFromState(state) ?? '缺失'}`);
  }
  if (opts.effort && effortFromState(state) !== opts.effort) {
    throw new Error(`pi 思考档位回读不一致：期望 ${opts.effort}，实际 ${effortFromState(state) ?? '缺失'}`);
  }
}

function normalizeState(value: PiRecord): PiRecord {
  return value?.data && typeof value.data === 'object' ? value.data as PiRecord : value;
}

function unwrap(value: PiRecord): PiRecord {
  return value?.data && typeof value.data === 'object' ? value.data as PiRecord : value;
}

function ensureSessionId(state: PiRecord, expected: string, action: string): void {
  const actual = typeof state.sessionId === 'string' ? state.sessionId : '';
  if (actual !== expected) throw new Error(`pi ${action}会话 ID 校验失败：期望 ${expected}，实际 ${actual || '缺失'}`);
}

function modelFromState(state: PiRecord): string | undefined {
  const model = state.model && typeof state.model === 'object' ? state.model as PiRecord : undefined;
  if (!model || typeof model.id !== 'string') return undefined;
  return typeof model.provider === 'string' && model.provider ? `${model.provider}/${model.id}` : model.id;
}

function effortFromState(state: PiRecord): ReasoningEffort | undefined {
  const level = String(state.thinkingLevel ?? '');
  return level === 'off' ? 'none' : PI_EFFORTS.includes(level as ReasoningEffort) ? level as ReasoningEffort : undefined;
}

function modelArgs(model: string | undefined): string[] {
  if (!model) return [];
  const { provider, modelId } = splitModel(model);
  return ['--provider', provider, '--model', modelId];
}

function splitModel(model: string): { provider: string; modelId: string } {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) throw new Error(`pi 模型必须使用 provider/model 格式：${model}`);
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

function toPiLevel(effort: ReasoningEffort): string {
  if (effort === 'none') return 'off';
  if (effort === 'ultra') throw new Error('pi 后端不支持 ultra 思考档位；请改用 max 或更低档位');
  return effort;
}

function isPiSessionId(value: string): boolean {
  // Pi 0.99.1 uses UUIDv7. Keep the validation structural so older UUIDs and
  // newer Pi UUID versions remain resumable without accepting prefixes.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseTitle(text: string): string | undefined {
  const clean = text.trim();
  if (!clean) return undefined;
  try {
    const parsed = JSON.parse(clean) as { title?: unknown };
    if (typeof parsed.title === 'string') return parsed.title.trim() || undefined;
  } catch {
    // Older pi/model combinations may ignore the JSON instruction; preserve the
    // plain response so the central title coordinator can sanitize it.
  }
  return clean;
}

async function closeWithLog(client: PiRpcClientLike, phase: string, primaryFailed = true): Promise<void> {
  try {
    await client.close();
  } catch (error) {
    log.fail('agent', error, { backend: 'pi-rpc', phase });
    if (!primaryFailed) throw error;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// Keep these imports part of the explicit public seam for tests and callers that
// need to inspect the selected CLI without starting a model turn.
export { PI_PACKAGE, piVersionAsync };
export type { PiProbe };
