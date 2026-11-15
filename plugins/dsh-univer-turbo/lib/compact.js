/**
 * 结果压缩：把「工具结果」改小，但**不许弄坏信息**。
 *
 * 与通用截断器的区别只有一句话：**先按 JSON 语义压，再按文本预算截。**
 *
 * Univer 的结果几乎全是结构化 JSON（inspect / status / lint / execute 的返回值），
 * 而且特征非常固定：大量 `null` / `[]` / `{}` 占位、重复的 `additionalProperties`
 * 式冗余字段、以及少量真正要看的数字。对这类文本做「掐头去尾」会立刻产生两个恶果：
 * 1. JSON 不再是合法 JSON，模型无法局部引用，只能重跑（省下的又花回去）；
 * 2. 被截掉的往往是尾部的结论字段（`ok` / `error` / `total`）。
 *
 * 所以本模块的顺序是：
 * 1. 能解析成 JSON 的 → **语义剪枝**（删空值、限数组、限长字符串、限深度）；
 *    剪枝是**逐级加严的阶梯**，先试最宽松的档位，不够再收紧，直到落进预算或到底；
 * 2. 剪完还超预算，或本来就不是 JSON → 才退回「头 + 尾 + 全部可疑行」的文本预算；
 * 3. 任何一步只要没让结果变小，就原样返回（净收益闸门）。
 *
 * 所有函数都是纯函数：同样的输入必然得到逐字节相同的输出。
 * 这不只是为了好测——请求前缀复用要求结果**逐字节稳定**，否则每次重放都会作废前缀。
 *
 * @module dsh-univer-turbo/compact
 */

/**
 * 回声抑制：把「结果里只是把请求参数原样念一遍」的字段删掉。
 *
 * 实测里 univer 的每次结果都长这样：
 *   {"ok":true,"operation":"compile_svg","file":"/abs/path/a.univer","result":{...}}
 * 其中 `operation` 由 op 唯一决定，`file`/`unitId`/`worktreeId`/`output` 就是**上一行
 * 工具调用里的参数本身**。模型刚刚才写过这些值，再把它们念回来是纯冗余——
 * 108 次 `compile_svg` + 全部有文件的 op，每次都在重复同一段路径。
 *
 * 这是少数几种「删掉却不丢信息」的压缩：信息不在结果里，而在紧邻的调用参数里。
 * 因此它有前置条件——只有当调用与结果**成对出现在同一段上下文**时才成立；
 * 关掉 `stripEcho` 即可回到完全保守的行为。
 *
 * @param text - 结果文本。
 * @param args - 该次调用的入参（已剔除门面自有键）。
 * @returns `{ text, changed, dropped }`。
 */
export function stripEchoText(text, args) {
  const unchanged = { text, changed: false, dropped: [] };
  if (typeof text !== 'string' || text.length < 2) return unchanged;
  const trimmed = text.trim();
  if (trimmed[0] !== '{') return unchanged;
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return unchanged;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return unchanged;
  const dropped = [];
  const out = { ...value };
  // `operation` 与 `ok` 的语义由 op 唯一决定；`operation` 直接删，`ok` 保留（它承载成败）。
  if (typeof out.operation === 'string') {
    delete out.operation;
    dropped.push('operation');
  }
  for (const key of ECHO_KEYS) {
    const echoed = out[key];
    if (typeof echoed !== 'string' || echoed.length === 0) continue;
    const given = args?.[key];
    if (typeof given !== 'string' || given.length === 0) continue;
    // 结果里常是绝对路径、参数里是相对路径：只比较尾部即可认定「同一个目标」。
    if (echoed === given || echoed.endsWith(given) || given.endsWith(echoed)) {
      delete out[key];
      dropped.push(key);
    }
  }
  if (dropped.length === 0) return unchanged;
  const serialized = JSON.stringify(out);
  if (serialized.length >= text.length) return unchanged;
  return { text: serialized, changed: true, dropped };
}

/** 会「回声」的字段：它们在结果里出现只是在重复调用参数。 */
// 只收最确定的五个：路径与显式 ID。像 range/pages 这类可能在结果里被**规范化**
// （requestedRange -> resolvedRange），那是新信息，不能删。
const ECHO_KEYS = Object.freeze(['file', 'unitId', 'worktreeId', 'output', 'source']);

/** 估算 token：与 DSH 官方口径一致（UTF-16 码元数 / 4，向上取整）。 */
export function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

