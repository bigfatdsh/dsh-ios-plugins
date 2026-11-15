/**
 * 门面：把 14 个 `univer_*` 工具收敛成**一个**工具。
 *
 * ## 为什么这是最大的一笔省量
 *
 * 模型看到的工具表是**每一个请求都要重发一次**的前缀。真实测量（`tools/measure.mjs`）
 * 显示这 14 个工具的 schema 合计 11,511 字符 ≈ 3,198 token；门面把它压到 ~1,500
 * 字符，且**能力一个不少**——因为门面并不重新实现任何东西，它只是把调用转发给
 * 那些仍然注册着、只是对模型隐藏了的原始工具。
 *
 * ## 转发为什么是安全的
 *
 * `ctx.tools.get(name)`（**省略 scope = 全局视角**）在本 agent 被 restrict 之后
 * 依然能解析到原始定义，`definition.execute(args, exec)` 也依然可用。
 * 这意味着门面拿到的是**同一个**经过作者校验的执行体，而不是一份复制品：
 * 参数校验、错误类型、超时语义全部保持原样。
 *
 * ## 门面自己额外做的四件事
 *
 * 1. **本地校验**：必填参数缺失时立刻回答，省掉一次昂贵的远端往返；
 * 2. **记忆化**：完全相同的只读调用只回一行指针（上一次的载荷还在上文）；
 * 3. **批处理**：`op:"batch"` 把 N 次往返压成 1 次，连续的只读步骤还能并发；
 * 4. **压缩**：每个 op 的结果在**进入对话之前**就被压到预算内。
 *
 * @module dsh-univer-turbo/facade
 */

import { compactContent, estimateTokens, stripEchoText, ELISION } from './compact.js';
import { createMemo, memoKey } from './memo.js';
import { ALIASES, ARG_VOCABULARY, BATCH, facadeDescription, facadeParameters, OPS } from './ops.js';

/** 门面自有参数：转发给底层工具之前必须摘掉。 */
const FACADE_ONLY = new Set(['op', 'ops', 'force', 'stopOnError']);

/** 单次 batch 允许的最大步骤数（防止一次调用变成无限循环）。 */
const MAX_BATCH_STEPS = 32;

/**
 * 把 `op` 归一化成规范名。
 *
 * @param op - 模型给的原始值。
 * @returns 规范 op 名，或 `undefined`。
 */
export function normalizeOp(op) {
  if (typeof op !== 'string') return undefined;
  const key = op.trim().toLowerCase().replace(/^univer[_:]/, '').replace(/[\s-]+/g, '_');
  if (key === BATCH) return BATCH;
  if (Object.hasOwn(OPS, key)) return key;
  if (Object.hasOwn(ALIASES, key)) return ALIASES[key];
  return undefined;
}

