import { alignDown } from "./units.js";
import { planShrink } from "./shrink.js";
import { planGrow } from "./grow.js";

export { parseBytes, formatBytes, alignDown, alignUp } from "./units.js";
export { MEMORY_RISK } from "./risk.js";
export { planShrink } from "./shrink.js";
export { planGrow } from "./grow.js";

export const DEFAULT_OPTIONS = Object.freeze({
  pageSizeBytes: 4096,
  maxBatchBytes: 256 * 1024 ** 2,
  flushRateBytesPerSec: 128 * 1024 ** 2,
  checkpointDurationSec: 2,
  allocDurationSecPerByte: 0,
  deadlineSec: 30,
  reserveFreeBytes: 512 * 1024 ** 2,
  cooldownSec: 10,
});

const REQUIRED_METRICS = [
  "currentSizeBytes",
  "targetSizeBytes",
  "workingSetBytes",
  "dirtyRatio",
  "dirtyWriteBudgetBytes",
  "freeMemoryBytes",
  "pageCacheBytes",
];

const OPTION_FIELDS = [
  "pageSizeBytes",
  "maxBatchBytes",
  "flushRateBytesPerSec",
  "checkpointDurationSec",
  "allocDurationSecPerByte",
  "deadlineSec",
  "reserveFreeBytes",
  "cooldownSec",
];

function validate(input, options) {
  for (const field of REQUIRED_METRICS) {
    if (input[field] === undefined || input[field] === null) {
      throw new TypeError(`缺少必需指标: ${field}`);
    }
  }
  for (const field of REQUIRED_METRICS) {
    const value = input[field] ?? options[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`字段 ${field} 必须是非负有限数值，实际为: ${String(value)}`);
    }
  }
  for (const field of OPTION_FIELDS) {
    const value = options[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`字段 ${field} 必须是非负有限数值，实际为: ${String(value)}`);
    }
  }
  if (input.dirtyRatio > 1) {
    throw new RangeError("dirtyRatio 必须在 0 到 1 之间（脏页比例）。");
  }
  if (options.flushRateBytesPerSec <= 0) {
    throw new RangeError("flushRateBytesPerSec 必须大于 0。");
  }
  if (options.pageSizeBytes <= 0) {
    throw new RangeError("pageSizeBytes 必须大于 0。");
  }
}

function buildHoldPlan(metrics, options, reason) {
  const currentSize = alignDown(metrics.currentSizeBytes, options.pageSizeBytes);
  return {
    direction: "hold",
    requestedTargetSizeBytes: metrics.targetSizeBytes,
    effectiveTargetSizeBytes: currentSize,
    finalSizeBytes: currentSize,
    completed: false,
    estimatedTotalFlushBytes: 0,
    estimatedTotalDurationSec: 0,
    batches: [],
    warnings: [reason],
  };
}

export function planResize(rawInput = {}) {
  const input = { ...rawInput };
  delete input.options;
  const topLevelOptions = {};
  for (const field of OPTION_FIELDS) {
    if (Object.hasOwn(input, field) && input[field] !== undefined) {
      topLevelOptions[field] = input[field];
      delete input[field];
    }
  }
  const options = { ...DEFAULT_OPTIONS, ...topLevelOptions, ...rawInput.options };
  validate(input, options);

  const nowMs = input.nowMs ?? Date.now();
  const history = Array.isArray(input.history) ? input.history : [];
  const direction =
    input.targetSizeBytes === input.currentSizeBytes
      ? "hold"
      : input.targetSizeBytes < input.currentSizeBytes
        ? "shrink"
        : "grow";

  if (direction === "hold") {
    return buildHoldPlan(input, options, "目标大小与当前大小一致，无需调整。");
  }

  const lastDecision = history[history.length - 1];
  if (lastDecision && lastDecision.direction !== "hold" && lastDecision.direction !== direction) {
    const ageSec = (nowMs - lastDecision.atMs) / 1000;
    if (ageSec < options.cooldownSec) {
      return buildHoldPlan(
        input,
        options,
        `距离上一次 ${lastDecision.direction} 决策仅 ${ageSec.toFixed(3)}s，短于冷却窗口 ${options.cooldownSec}s；抑制 ${direction} 以避免扩缩容反复切换。`,
      );
    }
  }

  const metrics = {
    currentSizeBytes: input.currentSizeBytes,
    targetSizeBytes: input.targetSizeBytes,
    workingSetBytes: input.workingSetBytes,
    dirtyRatio: input.dirtyRatio,
    dirtyWriteBudgetBytes: input.dirtyWriteBudgetBytes,
    freeMemoryBytes: input.freeMemoryBytes,
    pageCacheBytes: input.pageCacheBytes,
  };

  const plan =
    direction === "shrink" ? planShrink(metrics, options) : planGrow(metrics, options);
  return { ...plan, decidedAtMs: nowMs, cooldownSec: options.cooldownSec };
}

export function recordDecision(history, plan, atMs = Date.now()) {
  const entry = {
    atMs,
    direction: plan.direction,
    fromSizeBytes: plan.batches.length > 0 ? plan.batches[0].fromSizeBytes : plan.finalSizeBytes,
    finalSizeBytes: plan.finalSizeBytes,
    completed: plan.completed,
  };
  history.push(entry);
  return entry;
}