/** 文本省略标记（可 grep，便于从会话日志里直接统计节省量）。 */
export const ELISION = '[…]';

/** 这些键即使是空值也不许删——它们是模型判断「成功了没有」的唯一依据。 */
const KEEP_KEYS = new Set([
  'ok', 'success', 'error', 'errors', 'issue', 'issues', 'warning', 'warnings',
  'message', 'code', 'hint', 'note', 'notes', 'file', 'unitId', 'worktreeId',
  'id', 'name', 'kind', 'type', 'status', 'action', 'op', 'operation',
  'total', 'count', 'length', 'size', 'truncated',
]);

/** 路径上出现过这些词，就整棵子树免剪——报错信息是模型自我纠错的唯一依据。 */
const ERROR_PATH = /error|issue|warning|fail|stack|reason|violation/i;

/** 「值得保住」的行：报错、失败、警告、退出码、以及 DSH 自己的取回路径。 */
const IMPORTANT_LINE = [
  /\b(?:error|failed|failure|fatal|panic|exception|invalid|unknown|unsupported|missing|refused|denied)\b/i,
  /\b(?:warn|warning|deprecated|deprecation)\b/i,
  /\b(?:ENOENT|EACCES|EPERM|EEXIST|EISDIR|ENOTDIR|ETIMEDOUT|ECONNREFUSED)\b/,
  /^\s*at\s+\S+\s*\(/,
  /^\s*(?:FAIL|FAILED|✗|✘|not ok)\b/,
  /^\s*(?:Error|TypeError|RangeError|SyntaxError|ReferenceError)\b/,
  /\[exit code:\s*-?\d+\]/,
  /[A-Z][A-Z0-9_]{3,}(?:_[A-Z0-9]+)+/, // SCREAMING_SNAKE 错误码（Univer 大量使用）
  /^Full (?:sorted |grep |formatted )?result stored at:/,
  /\[output truncated; full output: /,
];

/** 空值判定：只有「确定没有信息」的才算空。`false` / `0` 一律保留。 */
function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * 剪枝阶梯。每一档都是「更狠一点」的完整参数集，按顺序尝试，命中即止。
 * 之所以是阶梯而不是公式，是因为真实结果的大小分布非常双峰：要么很小，
 * 要么里面有一两个巨型数组；固定阈值总会在某一侧浪费。
 */
const LADDER = Object.freeze([
  Object.freeze({ arrayItems: 40, stringChars: 240, depth: 8 }),
  Object.freeze({ arrayItems: 24, stringChars: 180, depth: 7 }),
  Object.freeze({ arrayItems: 12, stringChars: 120, depth: 6 }),
  Object.freeze({ arrayItems: 6, stringChars: 80, depth: 5 }),
  Object.freeze({ arrayItems: 3, stringChars: 56, depth: 4 }),
  Object.freeze({ arrayItems: 1, stringChars: 40, depth: 3 }),
]);

/**
 * 语义剪枝：递归地压掉「占位符」，保留全部有信息的标量。
 *
 * @param value - 任意 JSON 值。
 * @param level - 阶梯档位 `{arrayItems, stringChars, depth}`。
 * @param path - 当前路径上的键名（用于识别报错子树）。
 * @param depth - 当前深度。
 * @param stats - 可选计数对象，用于回报「压掉了什么」。
 * @returns 剪枝后的值（新对象，绝不改动入参）。
 */
export function prune(value, level, path = '', depth = 0, stats) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > level.stringChars) {
      const keep = level.stringChars;
      const head = Math.max(1, Math.floor(keep * 0.7));
      const tail = Math.max(0, keep - head);
      const dropped = value.length - head - tail;
      if (dropped > 0) {
        if (stats) stats.strings += 1;
        return `${value.slice(0, head)}…(+${dropped} chars)${tail > 0 ? value.slice(value.length - tail) : ''}`;
      }
    }
    return value;
  }
  // 报错子树整棵免剪：宁可多花 token，也不能让模型看不到失败原因。
  if (ERROR_PATH.test(path)) return value;
  if (depth >= level.depth) {
    if (stats) stats.depth += 1;
    return '…';
  }
  if (Array.isArray(value)) {
    const out = [];
    const limit = Math.min(value.length, level.arrayItems);
    for (let index = 0; index < limit; index += 1) out.push(prune(value[index], level, path, depth + 1, stats));
    if (value.length > limit) {
      if (stats) stats.items += value.length - limit;
      out.push(`…(+${value.length - limit} more)`);
    }
    return out;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (level.keepEmpty !== true && isEmptyValue(item) && !KEEP_KEYS.has(key) && !ERROR_PATH.test(childPath)) {
      if (stats) stats.empties += 1;
      continue;
    }
    out[key] = prune(item, level, childPath, depth + 1, stats);
  }
  return out;
}

