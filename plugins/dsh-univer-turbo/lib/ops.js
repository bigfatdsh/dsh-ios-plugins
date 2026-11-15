/**
 * 操作表：门面 `op` 与 `dsh-univer-office` 真实工具之间唯一的映射真源。
 *
 * 这张表同时承担四件事：
 * 1. 门面把 `op` 派发到哪个底层工具；
 * 2. 该操作是「读」还是「写」——决定记忆化与缓存失效；
 * 3. 必填参数——用于在**本地**就把错误说清楚，省掉一次往返；
 * 4. 生成模型可见的门面描述（唯一会永久占用上下文的那段文字）。
 *
 * 表里只写「语义」，不写实现细节；任何一项缺失都退化成一次明确的本地报错，
 * 而不是一次昂贵的远端失败。
 *
 * @module dsh-univer-turbo/ops
 */

/**
 * @typedef {object} OpSpec
 * @property {string} tool - 底层工具名。
 * @property {boolean} read - 只读（可记忆化、可在 batch 内并发）。
 * @property {boolean} [mutates] - 是否使已缓存结果失效。
 * @property {string[]} required - 必填参数（用于本地校验）。
 * @property {string} hint - 一句话说明，仅在报错时出现。
 */

/** 门面支持的 op → 底层工具契约。 */
export const OPS = Object.freeze({
  status: { tool: 'univer_status', read: true, required: ['file'], hint: 'list trunk units and worktrees' },
  inspect: { tool: 'univer_inspect', read: true, required: ['file', 'unitId'], hint: 'read structured unit content' },
  lint: { tool: 'univer_lint', read: true, required: ['file', 'unitId'], hint: 'static layout/lint check' },
  execute: { tool: 'univer_execute', read: false, mutates: true, required: ['file', 'unitId'], hint: 'run Facade JS against a unit' },
  screenshot: { tool: 'univer_screenshot', read: true, required: ['file', 'unitId', 'output'], hint: 'render unit to PNG' },
  export: { tool: 'univer_export', read: true, required: ['file', 'unitId', 'output'], hint: 'export unit to a user-facing file' },
  pdf: { tool: 'univer_print_pdf', read: true, required: ['file', 'unitId', 'output'], hint: 'print unit to PDF' },
  new: { tool: 'univer_new', read: false, mutates: true, required: ['file'], hint: 'create an empty .univer file' },
  unit: { tool: 'univer_unit', read: false, mutates: true, required: ['action', 'file'], hint: 'create or remove a unit' },
  worktree: { tool: 'univer_worktree', read: false, mutates: true, required: ['action', 'file'], hint: 'worktree lifecycle' },
  import: { tool: 'univer_import', read: false, mutates: true, required: ['source', 'file', 'name'], hint: 'import xlsx/csv/docx/pptx as a unit' },
  svg: { tool: 'univer_compile_svg', read: false, mutates: true, required: ['source', 'file', 'unitId', 'page'], hint: 'compile SVG onto a slide page' },
  resources: { tool: 'univer_resources', read: true, required: ['action'], hint: 'bundled SVG resources' },
  api: { tool: 'univer_api', read: true, required: ['action', 'queries'], hint: 'Univer Facade API lookup' },
});

/** 别名 → 规范 op。让模型不必记住我们选的名字。 */
export const ALIASES = Object.freeze({
  print: 'pdf',
  print_pdf: 'pdf',
  printpdf: 'pdf',
  svg_page: 'svg',
  compile_svg: 'svg',
  compile: 'svg',
  run: 'execute',
  eval: 'execute',
  code: 'execute',
  load: 'import',
  save: 'export',
  info: 'status',
  state: 'status',
  list: 'status',
  read: 'inspect',
  show: 'inspect',
  check: 'lint',
  capture: 'screenshot',
  shot: 'screenshot',
  png: 'screenshot',
  remove: 'unit',
  create: 'unit',
  'new_unit': 'unit',
});

/** 批量 op 的名字。 */
export const BATCH = 'batch';

/** 全部门面 op 名（含 batch），用于生成描述。 */
export const OP_NAMES = Object.freeze([...Object.keys(OPS), BATCH]);

/**
 * 全部可能出现的门面参数名（底层 14 个工具参数名的并集，加门面自有参数）。
 * 只用于：① 生成 JSON Schema；② 生成描述里的参数速查行；
 * ③ 在转发前把「门面自有参数」摘掉，避免污染底层工具的入参校验。
 */
export const FACADE_ONLY_ARGS = Object.freeze(['op', 'ops', 'force', 'stopOnError']);

/** 参数速查行使用的顺序（按使用频率降序，最常用的参数先出现）。 */
export const ARG_VOCABULARY = Object.freeze([
  'file', 'unitId', 'worktreeId', 'output', 'source', 'code', 'codeFile', 'name',
  'kind', 'action', 'range', 'pages', 'scale', 'queries', 'limit', 'unit',
  'docType', 'mode', 'page', 'elementIds', 'region', 'padding', 'sheetName',
  'contactSheet', 'tileRows', 'tileColumns', 'registries', 'handle', 'handles',
]);

