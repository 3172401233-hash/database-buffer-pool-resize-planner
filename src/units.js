const UNIT_FACTORS = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
};

export function parseBytes(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`无效的字节数: ${value}`);
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new TypeError(`无法解析内存大小: ${String(value)}`);
  }
  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/);
  if (!match) {
    throw new TypeError(`无法解析内存大小: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "b";
  return Math.round(amount * UNIT_FACTORS[unit]);
}

export function alignDown(bytes, pageSize) {
  return Math.floor(bytes / pageSize) * pageSize;
}

export function alignUp(bytes, pageSize) {
  return Math.ceil(bytes / pageSize) * pageSize;
}

export function formatBytes(bytes) {
  if (bytes === 0) {
    return "0 B";
  }
  const units = ["TB", "GB", "MB", "KB", "B"];
  const thresholds = [UNIT_FACTORS.tb, UNIT_FACTORS.gb, UNIT_FACTORS.mb, UNIT_FACTORS.kb, 1];
  for (let index = 0; index < units.length; index += 1) {
    if (bytes >= thresholds[index]) {
      const value = bytes / thresholds[index];
      const rounded = value >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
      return `${rounded} ${units[index]}`;
    }
  }
  return `${bytes} B`;
}