/**
 * 尝试把文本当作 JSON 处理。
 *
 * @param text - 原始文本。
 * @param budget - 目标预算（字符）。
 * @returns `{ text, steps, stats }` 或 `null`（不是 JSON / 剪了也没变小）。
 */
export function compactJsonText(text, budget, base) {
  const trimmed = text.trim();
  if (trimmed.length < 2) return null;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return null;
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;

  // 第一档用配置给的阈值（用户的意图），之后才逐级加严（预算的约束）。
  const ladder = base === undefined
    ? LADDER
    : [Object.freeze({ arrayItems: base.arrayItems, stringChars: base.stringChars, depth: base.depth ?? 8, keepEmpty: base.keepEmpty === true }), ...LADDER];

  let best = null;
  for (const level of ladder) {
    const stats = { empties: 0, items: 0, strings: 0, depth: 0 };
    const pruned = prune(value, level, '', 0, stats);
    const serialized = JSON.stringify(pruned);
    if (serialized === undefined) continue;
    best = { text: serialized, stats, level: level.arrayItems };
    if (serialized.length <= budget) break;
  }
  if (best === null) return null;
  if (best.text.length >= text.length) return null;
  const steps = ['json-prune'];
  if (best.stats.empties > 0) steps.push(`empty-${best.stats.empties}`);
  if (best.stats.items > 0) steps.push(`items-${best.stats.items}`);
  if (best.stats.strings > 0) steps.push(`strings-${best.stats.strings}`);
  return { text: best.text, steps, stats: best.stats };
}

/**
 * 把长文本按「头 + 尾 + 全部可疑行」压进预算，并给出**诚实的**省略说明。
 *
 * 说明行必须同时说清三件事：丢了多大、里面有多少条报错行、怎么拿回来。
 * 三者缺一，模型就会重跑一次工具——省下的 token 连本带利还回去。
 *
 * @param text - 原始文本。
 * @param budget - 目标预算（字符）。
 * @param options - `{ hint, headRatio, tailRatio }`。
 * @returns `{ text, steps, dropped, droppedLines, importantDropped }` 或 `null`。
 */
export function retainText(text, budget, options = {}) {
  if (text.length <= budget) return null;
  const hint = options.hint ?? 're-run with a narrower range or a smaller unit to see the rest';
  const headRatio = options.headRatio ?? 0.55;
  const tailRatio = options.tailRatio ?? 0.35;
  const noticeReserve = 180;
  const usable = Math.max(0, budget - noticeReserve);
  const headBudget = Math.floor(usable * headRatio);
  const tailBudget = Math.floor(usable * tailRatio);

  const lines = text.split('\n');
  const important = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (IMPORTANT_LINE.some((pattern) => pattern.test(lines[index]))) important.push(index);
  }

  // 头部：整行累加，绝不断行。
  const headLines = [];
  let headChars = 0;
  let headEnd = 0;
  for (; headEnd < lines.length; headEnd += 1) {
    const cost = lines[headEnd].length + 1;
    if (headChars + cost > headBudget) break;
    headLines.push(lines[headEnd]);
    headChars += cost;
  }
  // 尾部：同样整行，从后往前。
  const tailLines = [];
  let tailChars = 0;
  let tailStart = lines.length;
  for (; tailStart > headEnd; tailStart -= 1) {
    const cost = lines[tailStart - 1].length + 1;
    if (tailChars + cost > tailBudget) break;
    tailLines.unshift(lines[tailStart - 1]);
    tailChars += cost;
  }

  // 中段里被丢掉的可疑行：数清楚，并且把最后几条（最靠近结论）捞回来。
  const kept = new Set();
  for (let index = 0; index < headEnd; index += 1) kept.add(index);
  for (let index = tailStart; index < lines.length; index += 1) kept.add(index);
  const rescue = [];
  let rescueChars = 0;
  const rescueBudget = Math.max(200, Math.floor(usable * 0.25));
  for (let index = important.length - 1; index >= 0; index -= 1) {
    const line = important[index];
    if (kept.has(line)) continue;
    const cost = lines[line].length + 1;
    if (rescueChars + cost > rescueBudget) break;
    rescue.unshift(line);
    rescueChars += cost;
  }
  for (const line of rescue) kept.add(line);

  const omittedIndexes = [];
  for (let index = 0; index < lines.length; index += 1) if (!kept.has(index)) omittedIndexes.push(index);
  if (omittedIndexes.length === 0) return null;
  let omittedChars = 0;
  for (const index of omittedIndexes) omittedChars += lines[index].length + 1;
  const importantDropped = omittedIndexes.filter((index) => important.includes(index)).length;

  const parts = [`${ELISION} omitted ${omittedChars} chars / ${omittedIndexes.length} lines of ${text.length}`];
  if (importantDropped > 0) parts.push(`${importantDropped} error/warning lines were in the omitted middle`);
  parts.push(hint);
  const notice = parts.join('; ');

  const middle = rescue.map((index) => lines[index]);
  const body = [...headLines, ...middle, notice, ...tailLines].join('\n');
  if (body.length >= text.length) return null;
  return {
    text: body,
    steps: ['retain'],
    dropped: omittedChars,
    droppedLines: omittedIndexes.length,
    importantDropped,
  };
}

