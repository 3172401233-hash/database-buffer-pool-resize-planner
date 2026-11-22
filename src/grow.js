import { alignDown, alignUp } from "./units.js";
import { MEMORY_RISK, classifyMemoryRisk } from "./risk.js";

export function planGrow(metrics, options) {
  const {
    currentSizeBytes,
    targetSizeBytes,
    freeMemoryBytes,
    pageCacheBytes,
  } = metrics;
  const {
    pageSizeBytes,
    maxBatchBytes,
    reserveFreeBytes,
    allocDurationSecPerByte,
    deadlineSec,
  } = options;

  const warnings = [];
  const batches = [];
  let currentSize = currentSizeBytes;
  let elapsedSec = 0;

  const headroomBytes = Math.max(0, freeMemoryBytes - reserveFreeBytes);
  const totalMemoryAvailable = freeMemoryBytes + pageCacheBytes;
  if (headroomBytes <= 0) {
    warnings.push(
      `空闲内存 ${freeMemoryBytes} 已低于保留水位 ${reserveFreeBytes}，无法继续扩容，保持在 ${currentSize}。`,
    );
  }

  while (currentSize < targetSizeBytes && headroomBytes > 0) {
    const remainingGrowth = targetSizeBytes - currentSize;
    const nextStep = Math.min(maxBatchBytes, remainingGrowth, headroomBytes);
    const cumulativeAfterNext = currentSize + nextStep - currentSizeBytes;
    const reclaimAfterNext = Math.max(0, cumulativeAfterNext - freeMemoryBytes);
    if (reclaimAfterNext > pageCacheBytes) {
      warnings.push(
        `再扩容 ${nextStep} 字节需要从页缓存回收 ${reclaimAfterNext} 字节，超过页缓存容量 ${pageCacheBytes}，规划停止。`,
      );
      break;
    }
    const safeStep = alignDown(
      Math.min(maxBatchBytes, remainingGrowth, headroomBytes, totalMemoryAvailable),
      pageSizeBytes,
    );
    if (safeStep <= 0) {
      break;
    }

    const sizeAfter = currentSize + safeStep;
    const cumulativeGrowth = sizeAfter - currentSizeBytes;
    const freeMemoryAfterBytes = Math.max(0, freeMemoryBytes - cumulativeGrowth);
    const reclaimFromPageCacheBytes = Math.max(0, cumulativeGrowth - freeMemoryBytes);
    const memoryRisk = classifyMemoryRisk({
      freeMemoryAfterBytes,
      reserveBytes: reserveFreeBytes,
      reclaimFromPageCacheBytes,
      pageCacheBytes,
    });

    const batchDuration = safeStep * allocDurationSecPerByte;
    if (elapsedSec + batchDuration > deadlineSec) {
      warnings.push(
        `下一批扩容预计耗时 ${batchDuration.toFixed(3)}s 超过 deadline 剩余 ${Math.max(0, deadlineSec - elapsedSec).toFixed(3)}s，规划提前停止。`,
      );
      break;
    }

    batches.push({
      index: batches.length + 1,
      direction: "grow",
      type: "grow",
      fromSizeBytes: currentSize,
      targetSizeBytes: sizeAfter,
      deltaBytes: safeStep,
      estimatedFlushBytes: 0,
      checkpointFlushBytes: 0,
      estimatedDurationSec: Math.round(batchDuration * 1000) / 1000,
      dirtyBudgetAfterBytes: null,
      memoryRisk,
      freeMemoryAfterBytes,
      pageCacheReclaimBytes: reclaimFromPageCacheBytes,
      rollbackPointBytes: currentSize,
    });

    elapsedSec += batchDuration;
    currentSize = sizeAfter;
  }

  const completed = alignUp(currentSize, pageSizeBytes) >= targetSizeBytes;
  if (!completed && warnings.length === 0) {
    warnings.push("扩容未能达到目标大小。");
  }

  return {
    direction: "grow",
    requestedTargetSizeBytes: targetSizeBytes,
    effectiveTargetSizeBytes: targetSizeBytes,
    finalSizeBytes: currentSize,
    completed,
    estimatedTotalFlushBytes: 0,
    estimatedTotalDurationSec: Math.round(elapsedSec * 1000) / 1000,
    batches,
    warnings,
  };
}
