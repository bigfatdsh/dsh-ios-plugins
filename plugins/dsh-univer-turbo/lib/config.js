/**
 * 配置解析。
 *
 * 这个插件的第一原则是 **永不因为配置而弄坏宿主**：任何非法输入都退化成默认值，
 * 并留一条 warn，而不是抛错让 profile 里多出一行 failed 的插件。
 *
 * 第二原则是 **默认值即为最优**：用户直接 `- name: dsh-univer-turbo` 什么都不配，
 * 也应该拿到本插件全部收益。
 *
 * @module dsh-univer-turbo/config
 */

/** 默认配置。每一项都对应一个明确的省 token / 省时间机制。 */
export const DEFAULTS = Object.freeze({
  /** 收窄工具面：隐藏 14 个 `univer_*` 工具，只留一个紧凑门面。 */
  collapseTools: true,
  /** 门面工具名。 */
  facadeName: 'univer',
  /** 结果压缩总开关。 */
  compactResults: true,
  /** 单个纯文本结果的内联预算（字符）。 */
  maxInlineChars: 1400,
  /** JSON 结果里数组最多保留多少项。 */
  maxArrayItems: 40,
  /** JSON 结果里单个字符串最多保留多少字符。 */
  maxStringChars: 240,
  /** JSON 结果里是否删除空值（`[]` / `{}` / `null` / `""`）。 */
  pruneEmpty: true,
  /** JSON 结果最大深度，超出以 `"…"` 占位。 */
  maxDepth: 8,
  /**
   * 回声抑制：删掉结果里「只是把调用参数念一遍」的字段（file/unitId/worktreeId/output/source）。
   * 信息不在结果里，而在紧邻的调用参数里，所以删掉不丢信息。
   */
  stripEcho: true,
  /**
   * 按 op 覆盖内联预算。实测依据：`svg` 被调用 108 次、结果均值仅 615 字符却全部带路径与
   * viewport 回声；`lint` 均值 1,172；`screenshot` 的文字块均值 808。
   * 收紧高频 op 的预算，比把全局预算调小更精确——不会误伤 `inspect` 这种真会很大的结果。
   */
  opBudgets: Object.freeze({ svg: 480, lint: 900, screenshot: 800 }),
  /** 完全相同的失败调用不再重跑（超时/中断类除外），直接回上一次的报错。 */
  memoizeFailures: true,
  /** 只读操作记忆化（同一 agent 会话内相同调用直接返回指针）。 */
  memoizeReads: true,
  /** 记忆化命中时，载荷小于该字符数就原样重发，否则只回指针。 */
  memoPayloadChars: 600,
  /** 每个 agent 会话最多向模型投递多少张截图；超出后只留文字。0 = 不限制。 */
  screenshotBudget: 8,
  /** 完全相同的图片只投递一次。 */
  dedupeImages: true,
  /**
   * 截图默认缩放（0 = 不干预，保持宿主默认的 1）。
   *
   * 图片 token 随像素数增长，而像素数随 scale² 增长：0.75 约等于图片成本减半。
   * 之所以默认 **不** 打开：`univer_screenshot` 常被用来核对细小文字，
   * 保真度不够会让模型重截，反而更贵。需要极致省量时再显式打开。
   */
  defaultScreenshotScale: 0,
  /** `batch` 中连续只读操作的并发上限。1 = 严格串行。 */
  readConcurrency: 2,
  /**
   * 超限截图被切成多片时的并发上限。
   *
   * 每次渲染都是一次独立的浏览器启动（实测单次约 6 秒），所以这一项直接乘在等待时间上：
   * 串行 3 片 ≈ 18 秒，并发 2 片 ≈ 12 秒，并发 3 片 ≈ 6 秒。默认 2 是稳妥值
   * （同时启动多个 Chromium 会抢 CPU/内存，收益会递减）。
   */
  chunkConcurrency: 2,
  /**
   * 在系统提示里加一段「整文件写入很贵」的静态提示。
   *
   * 这是**行为引导**，不是机制：DSH 的架构不允许插件回收已落库的工具调用参数
   * （见 lib/advice.js 的详细论证）。代价约 65 token/请求，赔率约 1:110。
   */
  writeCostHint: true,
  /**
   * 在系统提示里加一段「课件版式红线」。
   *
   * 与 writeCostHint 同一性质：行为引导，不回收成本。三条规则来自两次真实翻车
   * （文字堆叠、数字与单位离得太远），见 docs/PPT_STANDARD.md。
   */
  pptLayoutHint: true,
  /** 调试日志。 */
  debug: false,
  /** 装配自诊断：把每一步事实写进 `$DSH_HOME/univer-turbo-diag.jsonl`。排障用。 */
  diag: false,
});