/**
 * 压缩一段纯文本：先 JSON 语义剪枝，再文本预算。
 *
 * @param text - 原始文本。
 * @param options - `{ budget, maxArrayItems, maxStringChars, pruneEmpty, hint }`。
 * @returns `{ text, changed, steps, before, after }`。
 */
export function compactText(text, options) {
  const budget = Math.max(0, options.budget ?? 1400);
  const before = text.length;
  const unchanged = { text, changed: false, steps: [], before, after: before };
  if (typeof text !== 'string' || text.length <= budget) return unchanged;

  const json = compactJsonText(text, budget, {
    arrayItems: Math.max(1, options.maxArrayItems ?? 40),
    stringChars: Math.max(32, options.maxStringChars ?? 240),
    depth: Math.max(1, options.maxDepth ?? 8),
    keepEmpty: options.pruneEmpty === false,
  });
  if (json !== null && json.text.length <= budget) {
    return { text: json.text, changed: true, steps: json.steps, before, after: json.text.length };
  }
  // JSON 剪到底还是超预算（或者本来就不是 JSON）→ 退回文本预算。
  const base = json !== null ? json.text : text;
  const retained = retainText(base, budget, { hint: options.hint });
  if (retained === null) {
    if (json === null) return unchanged;
    return { text: json.text, changed: true, steps: json.steps, before, after: json.text.length };
  }
  const steps = json !== null ? [...json.steps, ...retained.steps] : retained.steps;
  if (retained.text.length >= before) return unchanged;
  return { text: retained.text, changed: true, steps, before, after: retained.text.length };
}

/**
 * 压缩一整条结果内容（parts 数组）。
 *
 * 只动 `text` part；`image` 等结构化 part 由调用方（图片策略）决定，本函数原样保留。
 * 多个 text part 时把预算按长度比例分配，避免一个大 part 吃掉全部额度。
 *
 * @param content - DSH 工具结果内容数组。
 * @param options - `{ budget, hint, maxArrayItems, maxStringChars }`。
 * @returns `{ content, changed, before, after, steps }`。
 */
export function compactContent(content, options) {
  const budget = Math.max(0, options.budget ?? 1400);
  let before = 0;
  let after = 0;
  let changed = false;
  const steps = [];
  const textParts = content.filter((part) => part !== null && typeof part === 'object' && part.type === 'text');
  const totalChars = textParts.reduce((sum, part) => sum + String(part.text ?? '').length, 0);
  const out = [];
  for (const part of content) {
    if (part === null || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string') {
      out.push(part);
      continue;
    }
    before += part.text.length;
    const share = totalChars === 0 ? budget : Math.max(200, Math.floor((budget * part.text.length) / totalChars));
    const result = compactText(part.text, { ...options, budget: share });
    after += result.text.length;
    if (result.changed) {
      changed = true;
      steps.push(...result.steps);
      out.push({ ...part, text: result.text });
    } else {
      out.push(part);
    }
  }
  return { content: out, changed, before, after, steps };
}