/** 每个参数的极简类型（生成 JSON Schema 用；描述留空以省 token）。 */
const ARG_TYPES = Object.freeze({
  file: 'string', unitId: 'string', worktreeId: 'string', output: 'string',
  source: 'string', code: 'string', codeFile: 'string', name: 'string',
  kind: 'string', action: 'string', range: 'string', scale: 'number',
  limit: 'number', unit: 'string', docType: 'string', mode: 'string',
  page: 'number', padding: 'number', sheetName: 'string',
  contactSheet: 'boolean', tileRows: 'number', tileColumns: 'number',
  queries: 'array', pages: 'array', elementIds: 'array', registries: 'array',
  handle: 'string', handles: 'array', region: 'object',
});

/**
 * 生成门面工具的 JSON Schema（**直接面向模型**，所以按 token 逐字优化）。
 *
 * 设计要点：
 * - 只声明 `op` 必填，其余全部可选：门面自身做本地校验并给出更好的报错；
 * - 参数一律不写 description —— 语义由描述里的速查行 + 各 op 的必填说明承担，
 *   平均每个参数只花 ~30 字符，而不是动辄 60~200 字符；
 * - **不设 `additionalProperties: false`**：未知参数会被原样转发给底层工具，
 *   既不会误伤能力，也不会因为 schema 过紧而浪费一次往返。
 *
 * @returns {object} JSON Schema。
 */
export function facadeParameters() {
  const properties = {
    // 没有 description：op 清单已经在工具描述里，重复一遍纯属浪费（~250 字符/请求）。
    op: { type: 'string' },
  };
  for (const name of ARG_VOCABULARY) {
    const type = ARG_TYPES[name] ?? 'string';
    properties[name] = type === 'array'
      ? { type: 'array', items: { type: name === 'pages' ? 'number' : 'string' } }
      : { type };
  }
  properties.ops = {
    type: 'array',
    description: 'batch: steps, each {op, ...args}',
    items: { type: 'object' },
  };
  properties.force = { type: 'boolean', description: 'screenshot: ignore the budget' };
  properties.stopOnError = { type: 'boolean', description: 'batch: stop at first failure' };
  return { type: 'object', properties, required: ['op'] };
}

/**
 * 生成模型可见的门面描述。
 *
 * 这段文字是本插件**唯一**的常驻说明：它取代了 14 份工具描述、7 份技能里的
 * 流程段落，以及模型自己试错学到的调用方式。每多 4 个字符 ≈ 1 token，
 * 而且是每一个请求都要付一次，所以这里按「信息密度」逐句删过。
 *
 * @param {object} options - 生成参数。
 * @param {number} options.budget - 每个会话的截图预算（写进描述，让模型知道边界）。
 * @param {boolean} options.memo - 是否开启记忆化。
 * @returns {string} 工具描述。
 */
export function facadeDescription({ budget, memo }) {
  // 用英文而不是中文：同一份信息，中文约 1 token/字符，英文约 0.25 token/字符。
  // 这段文字每个请求都要付一次，所以它是全插件里最值得逐字抠的一段。
  const lines = [
    'Univer Office single entry point. This tool replaces every univer_* tool (they are still registered but hidden from you).',
    `op: ${OP_NAMES.join(' | ')}`,
    'Cheapest workflow - follow it, do not probe:',
    '1. status{file} once -> unitId/worktreeId. Never call it again for the same file.',
    '2. Need several read results? One batch call, not several calls.',
    '3. Put ALL edits of a unit into ONE execute (one JS program), not one step per edit.',
    '4. Verify with lint (cheap). Screenshot only when layout/visuals actually matter.',
    '5. export / pdf last.',
    'One-shot habit: build the whole thing in a single execute (loop over pages inside your JS) and return one small summary - not one call per page.',
    `Args: ${ARG_VOCABULARY.join(', ')} - pass only what the op needs; unknown keys are forwarded as-is.`,
    'Skill texts still name these tools as univer_<op> (e.g. univer_execute, univer_compile_svg). Call THIS tool with op:"execute", op:"svg" instead - those names no longer exist.',
    'batch: {op:"batch", ops:[{op:"status",file:"a.univer"}, {op:"execute",file:"a.univer",unitId:"u1",code:"..."}]}',
    'Cost rules:',
    memo ? '- An identical read call is not re-executed: it returns one line "[unchanged]" - the previous payload is still above.' : '',
    budget > 0 ? `- Screenshot images are capped at ${budget} per session (text is still returned); pass force:true to exceed.` : '',
    '- One screenshot costs roughly 100x one lint. Do not capture what you can read.',
    '- One batch costs one round trip; N separate calls cost N round trips (each re-sends the whole context).',
  ];
  return lines.filter((line) => line !== '').join('\n');
}