/** 摘掉门面自有参数，并丢掉 `undefined`，让转发出去的对象与模型给的语义一致。 */
function forwardArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (FACADE_ONLY.has(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** 人类可读的参数列表，用于报错。 */
function describeArgs(op) {
  return op === BATCH ? 'ops' : [ ...(OPS[op]?.required ?? []) ].join(', ');
}

/**
 * 生成门面工具定义。
 *
 * @param {object} deps - 依赖。
 * @param {object} deps.config - 已规范化的配置。
 * @param {(name: string) => object|undefined} deps.resolveTool - 全局视角解析工具定义。
 * @param {object} deps.memo - `createMemo()` 的返回值。
 * @param {(event: string, detail?: any) => void} deps.log - 日志（可空实现）。
 * @returns {{definition: object, stats: object}} 工具定义与只读统计。
 */
export function createFacade(deps) {
  const { config, resolveTool, memo, log } = deps;
  const stats = {
    calls: 0,
    ops: 0,
    batchSteps: 0,
    cached: 0,
    cachedFailures: 0,
    cachedCompiles: 0,
    echoed: 0,
    suppressedScreenshots: 0,
    chunkedScreenshots: 0,
    charsBefore: 0,
    charsAfter: 0,
    errors: 0,
    localErrors: 0,
  };
  /** 已投递过的截图张数（每个 agent 会话一份）。 */
  let imagesDelivered = 0;
  /**
   * 「正在执行」的只读调用。没有它，`batch` 里两个完全相同的只读步骤会**并发启动**，
   * 于是都错过缓存、都打一次网关——这正是实测里漏掉的那种重复。
   */
  const flights = new Map();
  /**
   * 按**页**记忆化的 svg 编译结果。
   *
   * 为什么单独开一张表：`compile_svg` 是写操作，用全局失效会自我作废——
   * 「编译第 7 页 → 编译第 3 页 → 再编译第 7 页」永远命中不了，而实测里
   * 57 次编译只有 40 组不同参数（8c5eb015 是 51 次 / 22 组）：重复编译 17~29 次，
   * 每次 3.09 秒，还各占一个往返。
   *
   * 失效规则（保守优先）：
   * - 任何 **`execute` 或结构性写**（worktree/unit/import/new）→ 整张表作废，
   *   因为 `execute` 里是任意 Facade 代码，可能改到任何一页；
   * - 某页被重新编译 → 只作废**该页**的旧参数条目（页面内容已变），
   *   其它页的缓存仍然有效（编译一页不会改动另一页）。
   */
  const svgMemo = createMemo();
  /** 目标 → 该目标下已缓存的全部键，用于精确清除。 */
  const svgKeysByTarget = new Map();
  /** 已截过的目标键：在文档没变的前提下，同一目标不重复投递图片。 */
  let capturedTargets = new Set();

  const memoOn = config.memoizeReads;
  /**
   * 该 op 的内联预算。
   *
   * 按 op 收紧比把全局预算调小更精确：实测 `compile_svg` 被调用 108 次、结果均值只有
   * 615 字符，却每次都带回路径与 viewport 回声；而 `inspect` 真的可能很大，不该被误伤。
   */
  const budgetFor = (op) => {
    const override = config.opBudgets?.[op];
    return typeof override === 'number' && override > 0 ? override : config.maxInlineChars;
  };

  /**
   * 记忆化命中时的返回。
   *
   * 载荷够小就直接重发（模型不必回头翻），够大就只回一行指针——因为上一次的完整结果
   * 仍然在对话历史里，模型抬头就能看到。这是唯一一种「省 token 却不丢信息」的压缩。
   *
   * @param {string} op - 规范 op 名。
   * @param {string} payloadText - 上次压缩后的结果文本。
   * @returns {{parts: object[], ok: boolean, tokens: number, header: string}} 结果。
   */
  function cachedResult(op, payloadText) {
    // 报错必须**全文重发**：它是模型唯一能据以纠错的东西，不能让它去上文里翻。
    const failed = isErrorText(payloadText);
    const text = failed || payloadText.length <= config.memoPayloadChars
      ? `${ELISION} same call as before, unchanged; same result:\n${payloadText}`
      : `${ELISION} unchanged since your previous ${op} with these exact arguments — the full result is already above; not repeated.`;
    return {
      parts: [{ type: 'text', text }],
      ok: !failed,
      tokens: estimateTokens(text),
      header: failed ? `${op} (cached failure)` : `${op} (cached)`,
    };
  }

  /**
   * 执行单个 op 并返回内容块。
   *
   * @param {string} op - 规范 op 名。
   * @param {object} args - 原始入参（含门面自有键）。
   * @param {object} exec - 工具执行上下文（原样透传给底层工具）。
   * @param {object} [outer] - 外层标记 `{ force, quiet }`。
   * @returns {Promise<{parts: object[], ok: boolean, tokens: number, header: string}>} 结果。
   */
  async function runOp(op, args, exec, outer = {}) {
    const spec = OPS[op];
    if (spec === undefined) {
      stats.localErrors += 1;
      return textOnly(`ERROR unknown op "${String(args.op)}"; available: ${Object.keys(OPS).join(', ')}, ${BATCH}`, false, op);
    }
    const payload = forwardArgs(args);
    const missing = (spec.required ?? []).filter((key) => payload[key] === undefined || payload[key] === null);
    if (missing.length > 0) {
      stats.localErrors += 1;
      return textOnly(
        `ERROR ${op} requires: ${missing.join(', ')} (this op needs ${describeArgs(op)}; no remote call was made)`,
        false,
        op,
      );
    }
    const definition = resolveTool(spec.tool);
    if (definition === undefined || typeof definition.execute !== 'function') {
      stats.localErrors += 1;
      return textOnly(`ERROR ${spec.tool} is not registered in this session; available ops: ${Object.keys(OPS).join(', ')}`, false, op);
    }

    const isScreenshot = op === 'screenshot';
    const force = args.force === true || outer.force === true;
    const targetKey = isScreenshot ? memoKey('screenshot', payload) : undefined;
    // 同一目标、文档未变 → 图片已经在上文里了，再投一遍纯属浪费。
    if (isScreenshot && config.dedupeImages && !force && capturedTargets.has(targetKey)) {
      stats.suppressedScreenshots += 1;
      return textOnly(
        `screenshot of the same target is already in this conversation and nothing changed since; ${ELISION} no new images. Pass force:true to capture again.`,
        true,
        op,
      );
    }

    // 写操作也计算 key：**失败**的写调用同样值得记住（见下面的 memoizeFailures）。
    const key = memoKey(op, payload);
    if (op === 'svg' && memoOn) {
      const hit = svgMemo.get(key);
      if (hit !== undefined) {
        stats.cached += 1;
        stats.cachedCompiles += 1;
        return cachedResult(op, hit.text);
      }
    }
    if (memoOn && op !== 'svg') {
      const hit = memo.get(key);
      // 读操作的成果可以复用；写操作的**报错**可以复用（成功与否取决于文档状态，
      // 而任何一次成功的写都会让整张表失效）。写操作的成功结果绝不复用。
      if (hit !== undefined && (spec.read || isErrorText(hit.text))) {
        stats.cached += 1;
        if (isErrorText(hit.text)) stats.cachedFailures += 1;
        return cachedResult(op, hit.text);
      }
      const flight = spec.read ? flights.get(key) : undefined;
      if (flight !== undefined) {
        await flight.catch(() => {});
        const settled = memo.get(key);
        if (settled !== undefined) {
          stats.cached += 1;
          return cachedResult(op, settled.text);
        }
      }
    }

    stats.ops += 1;
    // 可选的默认缩放：截图是最贵的单项结果，像素数直接决定图片 token。
    // 默认 0 = 不干预；用户显式设置后才生效，绝不偷偷改动视觉保真度。
    if (isScreenshot && payload.scale === undefined && config.defaultScreenshotScale > 0) {
      payload.scale = config.defaultScreenshotScale;
    }
    let parts;
    let settle;
    if (key !== undefined && memoOn && spec.read) {
      flights.set(key, new Promise((resolve) => { settle = resolve; }));
    }
    try {
      parts = await invoke(spec, definition, payload, exec, isScreenshot);
    } catch (error) {
      stats.errors += 1;
      const text = formatError(op, error);
      // 完全相同的失败调用不值得重跑：实测里 `Image batch exceeds … image-count limit`
      // 连撞 3 次，每次烧掉 8 秒**和**一个完整往返（≈93,000 token 的上下文重发）。
      // 超时/中断这类可能是瞬时的，不记；文档一变，整张表就失效。
      if (memoOn && config.memoizeFailures && isStableFailure(error)) memo.set(key, text);
      settle?.();
      flights.delete(key);
      return { parts: [{ type: 'text', text }], ok: false, tokens: estimateTokens(text), header: `${op} failed` };
    }

    if (spec.mutates === true) {
      memo.invalidate();
      capturedTargets = new Set();
      // `svg` 只作废自己那一页；其它任何写（尤其 `execute`）都无法预知影响到哪一页，
      // 所以整张编译缓存作废——宁可多编译一次，也不能让模型拿到过期结果。
      if (op !== 'svg') {
        svgMemo.invalidate();
        svgKeysByTarget.clear();
      }
    }

    if (config.stripEcho) parts = stripEcho(parts, payload, stats);
    const budget = budgetFor(op);
    const compacted = compactContent(parts, {
      budget,
      hint: hintFor(op),
      maxArrayItems: config.maxArrayItems,
      maxStringChars: config.maxStringChars,
      maxDepth: config.maxDepth,
      pruneEmpty: config.pruneEmpty,
    });
    let finalParts = compacted.content;
    let note = '';
    if (isScreenshot) {
      const result = applyScreenshotPolicy(finalParts, { force, targetKey });
      finalParts = result.parts;
      note = result.note;
    }
    const text = textOf(finalParts) + note;
    const tokens = estimateTokens(text);
    stats.charsBefore += compacted.before;
    stats.charsAfter += compacted.after;
    if (op === 'svg' && memoOn) rememberCompile(payload, key, textOf(finalParts));
    else if (spec.read && memoOn && compacted.after <= budget * 4) memo.set(key, textOf(finalParts));
    if (isScreenshot && !force) capturedTargets.add(targetKey);
    // 必须在**写入缓存之后**才放行等待者，否则它会醒来发现缓存仍是空的，又打一次网关。
    settle?.();
    flights.delete(key);
    return { parts: finalParts, ok: true, tokens, header: op };
  }

  /**
   * 真正调用底层工具。
   *
   * 这里唯一「聪明」的地方是截图分片：实测里最常见的失败之一是
   * `Image batch exceeds the configured image-count limit`——模型一次要 6~8 页，
   * 渲染了 6 秒之后才被拒。既然附件服务把上限明白地告诉了我们，就在**渲染之前**
   * 把 `pages` 切成合规的分片依次渲染，再合并结果：把一次「失败 + 重试 + 再失败」
   * 变成一次成功，省下的是 6~8 秒 × 2 和两个完整往返。
   *
   * @param spec - op 契约。
   * @param definition - 底层工具定义。
   * @param payload - 已摘掉门面自有参数的入参。
   * @param exec - 执行上下文。
   * @param isScreenshot - 是否为截图 op。
   * @returns {Promise<object[]>} 内容块数组。
   */
  async function invoke(spec, definition, payload, exec, isScreenshot) {
    const limit = isScreenshot ? imageLimit() : undefined;
    const pages = Array.isArray(payload.pages) ? payload.pages : undefined;
    if (limit === undefined || pages === undefined || pages.length <= limit || limit < 1) {
      const value = await definition.execute(payload, exec);
      return renderValue(definition, payload, value);
    }
    stats.chunkedScreenshots += 1;
    const slices = [];
    for (let at = 0; at < pages.length; at += limit) slices.push(pages.slice(at, at + limit));

    // 每个分片都要**独立启动一次渲染**（实测 univer 每次渲染都新起一个 Chromium，
    // 单次约 6 秒）。串行跑 3 片 = 18 秒；并发跑 3 片 ≈ 一次渲染的时间。
    const width = Math.max(1, Math.min(config.chunkConcurrency, slices.length));
    const results = new Array(slices.length);
    let cursor = 0;
    const workers = [];
    for (let worker = 0; worker < width; worker += 1) {
      workers.push((async () => {
        for (;;) {
          const at = cursor;
          cursor += 1;
          if (at >= slices.length) return;
          const slice = slices[at];
          const chunkArgs = { ...payload, pages: slice };
          const value = await definition.execute(chunkArgs, exec);
          results[at] = { slice, parts: renderValue(definition, chunkArgs, value) };
        }
      })());
    }
    await Promise.all(workers);

    // 合并时**按原顺序**：并发不允许改变输出字节（前缀缓存要求逐字节确定）。
    const merged = [];
    for (const entry of results) {
      if (entry === undefined) continue;
      for (const part of entry.parts) {
        // 每片都会回一段 JSON 头；只保留第一段，其余压成一行，避免元数据重复。
        if (part !== null && typeof part === 'object' && part.type === 'text' && merged.length > 0) {
          merged.push({ type: 'text', text: `${ELISION} (continuation: pages ${entry.slice.join(',')} rendered in the same call)` });
        } else {
          merged.push(part);
        }
      }
    }
    return merged;
  }

  /**
   * 记下一次成功编译，并作废同一页的旧参数条目。
   *
   * @param {object} payload - 该次调用的入参（含 unitId / page）。
   * @param {string} key - 记忆化键。
   * @param {string} text - 压缩后的结果文本。
   */
  function rememberCompile(payload, key, text) {
    const target = `${payload.unitId ?? '?'}#${payload.page ?? '?'}`;
    const previous = svgKeysByTarget.get(target);
    if (previous !== undefined) {
      for (const old of previous) if (old !== key) svgMemo.forget(old);
    }
    const keys = previous ?? new Set();
    keys.add(key);
    svgKeysByTarget.set(target, keys);
    svgMemo.set(key, text);
  }

  /** 读取附件服务的图片张数上限；拿不到就返回 `undefined`（跳过分片）。 */
  function imageLimit() {
    try {
      const limits = deps.imageLimit?.();
      const count = limits?.maxImagesPerMessage ?? limits?.count ?? limits?.maxCount ?? limits?.images;
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) return Math.floor(count);
    } catch {
      // 拿不到上限不是错误，只是少了一层保护。
    }
    return undefined;
  }

  /** 截图策略：预算 + 首次投递。返回可能被剥掉图片的 parts。 */
  function applyScreenshotPolicy(parts, { force, targetKey }) {
    const imageCount = parts.filter((part) => part !== null && typeof part === 'object' && part.type === 'image').length;
    if (imageCount === 0) return { parts, note: '' };
    const cap = config.screenshotBudget;
    const overBudget = cap > 0 && !force && imagesDelivered + imageCount > cap;
    if (!overBudget) {
      imagesDelivered += imageCount;
      return { parts, note: '' };
    }
    const kept = parts.filter((part) => part === null || typeof part !== 'object' || part.type !== 'image');
    kept.push({
      type: 'text',
      text:
        `${ELISION} ${imageCount} image(s) withheld: this session already used its ${cap} screenshot budget; ` +
        'the PNG files are on disk at the output path above. Use lint/inspect to verify, or pass force:true if you truly need to look.',
    });
    stats.suppressedScreenshots += 1;
    return { parts: kept, note: '' };
  }

  /** 批处理：连续的只读步骤并发，写步骤串行且作为屏障。 */
  async function runBatch(steps, exec, args) {
    if (!Array.isArray(steps) || steps.length === 0) {
      stats.localErrors += 1;
      return textOnly('ERROR batch requires a non-empty ops array: [{op:"status",file:"a.univer"}, ...]', false, BATCH);
    }
    const list = steps.slice(0, MAX_BATCH_STEPS);
    stats.batchSteps += list.length;
    const chunks = [];
    let index = 0;
    while (index < list.length) {
      const step = list[index];
      const op = normalizeOp(step?.op);
      const readOnly = op !== undefined && op !== BATCH && OPS[op].read === true;
      if (!readOnly) {
        chunks.push([{ step, op, at: index }]);
        index += 1;
        continue;
      }
      const group = [];
      while (index < list.length) {
        const nextOp = normalizeOp(list[index]?.op);
        if (nextOp === undefined || nextOp === BATCH || OPS[nextOp].read !== true) break;
        group.push({ step: list[index], op: nextOp, at: index });
        index += 1;
      }
      chunks.push(group);
    }

    const results = new Array(list.length);
    for (const chunk of chunks) {
      const limit = Math.max(1, config.readConcurrency);
      if (chunk.length === 1 || limit === 1) {
        for (const item of chunk) results[item.at] = await runOne(item);
        continue;
      }
      let cursor = 0;
      const workers = [];
      const width = Math.min(limit, chunk.length);
      for (let worker = 0; worker < width; worker += 1) {
        workers.push((async () => {
          for (;;) {
            const at = cursor;
            cursor += 1;
            if (at >= chunk.length) return;
            const item = chunk[at];
            results[item.at] = await runOne(item);
          }
        })());
      }
      await Promise.all(workers);
      if (args.stopOnError === true && results.some((item) => item !== undefined && item.ok === false)) break;
    }

    async function runOne(item) {
      if (item.op === undefined) {
        stats.localErrors += 1;
        const text = `ERROR step ${item.at + 1}: unknown op "${String(item.step?.op)}"`;
        return { parts: [{ type: 'text', text }], ok: false, tokens: estimateTokens(text), header: `step ${item.at + 1}` };
      }
      return runOp(item.op, item.step ?? {}, exec, { force: item.step?.force === true });
    }

    const parts = [];
    const lines = [];
    let ok = true;
    list.forEach((_, at) => {
      const result = results[at];
      if (result === undefined) return;
      if (result.ok === false) ok = false;
      lines.push(`▸ [${at + 1}] ${result.header}${result.ok ? '' : ' (failed)'}`);
      for (const part of result.parts) {
        if (part !== null && typeof part === 'object' && part.type === 'text') lines.push(part.text);
        else parts.push(part);
      }
    });
    const text = lines.join('\n');
    return { parts: [{ type: 'text', text }, ...parts], ok, tokens: estimateTokens(text), header: BATCH };
  }

  /**
   * 门面执行体。注册的是**原始定义对象**（不经 `defineTool`），因此这里完全自己掌控：
   * 参数校验、转发、压缩、错误格式化，一处都不依赖 DSH 内部实现。
   */
  async function execute(args, exec) {
    stats.calls += 1;
    const raw = args !== null && typeof args === 'object' ? args : {};
    const op = normalizeOp(raw.op);
    if (op === undefined) {
      stats.localErrors += 1;
      throw new Error(`missing or unknown "op". Use one of: ${Object.keys(OPS).join(', ')}, ${BATCH}`);
    }
    const result = op === BATCH
      ? await runBatch(raw.ops, exec, raw)
      : await runOp(op, raw, exec, {});
    if (config.debug) log('op', { op, ok: result.ok });
    // 单步失败用抛错表达：让宿主把这条结果标成 isError，模型侧的自我纠错信号才完整。
    // batch 不抛——部分失败是正常语义，逐条结果里已经写清是哪一步失败。
    if (result.ok === false && op !== BATCH) throw new Error(textOf(result.parts));
    return { ok: result.ok, parts: result.parts };
  }

  const definition = {
    name: config.facadeName,
    description: facadeDescription({ budget: config.screenshotBudget, memo: memoOn }),
    parameters: facadeParameters(),
    output: {
      // 值里带着已渲染好的 parts；render 只做透传，因此图片等结构化块不会经过文本手术。
      schema: { type: 'object', properties: { parts: { type: 'array' } }, required: ['parts'], additionalProperties: true },
      render: (_args, value) => (Array.isArray(value?.parts) ? value.parts : [{ type: 'text', text: String(value) }]),
    },
    async execute(args, exec) {
      const value = await execute(args, exec);
      return value;
    },
  };

  return { definition, stats };
}

/** 这条结果是不是「报错文本」。 */
function isErrorText(text) {
  return typeof text === 'string' && text.startsWith('ERROR ');
}

/**
 * 这个失败值不值得记下来。
 *
 * 只记**确定性**失败：文件不存在、参数非法、浏览器缺失、单元不存在……
 * 超时/中断/连接抖动可能是瞬时的，记下来会让模型失去重试的机会。
 */
function isStableFailure(error) {
  const text = `${error?.code ?? ''} ${error?.message ?? ''}`;
  return !/timeout|timed out|abort|ECONNREFUSED|ECONNRESET|EPIPE|busy|EAGAIN|rate.?limit|detached/i.test(text);
}

/**
 * 对文本 part 做回声抑制。
 *
 * 只动 text part；图片等结构化块原样保留。任何异常都退回原文——
 * 压缩器的 bug 绝不能变成工具结果的 bug。
 */
function stripEcho(parts, payload, stats) {
  return parts.map((part) => {
    if (part === null || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string') return part;
    try {
      const result = stripEchoText(part.text, payload);
      if (!result.changed) return part;
      stats.echoed += result.dropped.length;
      return { ...part, text: result.text };
    } catch {
      return part;
    }
  });
}
/** 只有文本的结果。 */
function textOnly(text, ok, op) {
  return { parts: [{ type: 'text', text }], ok, tokens: estimateTokens(text), header: op };
}

/** 把 parts 里的文本拼起来（非文本块丢弃，仅用于计量/记忆化）。 */
function textOf(parts) {
  let out = '';
  for (const part of parts) {
    if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      out += (out === '' ? '' : '\n') + part.text;
    }
  }
  return out;
}

/** 调用底层定义的 render；render 缺失或抛错时退化成 JSON 文本。 */
function renderValue(definition, args, value) {
  const render = definition.output?.render;
  if (typeof render === 'function') {
    try {
      const parts = render(args, value);
      if (Array.isArray(parts) && parts.length > 0) return parts;
    } catch {
      // 落回文本，绝不让渲染失败影响结果本身。
    }
  }
  return [{ type: 'text', text: typeof value === 'string' ? value : safeJson(value) }];
}

/** 安全的 JSON 序列化（循环引用 / BigInt 也不抛）。 */
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 把底层错误压成一行，并把「下一步该干什么」直接写进去。 */
function formatError(op, error) {
  const message = typeof error?.message === 'string' ? error.message : String(error);
  const code = typeof error?.code === 'string' ? ` ${error.code}` : '';
  const hints = [];
  if (/unitId|\bunit\b/i.test(message)) hints.push('call status{file} to get a valid unitId');
  if (/worktree/i.test(message)) hints.push('worktreeId must come from status or worktree{action:"create"}');
  if (/ENOENT|not found|no such file/i.test(message)) hints.push('check the file path (workspace-relative is safest)');
  if (/timeout|timed out/i.test(message)) hints.push('retry, or split the edit into smaller execute calls');
  const suffix = hints.length > 0 ? `\nnext: ${hints.join('; ')}` : '';
  return `ERROR ${op}${code}: ${message}${suffix}`;
}

/** 每个 op 的取回提示——省略说明行必须告诉模型怎么把丢掉的部分拿回来。 */
function hintFor(op) {
  switch (op) {
    case 'inspect': return 're-inspect a narrower range (e.g. range:"Sheet1!A1:D20") to see the rest';
    case 'status': return 're-run status with unitId to narrow the listing';
    case 'lint': return 're-run lint with pages to narrow the listing';
    case 'api': return 're-run api with fewer queries or a smaller limit';
    case 'resources': return 're-run resources with a narrower query';
    case 'execute': return 'return less data from your Facade code (read only what you need)';
    default: return 're-run with narrower arguments to see the rest';
  }
}

/** 供测试直接断言参数词表与门面一致。 */
export const __internals = { forwardArgs, MAX_BATCH_STEPS, ARG_VOCABULARY };
