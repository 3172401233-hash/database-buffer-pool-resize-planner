import { formatBytes, planResize, recordDecision } from "../src/index.js";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const history = [];

const shrinkPlan = planResize({
  currentSizeBytes: 8 * GB,
  targetSizeBytes: 3 * GB,
  workingSetBytes: 4 * GB,
  dirtyRatio: 0.25,
  dirtyWriteBudgetBytes: 512 * MB,
  freeMemoryBytes: 1 * GB,
  pageCacheBytes: 6 * GB,
  deadlineSec: 20,
});

console.log("== 缩容计划 ==");
for (const batch of shrinkPlan.batches) {
  console.log(
    `#${batch.index} ${batch.type} ${formatBytes(batch.fromSizeBytes)} -> ${formatBytes(batch.targetSizeBytes)}` +
      ` | 刷盘 ${formatBytes(batch.estimatedFlushBytes)} | 风险 ${batch.memoryRisk}` +
      ` | 回退点 ${formatBytes(batch.rollbackPointBytes)}`,
  );
}
console.log("警告:", shrinkPlan.warnings);
recordDecision(history, shrinkPlan, shrinkPlan.decidedAtMs);

const growPlan = planResize({
  currentSizeBytes: 4 * GB,
  targetSizeBytes: 6 * GB,
  workingSetBytes: 4 * GB,
  dirtyRatio: 0.05,
  dirtyWriteBudgetBytes: 1 * GB,
  freeMemoryBytes: 700 * MB,
  pageCacheBytes: 2 * GB,
  history,
  nowMs: shrinkPlan.decidedAtMs + 2_000,
});

console.log("\n== 冷却窗口内的扩容请求 ==");
console.log("方向:", growPlan.direction, "| 警告:", growPlan.warnings);
