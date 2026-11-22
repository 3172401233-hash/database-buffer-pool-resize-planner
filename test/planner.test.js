import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_OPTIONS,
  MEMORY_RISK,
  formatBytes,
  parseBytes,
  planResize,
  recordDecision,
} from "../src/index.js";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const baseMetrics = {
  currentSizeBytes: 4 * GB,
  targetSizeBytes: 2 * GB,
  workingSetBytes: 1.5 * GB,
  dirtyRatio: 0.1,
  dirtyWriteBudgetBytes: 1 * GB,
  freeMemoryBytes: 2 * GB,
  pageCacheBytes: 4 * GB,
};

test("parseBytes / formatBytes 支持常见内存单位字符串", () => {
  assert.equal(parseBytes("2GB"), 2 * GB);
  assert.equal(parseBytes("512 MB"), 512 * MB);
  assert.equal(parseBytes(1024), 1024);
  assert.equal(formatBytes(2 * GB), "2 GB");
  assert.throws(() => parseBytes("nope"), TypeError);
});

test("缩容时活动热工作集不能立刻逐出，目标被限制到工作集下限", () => {
  const plan = planResize({
    ...baseMetrics,
    targetSizeBytes: 1 * GB,
  });

  assert.equal(plan.direction, "shrink");
  assert.equal(plan.finalSizeBytes, plan.effectiveTargetSizeBytes);
  assert.equal(plan.effectiveTargetSizeBytes, align(1.5 * GB));
  assert.ok(plan.finalSizeBytes >= baseMetrics.workingSetBytes);
  assert.ok(plan.warnings.some((warning) => warning.includes("热工作集")));
  for (const batch of plan.batches) {
    assert.ok(batch.targetSizeBytes >= baseMetrics.workingSetBytes);
    assert.equal(batch.rollbackPointBytes, batch.fromSizeBytes);
  }
});

test("缩容分批执行，每批不超过最大批大小且页对齐", () => {
  const plan = planResize({
    ...baseMetrics,
    currentSizeBytes: 4 * GB,
    targetSizeBytes: 2 * GB,
  });

  assert.equal(plan.direction, "shrink");
  assert.equal(plan.completed, true);
  assert.ok(plan.batches.length >= 2);
  for (const batch of plan.batches) {
    assert.ok(Math.abs(batch.deltaBytes) <= DEFAULT_OPTIONS.maxBatchBytes);
    assert.equal(batch.targetSizeBytes % DEFAULT_OPTIONS.pageSizeBytes, 0);
    assert.ok(batch.estimatedFlushBytes > 0);
    assert.equal(batch.memoryRisk, MEMORY_RISK.LOW);
  }
  assert.equal(plan.batches[0].fromSizeBytes, 4 * GB);
  assert.equal(plan.batches.at(-1).targetSizeBytes, 2 * GB);
});

test("脏页预算不足时先触发检查点而不是无限等待", () => {
  const plan = planResize({
    ...baseMetrics,
    currentSizeBytes: 4 * GB,
    targetSizeBytes: 2 * GB,
    dirtyRatio: 0.3,
    dirtyWriteBudgetBytes: 256 * MB,
    maxBatchBytes: 1 * GB,
    flushRateBytesPerSec: 1 * GB,
  });

  const checkpointBatch = plan.batches.find((batch) => batch.type === "checkpoint+shrink");
  assert.ok(checkpointBatch, "应当至少有一批插入检查点");
  assert.ok(checkpointBatch.checkpointFlushBytes > 0);
  assert.ok(
    checkpointBatch.estimatedDurationSec >= DEFAULT_OPTIONS.checkpointDurationSec,
    "检查点批次必须包含检查点本身的耗时，而不是一直等待脏页预算",
  );
  assert.ok(checkpointBatch.dirtyBudgetAfterBytes >= 0);
  for (const batch of plan.batches) {
    assert.ok(batch.estimatedFlushBytes <= 256 * MB);
  }
  assert.equal(plan.completed, true);
});

test("deadline 不足时规划提前停止并保留回退点", () => {
  const plan = planResize({
    ...baseMetrics,
    currentSizeBytes: 4 * GB,
    targetSizeBytes: 1 * GB,
    dirtyRatio: 0.4,
    flushRateBytesPerSec: 64 * MB,
    maxBatchBytes: 128 * MB,
    deadlineSec: 1,
  });

  assert.equal(plan.completed, false);
  assert.ok(plan.finalSizeBytes > plan.effectiveTargetSizeBytes);
  assert.ok(plan.warnings.some((warning) => warning.includes("deadline")));
  assert.ok(plan.batches.length > 0);
  assert.equal(plan.batches.at(-1).rollbackPointBytes, plan.batches.at(-1).fromSizeBytes);
});

test("扩容在空闲内存充足时分批进行且不产生刷盘", () => {
  const plan = planResize({
    ...baseMetrics,
    currentSizeBytes: 2 * GB,
    targetSizeBytes: 3 * GB,
    freeMemoryBytes: 2 * GB,
    pageCacheBytes: 1 * GB,
  });

  assert.equal(plan.direction, "grow");
  assert.equal(plan.completed, true);
  assert.ok(plan.batches.length >= 2);
  assert.equal(plan.estimatedTotalFlushBytes, 0);
  for (const batch of plan.batches) {
    assert.equal(batch.direction, "grow");
    assert.equal(batch.estimatedFlushBytes, 0);
    assert.ok(batch.deltaBytes <= DEFAULT_OPTIONS.maxBatchBytes);
  }
});

