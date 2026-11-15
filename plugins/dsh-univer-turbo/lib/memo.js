/**
 * 只读调用的记忆化。
 *
 * 这是本插件里「省 token」和「省时间」重叠得最完美的一处：
 *
 * - **省时间**：完全相同的一次 `status` / `inspect` / `lint` 不再打一次网关。
 * - **省 token**：命中时**不再重发载荷**，只回一行指针——因为上一次的完整结果
 *   仍然在对话历史里，模型抬头就能看到。这是唯一一种「省 token 却不丢信息」的压缩。
 *
 * 唯一必须做对的事是**失效**：任何会改动文档的操作都必须把整张表清空。
 * 宁可多失效一次（多花一次调用），也绝不能把过期结果当成新结果喂给模型——
 * 后者会让模型基于错的状态继续改，代价是整轮返工。
 *
 * @module dsh-univer-turbo/memo
 */

/**
 * 生成一个缓存键：对参数做**键序无关**的稳定序列化。
 *
 * 键序无关很重要：模型每次给的参数顺序都可能不同，若不归一化，同一个调用
 * 会被当成两个不同的键，记忆化就形同虚设。
 *
 * @param {string} op - 规范 op 名。
 * @param {object} args - 已剔除门面自有参数的入参。
 * @returns {string} 稳定键。
 */
export function memoKey(op, args) {
  return `${op}\u0000${stableStringify(args)}`;
}

/** 稳定序列化：对象按键名排序，数组保序，函数/undefined 直接丢弃。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    const item = value[key];
    if (item === undefined || typeof item === 'function') continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(item)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * 创建一张只读结果表。
 *
 * @param {object} [options] - `{ maxEntries }`。
 * @returns 记忆化实例。
 */
export function createMemo(options = {}) {
  const maxEntries = Math.max(1, options.maxEntries ?? 256);
  /** @type {Map<string, {text: string, at: number}>} */
  const table = new Map();
  let hits = 0;
  let misses = 0;
  let invalidations = 0;

  return {
    /**
     * 查表。
     * @param {string} key - 记忆化键。
     * @returns 命中项或 `undefined`。
     */
    get(key) {
      const hit = table.get(key);
      if (hit === undefined) {
        misses += 1;
        return undefined;
      }
      hits += 1;
      // 触碰即刷新 LRU 次序，避免热点条目被后来的大结果挤掉。
      table.delete(key);
      table.set(key, hit);
      return hit;
    },

    /**
     * 写入。
     * @param {string} key - 记忆化键。
     * @param {string} text - 已压缩过的结果文本。
     */
    set(key, text) {
      table.delete(key);
      table.set(key, { text, at: Date.now() });
      while (table.size > maxEntries) {
        const oldest = table.keys().next();
        if (oldest.done === true) break;
        table.delete(oldest.value);
      }
    },

    /**
     * 只删一个键。
     *
     * 用于「按目标失效」：同一页被重新编译后，该页**旧参数**的缓存也失效了
     * （页面内容已经变了），但其它页的缓存不受影响。
     *
     * @param {string} key - 记忆化键。
     * @returns 是否删掉了东西。
     */
    forget(key) {
      return table.delete(key);
    },

    /** 改动类操作之后必须调用：整表作废。 */
    invalidate() {
      if (table.size === 0) return 0;
      const size = table.size;
      table.clear();
      invalidations += 1;
      return size;
    },

    /** 只读统计（测试与诊断用，不产生任何 token）。 */
    stats() {
      return { size: table.size, hits, misses, invalidations };
    },
  };
}
