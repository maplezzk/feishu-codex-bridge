import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import goalFactory from "./upstream/index.ts";

export const BRIDGE_PI_GOAL_PREFIX = "BRIDGE_PI_GOAL_V1:";
const GOAL_STATE_ENTRY = "bridge-goal-state";
const LEGACY_GOALS_STATE_ENTRY = "bridge-goals-state";
const START_TIMEOUT_MS = 20_000;
const CANCEL_TIMEOUT_MS = 20_000;

const settingsPath = fileURLToPath(new URL("./settings.json", import.meta.url));

/**
 * Decode the only wire argument accepted by /bridge-goal. Keeping the command
 * as base64url JSON prevents spaces/newlines in objective text from changing
 * Pi's slash-command tokenization.
 */
export function decodeBridgeGoalCommand(args) {
  const token = String(args ?? "").trim();
  if (!token) throw bridgeError("INVALID_REQUEST", "bridge-goal command payload is empty");
  if (!/^[A-Za-z0-9_-]+$/u.test(token)) {
    throw bridgeError("INVALID_REQUEST", "bridge-goal command payload is not base64url");
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch (error) {
    throw bridgeError("INVALID_REQUEST", `bridge-goal command payload is invalid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) throw bridgeError("INVALID_REQUEST", "bridge-goal command must be a JSON object");
  const requestId = typeof value.requestId === "string" ? value.requestId.trim() : "";
  if (!requestId) throw bridgeError("INVALID_REQUEST", "requestId must be a non-empty string");
  const action = value.action;
  if (action !== "start" && action !== "status" && action !== "clear" && action !== "cancel") {
    throw bridgeError("INVALID_REQUEST", "action must be start, status, clear, or cancel", requestId);
  }
  const runId = value.runId === undefined ? undefined : stringValue(value.runId, "runId", requestId);
  const objective = value.objective === undefined ? undefined : stringValue(value.objective, "objective", requestId);
  const tokenBudget = value.tokenBudget === undefined ? undefined : value.tokenBudget;
  if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) {
    throw bridgeError("INVALID_REQUEST", "tokenBudget must be a positive integer", requestId);
  }
  if (action === "start" && (!objective || !objective.trim())) {
    throw bridgeError("INVALID_REQUEST", "objective must be a non-empty string", requestId);
  }
  if (action === "cancel" && !runId) {
    throw bridgeError("INVALID_REQUEST", "cancel requires runId", requestId);
  }
  return {
    requestId,
    action,
    ...(runId === undefined ? {} : { runId }),
    ...(objective === undefined ? {} : { objective }),
    ...(tokenBudget === undefined ? {} : { tokenBudget })
  };
}

function stringValue(value, field, requestId) {
  if (typeof value !== "string" || !value.trim()) {
    throw bridgeError("INVALID_REQUEST", `${field} must be a non-empty string`, requestId);
  }
  return value.trim();
}

function bridgeError(code, message, requestId = "") {
  const error = new Error(message);
  error.code = code;
  error.requestId = requestId;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function finiteNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function cloneGoal(goal) {
  if (!isRecord(goal)) return undefined;
  const cloned = { ...goal };
  if (isRecord(goal.waiting)) cloned.waiting = { ...goal.waiting };
  return cloned;
}

function latestGoalFromSession(ctx) {
  const entries = ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom") continue;
    if (entry.customType === GOAL_STATE_ENTRY && isRecord(entry.data)) {
      return entry.data.goal === null ? null : cloneGoal(entry.data.goal);
    }
    if (entry.customType === LEGACY_GOALS_STATE_ENTRY && isRecord(entry.data)) {
      if (isRecord(entry.data.goal)) return cloneGoal(entry.data.goal);
      if (Array.isArray(entry.data.goals) && entry.data.goals.length === 1) return cloneGoal(entry.data.goals[0]);
      return undefined;
    }
  }
  return undefined;
}

function pauseRestoredActiveGoal(pi, ctx) {
  const restored = latestGoalFromSession(ctx);
  if (!restored || restored.status !== "active") return;
  const paused = {
    ...restored,
    status: "paused",
    activeStartedAt: undefined,
    waiting: undefined,
    updatedAt: Date.now()
  };
  // This is a native session entry. It intentionally runs before upstream's
  // session_start hook, so upstream never sees an active restored Goal that it
  // could automatically continue.
  pi.appendEntry(GOAL_STATE_ENTRY, { goal: paused });
}

function goalSnapshot(goal, fallback = {}) {
  const source = isRecord(goal) ? goal : {};
  const goalId = typeof source.id === "string" ? source.id : fallback.goalId;
  if (!goalId) return null;
  const status = typeof fallback.status === "string" ? fallback.status : typeof source.status === "string" ? source.status : "paused";
  const activeStartedAt = source.activeStartedAt;
  const waiting = isRecord(source.waiting) ? { ...source.waiting } : undefined;
  const activeClock = status === "active" && !waiting && typeof activeStartedAt === "number"
    ? Math.max(0, (Date.now() - activeStartedAt) / 1000)
    : 0;
  const timeUsedSeconds = finiteNumber(source.timeUsedSeconds) + activeClock;
  const tokenBudget = Number.isSafeInteger(source.tokenBudget) && source.tokenBudget > 0 ? source.tokenBudget : null;
  return {
    goalId,
    objective: typeof source.text === "string" ? source.text : String(fallback.objective ?? ""),
    status,
    tokensUsed: finiteNumber(source.tokensUsed, finiteNumber(fallback.tokensUsed)),
    timeUsedSeconds,
    tokenBudget,
    ...(waiting ? { waiting } : {})
  };
}

function sessionHeader(ctx) {
  return ctx?.sessionManager?.getHeader?.() ?? null;
}

function eventError(value) {
  const error = isRecord(value?.error) ? value.error : {};
  return {
    code: typeof error.code === "string" ? error.code : "GOAL_ERROR",
    message: typeof error.message === "string" ? error.message : "pi-goal returned an unknown error"
  };
}

function runChannel(runId) {
  return `bridge-pi-goal:event:${runId}`;
}

function isTerminal(status) {
  return status !== "active";
}

function notifyProtocol(ctx, message) {
  if (!ctx?.ui || typeof ctx.ui.notify !== "function") {
    throw new Error("Pi Goal bridge has no RPC notification channel");
  }
  ctx.ui.notify(`${BRIDGE_PI_GOAL_PREFIX}${JSON.stringify(message)}`, "info");
}

function reply(ctx, requestId, ok, data, error) {
  notifyProtocol(ctx, {
    version: 1,
    kind: "reply",
    requestId,
    ok,
    ...(ok ? { data } : { error })
  });
}

function stateMessage(runId, event, goal) {
  const snapshot = goalSnapshot(goal, event);
  if (!snapshot) return null;
  return {
    version: 1,
    kind: "state",
    runId,
    ...snapshot,
    ...(typeof event.summary === "string" ? { summary: event.summary } : {}),
    ...(typeof event.reason === "string" ? { reason: event.reason } : {})
  };
}

function runErrorMessage(runId, event) {
  return {
    version: 1,
    kind: "error",
    runId,
    error: eventError(event)
  };
}

function waitForEvent(state, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject };
    state.waiters.add(waiter);
    const timer = setTimeout(() => {
      if (!state.waiters.delete(waiter)) return;
      const error = bridgeError("TIMEOUT", `timed out waiting for pi-goal run ${state.runId}`);
      reject(error);
      state.onFailure?.(error);
    }, timeoutMs);
    waiter.cleanup = () => clearTimeout(timer);
  });
}

function settleWaiters(state, event) {
  for (const waiter of [...state.waiters]) {
    let matches = false;
    try {
      matches = waiter.predicate(event);
    } catch (error) {
      state.waiters.delete(waiter);
      waiter.cleanup?.();
      waiter.reject(error);
      continue;
    }
    if (!matches) continue;
    state.waiters.delete(waiter);
    waiter.cleanup?.();
    waiter.resolve(event);
  }
}

function createRunState(runId, objective, generation) {
  return {
    runId,
    objective,
    generation,
    goalId: undefined,
    goal: undefined,
    status: "pending",
    terminal: false,
    clearRequested: false,
    waiters: new Set(),
    unsubscribe: undefined
  };
}

export default function bridgeGoalExtension(pi) {
  let currentCtx;
  let generation = 0;
  let runtime;
  let commands;
  let runController;
  let currentRun;
  let lastOwnedRun;
  const goalCache = new Map();
  const runs = new Map();

  const unsubscribeRun = (run) => {
    run.unsubscribe?.();
    run.unsubscribe = undefined;
    for (const waiter of [...run.waiters]) {
      run.waiters.delete(waiter);
      waiter.cleanup?.();
      waiter.reject(bridgeError("SESSION_CHANGED", "pi-goal session changed while waiting for the run"));
    }
    runs.delete(run.runId);
  };

  const failRun = (run) => {
    if (run.failed) return;
    run.failed = true;
    const owned = currentRun === run;
    if (owned) currentRun = undefined;
    unsubscribeRun(run);
    if (!owned) return;
    // Cancel pending activation through upstream as well as clearing an
    // already-owned Goal. Losing the bridge waiter must not leave it running.
    pi.events.emit("bridge-pi-goal:cancel", { runId: run.runId });
    if (runtime?.activeGoal && runtime.activeGoal.id === run.goalId) {
      runtime.clearActiveGoal(currentCtx, "managed bridge request failed");
      currentCtx?.abort?.();
    }
  };

  const onRunEvent = (run, event) => {
    if (run.generation !== generation) return;
    if (!isRecord(event)) return;
    if (event.type === "state") {
      // Terminal events are queued after upstream clears activeGoal. Carry the
      // snapshot captured at persist time so usage and waiting are not lost.
      const activeGoal = isRecord(event.goal) ? event.goal : runtime?.activeGoal;
      if (activeGoal && activeGoal.id === event.goalId) {
        run.goal = cloneGoal(activeGoal);
        goalCache.set(event.goalId, run.goal);
      }
      const cached = goalCache.get(event.goalId);
      run.goalId = typeof event.goalId === "string" ? event.goalId : run.goalId;
      run.status = typeof event.status === "string" ? event.status : run.status;
      const message = stateMessage(run.runId, event, activeGoal?.id === event.goalId ? activeGoal : cached);
      if (message) notifyProtocol(currentCtx, message);
      settleWaiters(run, event);
      if (isTerminal(run.status)) {
        run.terminal = true;
        lastOwnedRun = {
          runId: run.runId,
          goalId: run.goalId,
          objective: run.objective,
          status: run.status,
          goal: run.goal
        };
        if (currentRun === run) currentRun = undefined;
        queueMicrotask(() => unsubscribeRun(run));
      }
      return;
    }
    if (event.type === "error") {
      const error = eventError(event);
      notifyProtocol(currentCtx, runErrorMessage(run.runId, event));
      settleWaiters(run, { ...event, error });
      failRun(run);
    }
  };

  const listenForRun = (run) => {
    const unsubscribe = pi.events.on(runChannel(run.runId), (event) => onRunEvent(run, event));
    run.unsubscribe = unsubscribe;
    runs.set(run.runId, run);
    return run;
  };

  const runRequest = (runId, objective) => {
    const state = createRunState(runId, objective, generation);
    state.onFailure = () => failRun(state);
    listenForRun(state);
    return state;
  };

  const goalData = () => {
    const active = runtime?.activeGoal;
    return goalSnapshot(active ?? (lastOwnedRun?.goal ? lastOwnedRun.goal : undefined), {
      goalId: lastOwnedRun?.goalId,
      objective: lastOwnedRun?.objective,
      status: active?.status ?? lastOwnedRun?.status
    });
  };

  const replyData = () => ({
    goal: goalData(),
    sessionHeader: sessionHeader(currentCtx)
  });

  const clearedReplyData = (before) => ({
    goal: before ? { ...before, status: "cleared", waiting: undefined } : null,
    sessionHeader: sessionHeader(currentCtx)
  });

  const clearGoal = async (request, ctx) => {
    const active = runtime?.activeGoal;
    if (request.runId) {
      const owned = currentRun?.runId === request.runId
        ? currentRun
        : lastOwnedRun?.runId === request.runId
          ? lastOwnedRun
          : undefined;
      if (!owned) throw bridgeError("RUN_NOT_FOUND", "runId does not belong to a managed Goal", request.requestId);
      if (owned === currentRun && !owned.terminal) owned.clearRequested = true;
      if (active && owned.goalId && active.id !== owned.goalId) {
        throw bridgeError("RUN_SUPERSEDED", "runId no longer owns the current Goal", request.requestId);
      }
      if (!active && owned === currentRun && !owned.goalId && !owned.terminal) {
        owned.clearRequested = true;
        const eventPromise = waitForEvent(owned, (value) => value?.type === "state" && isTerminal(value.status) || value?.type === "error", CANCEL_TIMEOUT_MS);
        pi.events.emit("bridge-pi-goal:cancel", { runId: request.runId });
        const event = await eventPromise;
        if (event.type === "error") {
          throw bridgeError(event.error?.code ?? "CANCEL_FAILED", event.error?.message ?? "Goal start cancellation failed", request.requestId);
        }
        return clearedReplyData(null);
      }
      const before = active ? goalSnapshot(active) : goalData();
      if (active) runtime.clearActiveGoal(ctx, "goal cleared by bridge");
      return clearedReplyData(before);
    }
    if (!active) return replyData();
    if (active.status === "active" || currentRun) {
      throw bridgeError("RUN_ID_REQUIRED", "an active managed Goal requires its exact runId", request.requestId);
    }
    const before = goalSnapshot(active);
    runtime.clearActiveGoal(ctx, "stopped Goal cleared before a new bridge run");
    return clearedReplyData(before);
  };

  const handleRequest = async (request, ctx) => {
    switch (request.action) {
      case "status":
        reply(ctx, request.requestId, true, replyData());
        return;
      case "start": {
        const runId = request.runId ?? randomUUID();
        if (runtime?.activeGoal) {
          throw bridgeError("GOAL_ALREADY_EXISTS", "A Goal already exists; clear the restored Goal first", request.requestId);
        }
        const run = runRequest(runId, request.objective);
        currentRun = run;
        const eventPromise = waitForEvent(run, (value) => value?.type === "state" && value.status === "active" || value?.type === "error", START_TIMEOUT_MS);
        pi.events.emit("bridge-pi-goal:start", {
          runId,
          objective: request.objective,
          ...(request.tokenBudget === undefined ? {} : { tokenBudget: request.tokenBudget })
        });
        const event = await eventPromise;
        if (event.type === "error") {
          if (currentRun === run) currentRun = undefined;
          throw bridgeError(event.error?.code ?? "ACTIVATION_FAILED", event.error?.message ?? "Goal activation failed", request.requestId);
        }
        if (run.clearRequested) {
          const terminal = await waitForEvent(run, (value) => value?.type === "state" && isTerminal(value.status) || value?.type === "error", CANCEL_TIMEOUT_MS);
          if (terminal.type === "error") {
            throw bridgeError(terminal.error?.code ?? "CANCEL_FAILED", terminal.error?.message ?? "Goal start cancellation failed", request.requestId);
          }
          throw bridgeError("CLEARED", "Goal start was cleared before activation completed", request.requestId);
        }
        reply(ctx, request.requestId, true, replyData());
        return;
      }
      case "cancel": {
        const run = currentRun?.runId === request.runId ? currentRun : undefined;
        if (!run) throw bridgeError("RUN_NOT_FOUND", "runId does not belong to a managed Goal", request.requestId);
        const eventPromise = waitForEvent(run, (value) => value?.type === "state" && isTerminal(value.status) || value?.type === "error", CANCEL_TIMEOUT_MS);
        pi.events.emit("bridge-pi-goal:cancel", { runId: request.runId });
        const event = await eventPromise;
        if (event.type === "error") {
          throw bridgeError(event.error?.code ?? "CANCEL_FAILED", event.error?.message ?? "Goal cancel failed", request.requestId);
        }
        reply(ctx, request.requestId, true, replyData());
        return;
      }
      case "clear": {
        const data = await clearGoal(request, ctx);
        reply(ctx, request.requestId, true, data);
        return;
      }
      default:
        throw bridgeError("INVALID_REQUEST", `unsupported bridge-goal action: ${request.action}`, request.requestId);
    }
  };

  // This hook is intentionally registered before the vendored upstream hook.
  // Restored active state is made paused in the native session before upstream
  // can bind its workflow and schedule an automatic continuation.
  pi.on("session_start", (_event, ctx) => {
    generation += 1;
    for (const run of [...runs.values()]) unsubscribeRun(run);
    currentRun = undefined;
    lastOwnedRun = undefined;
    goalCache.clear();
    currentCtx = ctx;
    pauseRestoredActiveGoal(pi, ctx);
  });

  // Shutdown can race with a queued continuation. Persisting paused state in
  // the native session makes the next load safe even if the process disappears
  // immediately after this handler returns.
  pi.on("session_shutdown", (_event, ctx) => {
    if (runtime) {
      runtime.cancelContinuationWork?.();
      runtime.clearGoalRecovery?.();
      runtime.clearGoalWaitTimer?.();
      runtime.clearBudgetWrapUp?.();
      const active = runtime.activeGoal;
      if (active?.status === "active") {
        runtime.activeGoal = {
          ...active,
          status: "paused",
          activeStartedAt: undefined,
          waiting: undefined,
          updatedAt: Date.now()
        };
        runtime.persistGoal(runtime.activeGoal);
      }
    }
    currentCtx = ctx;
  });

  const handles = goalFactory(pi, { settingsPath });
  runtime = handles.runtime;
  commands = handles.commands;
  runController = handles.runController;

  pi.registerCommand("bridge-goal", {
    description: "Control the vendored pi-goal runtime with base64url JSON",
    handler: async (args, ctx) => {
      let request;
      try {
        request = decodeBridgeGoalCommand(args);
      } catch (error) {
        const requestId = typeof error?.requestId === "string" ? error.requestId : "";
        const code = typeof error?.code === "string" ? error.code : "INVALID_REQUEST";
        const message = errorMessage(error);
        reply(ctx, requestId, false, undefined, { code, message });
        return;
      }
      try {
        await handleRequest(request, ctx);
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code : "COMMAND_FAILED";
        const message = errorMessage(error);
        reply(ctx, request.requestId, false, undefined, { code, message });
      }
    }
  });

  return { runtime, commands, runController };
}
