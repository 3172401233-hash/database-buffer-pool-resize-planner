export const MEMORY_RISK = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
});

export function classifyMemoryRisk({
  freeMemoryAfterBytes,
  reserveBytes,
  reclaimFromPageCacheBytes,
  pageCacheBytes,
}) {
  if (reclaimFromPageCacheBytes > pageCacheBytes) {
    return MEMORY_RISK.CRITICAL;
  }
  if (freeMemoryAfterBytes >= reserveBytes && reclaimFromPageCacheBytes === 0) {
    return MEMORY_RISK.LOW;
  }
  if (reclaimFromPageCacheBytes > pageCacheBytes * 0.5) {
    return MEMORY_RISK.HIGH;
  }
  return MEMORY_RISK.MEDIUM;
}