/** 允许出现在配置里的键，其余键会被忽略并 warn。 */
const KNOWN = new Set(Object.keys(DEFAULTS));

/** 读取某个键的期望类型。 */
function kindOf(key) {
  return typeof DEFAULTS[key];
}

/**
 * 把任意输入规范化成一份可信配置。
 *
 * @param raw - `cordis.patch.yml` 里 `config:` 下的原始值（可能是任何东西）。
 * @param warn - 可选告警回调；绝不抛错。
 * @returns 完整配置对象（冻结）。
 */
export function normalizeConfig(raw, warn) {
  const out = { ...DEFAULTS };
  if (raw === undefined || raw === null) return Object.freeze(out);
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warn?.(`config must be a mapping, got ${Array.isArray(raw) ? 'array' : typeof raw}; using defaults`);
    return Object.freeze(out);
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN.has(key)) {
      warn?.(`unknown config key "${key}" ignored`);
      continue;
    }
    const want = kindOf(key);
    if (value === undefined) continue;
    if (want === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        warn?.(`config "${key}" must be a finite number, got ${JSON.stringify(value)}; using default ${DEFAULTS[key]}`);
        continue;
      }
      out[key] = value;
      continue;
    }
    if (want === 'object' && key === 'opBudgets') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        warn?.(`config "opBudgets" must be a mapping of op -> characters; using default`);
        continue;
      }
      const budgets = {};
      for (const [op, size] of Object.entries(value)) {
        if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
          warn?.(`config opBudgets.${op} must be a non-negative number; ignored`);
          continue;
        }
        budgets[op] = clamp(Math.floor(size), 0, 200_000);
      }
      out.opBudgets = Object.freeze({ ...DEFAULTS.opBudgets, ...budgets });
      continue;
    }
    if (typeof value !== want) {
      warn?.(`config "${key}" must be a ${want}, got ${typeof value}; using default ${JSON.stringify(DEFAULTS[key])}`);
      continue;
    }
    out[key] = value;
  }
  // 逐项夹紧到可用区间：这些数值直接决定结果大小，越界必须收敛。
  out.maxInlineChars = clamp(out.maxInlineChars, 200, 200_000);
  out.maxArrayItems = clamp(Math.floor(out.maxArrayItems), 1, 5_000);
  out.maxStringChars = clamp(Math.floor(out.maxStringChars), 32, 100_000);
  out.maxDepth = clamp(Math.floor(out.maxDepth), 1, 40);
  out.memoPayloadChars = clamp(Math.floor(out.memoPayloadChars), 0, 200_000);
  out.screenshotBudget = clamp(Math.floor(out.screenshotBudget), 0, 1_000);
  out.readConcurrency = clamp(Math.floor(out.readConcurrency), 1, 16);
  out.defaultScreenshotScale = clamp(out.defaultScreenshotScale, 0, 4);
  out.chunkConcurrency = clamp(Math.floor(out.chunkConcurrency), 1, 8);
  out.facadeName = sanitizeName(out.facadeName);
  return Object.freeze(out);
}

/** 数值夹紧。 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 工具名必须是非空、无空格的标识符；非法时退回 `univer`。
 * 这是最后一道保险——工具名会进入模型提示词。
 */
function sanitizeName(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,40}$/.test(value) ? value : DEFAULTS.facadeName;
}
