/**
 * 轮次级自动重试的**节奏与判定**（纯函数，便于单测）。
 *
 * 背景：上游模型流（responses 流式响应）有时会长时间一条数据都不发 —— codex 那边
 * 既没收到 EOF 也没超时，就在 `receiving_stream` 里干等；bridge 的「N 分钟无任何
 * 通知」看门狗先到点，把这一轮判死（卡上显示「⏱ 无响应，已自动终止」）。用户看到
 * 的就是「明明在跑，突然就超时了」。
 *
 * 这里给的策略：这种轮次不直接丢掉，而是把**同一轮输入**隔一会儿整轮重发，直到
 * 成功或达到上限。为什么是整轮重发而不是「续上原来的流」：看门狗判死时已经把 codex
 * 子进程 SIGKILL 了（半截通知流会污染下一轮），没有可续的连接；话题会话本身是持久化
 * 的，重发时经 resolveThread 从记录 resume 出来接着跑。
 */

/** 第一次重试前的等待；之后每次翻倍。 */
export const AUTO_RETRY_BASE_MS = 20_000;
/** 退避上限：最快也要一分钟才再试一次（「最多1分钟一次」）。 */
export const AUTO_RETRY_MAX_MS = 60_000;
/** 重试次数上限（「最多100次」）。 */
export const AUTO_RETRY_MAX_ATTEMPTS = 100;

/** 第 attempt 次重试前的等待毫秒数（attempt 从 1 起）：20s → 40s → 60s 封顶。 */
export function autoRetryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(AUTO_RETRY_MAX_MS, AUTO_RETRY_BASE_MS * 2 ** (n - 1));
}

export interface AutoRetryInput {
  /** 这一轮被看门狗判死（上游长时间无任何通知） */
  timedOut: boolean;
  /** codex 子进程死了（崩溃 / 被 kill） */
  procDead: boolean;
  /** 用户按了 ⏹ —— 明确要停，绝不重试 */
  interrupted: boolean;
  /** codex 协作协议失步：需要人工介入，重试也是白搭 */
  protocolFault?: string;
  /** 这是第几次尝试前的判定（1 = 首轮之后的第一条重试） */
  attempt: number;
  /** 能不能续：没有可续的会话记录就没得重试 */
  canResume: boolean;
  maxAttempts?: number;
  /** The watchdog may have been disabled while terminal delivery was pending. */
  enabled?: boolean;
}

export type AutoRetryDecision =
  | { retry: true; attempt: number; delayMs: number; maxAttempts: number }
  | { retry: false; reason: string };

/** 该不该把这一轮重发一次（以及等多久）。纯判定，无副作用。 */
export function decideAutoRetry(input: AutoRetryInput): AutoRetryDecision {
  const maxAttempts = input.maxAttempts ?? AUTO_RETRY_MAX_ATTEMPTS;
  if (input.interrupted) return { retry: false, reason: 'user-interrupt' };
  if (input.enabled === false) return { retry: false, reason: 'watchdog-disabled' };
  if (input.protocolFault) return { retry: false, reason: 'protocol-fault' };
  // 干净收尾（done/error/中断）不是「断了」，重试只会重复劳动。
  if (!input.timedOut && !input.procDead) return { retry: false, reason: 'clean-terminal' };
  if (!input.canResume) return { retry: false, reason: 'no-session' };
  if (!Number.isFinite(input.attempt) || input.attempt < 1) return { retry: false, reason: 'bad-attempt' };
  if (input.attempt > maxAttempts) return { retry: false, reason: 'exhausted' };
  return {
    retry: true,
    attempt: Math.floor(input.attempt),
    delayMs: autoRetryDelayMs(input.attempt),
    maxAttempts,
  };
}