test("扩容需要挤压页缓存时给出内存风险标记", () => {
  const plan = planResize({
    ...baseMetrics,
    currentSizeBytes: 2 * GB,
    targetSizeBytes: 3 * GB,
    freeMemoryBytes: 800 * MB,
    reserveFreeBytes: 512 * MB,
    pageCacheBytes: 1 * GB,
  });

  assert.ok(plan.batches.some((batch) => batch.pageCacheReclaimBytes > 0));
  assert.ok(
    plan.batches.some(
      (batch) => batch.memoryRisk === MEMORY_RISK.MEDIUM || batch.memoryRisk === MEMORY_RISK.HIGH,
    ),
  );
});

test("空闲内存低于保留水位时拒绝扩容并保持当前大小", () => {
  const plan = planResize({
    ...baseMetrics,
    currentSizeBytes: 2 * GB,
    targetSizeBytes: 3 * GB,
    freeMemoryBytes: 256 * MB,
    reserveFreeBytes: 512 * MB,
  });

  assert.equal(plan.direction, "grow");
  assert.equal(plan.completed, false);
  assert.equal(plan.batches.length, 0);
  assert.equal(plan.finalSizeBytes, 2 * GB);
  assert.ok(plan.warnings.some((warning) => warning.includes("保留水位")));
});

test("扩容超过页缓存可回收能力时标记 critical 并停止", () => {
  const plan = planResize({
    ...baseMetrics,
    currentSizeBytes: 2 * GB,
    targetSizeBytes: 3.4 * GB,
    freeMemoryBytes: 800 * MB,
    reserveFreeBytes: 256 * MB,
    pageCacheBytes: 300 * MB,
    maxBatchBytes: 256 * MB,
  });

  assert.ok(plan.batches.length > 0);
  assert.equal(plan.completed, false);
  assert.ok(
    plan.batches.some((batch) => batch.memoryRisk === MEMORY_RISK.HIGH),
    "触及页缓存回收上限前最后执行的批次应标记 high",
  );
  assert.ok(plan.warnings.some((warning) => warning.includes("页缓存")));
});

test("扩缩容反复切换：冷却窗口内反向决策被抑制为 hold", () => {
  const history = [];
  const t0 = 1_000_000;

  const shrinkPlan = planResize({
    ...baseMetrics,
    currentSizeBytes: 4 * GB,
    targetSizeBytes: 2 * GB,
    nowMs: t0,
    history,
  });
  assert.equal(shrinkPlan.direction, "shrink");
  recordDecision(history, shrinkPlan, shrinkPlan.decidedAtMs);

  const growPlan = planResize({
    ...baseMetrics,
    currentSizeBytes: 2 * GB,
    targetSizeBytes: 4 * GB,
    nowMs: t0 + 3_000,
    history,
  });
  assert.equal(growPlan.direction, "hold");
  assert.equal(growPlan.batches.length, 0);
  assert.ok(growPlan.warnings.some((warning) => warning.includes("冷却窗口")));

  const laterGrowPlan = planResize({
    ...baseMetrics,
    currentSizeBytes: 2 * GB,
    targetSizeBytes: 4 * GB,
    nowMs: t0 + 11_000,
    history,
  });
  assert.equal(laterGrowPlan.direction, "grow");
  assert.equal(laterGrowPlan.completed, true);
});

test("同方向连续调整不受冷却窗口影响", () => {
  const history = [];
  const t0 = 2_000_000;
  const first = planResize({
    ...baseMetrics,
    currentSizeBytes: 4 * GB,
    targetSizeBytes: 3 * GB,
    nowMs: t0,
    history,
  });
  recordDecision(history, first, first.decidedAtMs);

  const second = planResize({
    ...baseMetrics,
    currentSizeBytes: 3 * GB,
    targetSizeBytes: 2 * GB,
    nowMs: t0 + 1_000,
    history,
  });
  assert.equal(second.direction, "shrink");
  assert.equal(second.completed, true);
});

test("目标等于当前大小时返回 hold", () => {
  const plan = planResize({
    ...baseMetrics,
    currentSizeBytes: 4 * GB,
    targetSizeBytes: 4 * GB,
  });
  assert.equal(plan.direction, "hold");
  assert.equal(plan.batches.length, 0);
});

test("非法输入抛出明确错误", () => {
  assert.throws(() => planResize({ ...baseMetrics, targetSizeBytes: undefined }), TypeError);
  assert.throws(() => planResize({ ...baseMetrics, dirtyRatio: 1.5 }), RangeError);
  assert.throws(
    () => planResize({ ...baseMetrics, flushRateBytesPerSec: 0 }),
    RangeError,
  );
});

function align(bytes) {
  return Math.floor(bytes / DEFAULT_OPTIONS.pageSizeBytes) * DEFAULT_OPTIONS.pageSizeBytes;
}
