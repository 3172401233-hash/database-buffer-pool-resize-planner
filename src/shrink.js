import { alignDown } from "./units.js";
import { MEMORY_RISK, classifyMemoryRisk } from "./risk.js";

function flushSeconds(flushBytes, flushRateBytesPerSec) {
  if (flushBytes <= 0) {
    return 0;
  }
  return flushBytes / flushRateBytesPerSec;
}

function remainingTime(elapsedSeconds, deadlineSeconds) {
  return Math.max(0, deadlineSeconds - elapsedSeconds);
}

export function planShrink(metrics, options) {
  const {
    currentSizeBytes,
    targetSizeBytes,
    workingSetBytes,
    dirtyRatio,
    dirtyWriteBudgetBytes,
    freeMemoryBytes,
    pageCacheBytes,
  } = metrics;
  const {
    pageSizeBytes,
    maxBatchBytes,
    flushRateBytesPerSec,
    checkpointDurationSec,
    deadlineSec,
    reserveFreeBytes,
  } = options;

  const warnings = [];
  const batches = [];
  let currentSize = currentSizeBytes;
  let remainingBudget = dirtyWriteBudgetBytes;
  let elapsedSec = 0;

  const effectiveTarget = Math.max(targetSizeBytes, workingSetBytes);
  if (targetSizeBytes < workingSetBytes) {
    warnings.push(
      `目标大小 ${targetSizeBytes} 小于热工作集 ${workingSetBytes}，缩容下限被限制为工作集大小；活动页不能立刻逐出。`,
    );
  }

  while (currentSize > effectiveTarget) {
    const maxStepBySize = alignDown(Math.min(maxBatchBytes, currentSize - effectiveTarget), pageSizeBytes);
    let step = maxStepBySize;
    if (step <= 0) {
      break;
    }

    let estimatedFlush = Math.ceil(step * dirtyRatio);
    let needsCheckpoint = false;
    let checkpointFlushBytes = 0;
    if (estimatedFlush > remainingBudget) {
      needsCheckpoint = true;
      checkpointFlushBytes = Math.ceil(currentSize * dirtyRatio);
      const checkpointElapsed = elapsedSec + checkpointDurationSec + flushSeconds(checkpointFlushBytes, flushRateBytesPerSec);
      if (checkpointElapsed > deadlineSec) {
        warnings.push(
          `查询 deadline 剩余 ${remainingTime(elapsedSec, deadlineSec).toFixed(3)}s 不足以完成检查点，规划在当前大小 ${currentSize} 处停止。`,
        );
        break;
      }
      step = alignDown(Math.min(step, dirtyWriteBudgetBytes), pageSizeBytes);
      estimatedFlush = Math.ceil(step * dirtyRatio);
    }

    if (step <= 0) {
      warnings.push("单批可缩容量被脏页预算和页大小压到 0，规划停止；请调大脏页预算或检查点吞吐。");
      break;
    }

    const flushSec = flushSeconds(estimatedFlush, flushRateBytesPerSec);
    const batchDuration = (needsCheckpoint ? checkpointDurationSec : 0) + flushSec;
    if (elapsedSec + batchDuration > deadlineSec) {
      warnings.push(
        `下一批预计耗时 ${batchDuration.toFixed(3)}s 超过 deadline 剩余 ${remainingTime(elapsedSec, deadlineSec).toFixed(3)}s，规划提前停止。`,
      );
      break;
    }

    const sizeAfter = currentSize - step;
    const releasedMemoryBytes = currentSize - sizeAfter;
    const freeMemoryAfterBytes = freeMemoryBytes + releasedMemoryBytes;
    const memoryRisk = classifyMemoryRisk({
      freeMemoryAfterBytes,
      reserveBytes: reserveFreeBytes,
      reclaimFromPageCacheBytes: 0,
      pageCacheBytes,
    });

    batches.push({
      index: batches.length + 1,
      direction: "shrink",
      type: needsCheckpoint ? "checkpoint+shrink" : "shrink",
      fromSizeBytes: currentSize,
      targetSizeBytes: sizeAfter,
      deltaBytes: -step,
      estimatedFlushBytes: estimatedFlush,
      checkpointFlushBytes,
      estimatedDurationSec: Math.round(batchDuration * 1000) / 1000,
      dirtyBudgetAfterBytes: needsCheckpoint
        ? dirtyWriteBudgetBytes - estimatedFlush
        : remainingBudget - estimatedFlush,
      memoryRisk,
      freeMemoryAfterBytes,
      pageCacheReclaimBytes: 0,
      rollbackPointBytes: currentSize,
    });

    elapsedSec += batchDuration;
    currentSize = sizeAfter;
    remainingBudget = needsCheckpoint
      ? dirtyWriteBudgetBytes - estimatedFlush
      : remainingBudget - estimatedFlush;
  }

  const effectiveTargetAligned = alignDown(effectiveTarget, pageSizeBytes);
  const completed = alignDown(currentSize, pageSizeBytes) <= effectiveTargetAligned;
  if (!completed && !warnings.some((warning) => warning.includes("deadline") || warning.includes("停止"))) {
    warnings.push("缩容未能达到目标大小。");
  }

  return {
    direction: "shrink",
    requestedTargetSizeBytes: targetSizeBytes,
    effectiveTargetSizeBytes: effectiveTargetAligned,
    finalSizeBytes: currentSize,
    completed,
    estimatedTotalFlushBytes: batches.reduce((sum, batch) => sum + batch.estimatedFlushBytes + batch.checkpointFlushBytes, 0),
    estimatedTotalDurationSec: Math.round(elapsedSec * 1000) / 1000,
    batches,
    warnings,
  };
}
