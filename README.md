# database-buffer-pool-resize-planner

在线数据库缓冲池（buffer pool）扩缩容**规划器**。它不直接操作数据库，而是根据一组当前指标，
生成可分批执行的扩容或缩容计划，控制 I/O 峰值、脏页刷盘节奏和内存压力，并为每一批给出回退点。

运行环境：Node.js `24.16.0`（`engines` 要求 `>=24.16.0`），仅使用 Node 内置模块，无第三方依赖。

## 重要前提：所有内存数值都是输入假设

本库**不采集任何真实指标**，也不知道你的数据库或操作系统的真实内存布局。
下面出现的所有字节数（缓冲池大小、工作集、脏页比例、脏页预算、空闲内存、页缓存、刷盘吞吐、
deadline 等）都必须由调用方作为**输入假设**提供。

- 规划结果的正确性完全依赖这些输入假设；垃圾输入会产生误导性计划。
- `DEFAULT_OPTIONS` 中的默认值（页大小、批大小、刷盘速率等）同样只是通用假设，不代表任何具体机器。
- 输出中的 `estimatedFlushBytes`、`estimatedDurationSec`、`memoryRisk` 均为基于假设的估算，不是实测值。
- 接入真实系统前，需要由调用方把监控/采样数据换算成下方列出的字段，并自行校准默认参数。

## 解决的问题

- **缩容**：被释放的帧里可能有活动页和脏页。活动页不能立刻逐出，因此缩容下限受当前热工作集约束；
  脏页必须先刷盘，刷得太猛会制造 I/O 峰值、拉长查询延迟。
- **脏页预算不足**：当一批预计刷盘量超过剩余脏页写预算时，规划器先插入一个**检查点批次**
  （把当前脏页整体刷盘并重置预算），而不是无限等待预算自然恢复。
- **扩容**：缓冲池变大需要从空闲内存或操作系统页缓存（page cache）拿内存，可能与页缓存争抢；
  规划器逐批评估回收量和内存风险（`low` / `medium` / `high` / `critical`）。
- **查询 deadline**：每批都估算耗时，累计耗时超过 `deadlineSec` 时提前停止并保留已规划的回退点。
- **反复切换**：通过冷却窗口（`cooldownSec`）抑制短时间内扩容/缩容方向来回抖动，冷却期内反向请求返回 `hold`。

## 快速开始

```bash
npm test          # node --test，运行全部单元测试
node examples/basic.js
```

```js
import { planResize } from "./src/index.js";

const plan = planResize({
  // —— 以下全部是调用方提供的输入假设（字节）——
  currentSizeBytes: 4 * 1024 ** 3,
  targetSizeBytes: 2 * 1024 ** 3,
  workingSetBytes: 1.5 * 1024 ** 3,   // 热工作集，活动页所在
  dirtyRatio: 0.3,                     // 当前缓冲池脏页比例 0..1
  dirtyWriteBudgetBytes: 256 * 1024 ** 2,
  freeMemoryBytes: 2 * 1024 ** 3,
  pageCacheBytes: 4 * 1024 ** 3,
  // 可选调参（也可放在 options 对象里）
  deadlineSec: 30,
});
```

## 输入字段

必填指标（均为非负数值，字节单位；`dirtyRatio` 为 0..1 的比例）：

| 字段 | 含义 |
| --- | --- |
| `currentSizeBytes` | 当前缓冲池大小 |
| `targetSizeBytes` | 期望目标大小 |
| `workingSetBytes` | 当前热工作集（活动页），缩容不得越过该下限 |
| `dirtyRatio` | 脏页占缓冲池比例 |
| `dirtyWriteBudgetBytes` | 单个预算周期内允许的脏页刷盘量 |
| `freeMemoryBytes` | 系统当前空闲内存（输入假设） |
| `pageCacheBytes` | 操作系统页缓存可被回收的规模（输入假设） |

可选参数（顶层或 `options` 内传入，默认值见 `src/index.js` 的 `DEFAULT_OPTIONS`）：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `pageSizeBytes` | `4096` | 页大小，所有批次按其对齐 |
| `maxBatchBytes` | `256 MiB` | 单批最大变动量，用于压制 I/O 峰值 |
| `flushRateBytesPerSec` | `128 MiB/s` | 假设的脏页刷盘吞吐，用于估算耗时 |
| `checkpointDurationSec` | `2` | 一次检查点本身的固定耗时假设 |
| `allocDurationSecPerByte` | `0` | 扩容分配每字节耗时假设（默认忽略） |
| `deadlineSec` | `30` | 查询可接受的规划执行窗口 |
| `reserveFreeBytes` | `512 MiB` | 必须保留的空闲内存水位 |
| `cooldownSec` | `10` | 反向调整的冷却窗口 |

另外支持 `history`（历史决策数组，配合 `recordDecision` 维护）和 `nowMs`（确定性测试用时间戳）。

## 输出结构

计划顶层包含 `direction`（`shrink` / `grow` / `hold`）、`finalSizeBytes`、`completed`、
`estimatedTotalFlushBytes`、`estimatedTotalDurationSec` 和 `warnings`。
每个 `batches[]` 元素给出：

- `targetSizeBytes` / `deltaBytes`：该批目标大小与变动量；
- `estimatedFlushBytes`：预计刷盘量（扩容批为 0），检查点批另有 `checkpointFlushBytes`；
- `estimatedDurationSec`：基于刷盘吞吐假设的批耗时；
- `memoryRisk`：`low` / `medium` / `high` / `critical`；
- `freeMemoryAfterBytes` / `pageCacheReclaimBytes`：执行后的内存与页缓存回收假设；
- `rollbackPointBytes`：该批执行前的大小，失败时回退到这里。

## 策略摘要

- 缩容目标低于工作集时，实际下限被夹到 `workingSetBytes` 并产生警告。
- 单批刷盘量超过剩余脏页预算时插入 `checkpoint+shrink` 批：先整体刷盘、重置预算，再执行缩容。
- 扩容步进同时受 `maxBatchBytes`、空闲内存水位和 `freeMemory + pageCache` 总可用量约束；
  下一步会超过页缓存回收能力时停止并标注原因。
- 任何一批预计使累计耗时突破 `deadlineSec` 时，规划在该批之前停止，`completed` 为 `false`。

## 测试

`node --test`（或 `npm test`）覆盖：热工作集保护、分批与页对齐、脏页过多触发检查点、
deadline 提前停止、扩容内存风险分级、内存不足拒绝扩容、页缓存临界（critical）停止、
扩缩容反复切换的冷却抑制，以及输入校验。
