/**
 * 单元测试：全部跑在纯函数与假 runtime 上，不依赖 DSH 运行时。
 *
 * 这里守的是三条底线：
 * 1. **不许变大**——压缩器在任何输入下都不能让结果更长（净收益闸门）；
 * 2. **不许弄坏信息**——报错子树免剪、省略说明必须三要素齐全、JSON 剪完仍是合法 JSON；
 * 3. **不许不确定**——同样的输入必须逐字节相同的输出（前缀缓存的要求，不是洁癖）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { compactContent, compactText, prune, retainText } from '../lib/compact.js';
import { normalizeConfig, DEFAULTS } from '../lib/config.js';
import { createFacade, normalizeOp } from '../lib/facade.js';
import { createMemo, memoKey, stableStringify } from '../lib/memo.js';
import { facadeDescription, facadeParameters, OP_NAMES, OPS } from '../lib/ops.js';

//#region helpers

/** 假 ToolRuntime：只实现门面用到的四个方法。 */
function fakeTools(definitions) {
  const map = new Map(Object.entries(definitions));
  return {
    map,
    get: (name) => map.get(name),
    register: (definition) => {
      map.set(definition.name, definition);
      return () => map.delete(definition.name);
    },
    view: () => ({ visible: map, restrictableNames: new Set(map.keys()) }),
    restrict: () => () => {},
  };
}

/** 造一个底层的「univer 风格」工具定义。 */
function tool(name, { text, image, throws } = {}) {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => value.parts,
    },
    async execute(args) {
      if (throws !== undefined) throw throws;
      return { parts: text === undefined ? [] : [{ type: 'text', text: String(text).replace('$ARGS', JSON.stringify(args)) }, ...(image ?? [])] };
    },
  };
}

const CFG = normalizeConfig({});

function build(definitions, overrides = {}) {
  const tools = fakeTools(definitions);
  const memo = createMemo();
  const config = normalizeConfig({ ...overrides });
  const facade = createFacade({
    config,
    resolveTool: (name) => tools.get(name),
    memo,
    log: () => {},
    imageLimit: () => ({ maxImagesPerMessage: 3 }),
  });
  return { tools, memo, facade, config };
}

/** 取出结果里的纯文本。 */
const textOf = (value) => value.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
const imagesOf = (value) => value.parts.filter((p) => p.type === 'image');

//#endregion

//#region compact

test('JSON 语义剪枝：删空值、限数组、限长字符串，且仍是合法 JSON', () => {
  const value = {
    ok: true,
    operation: 'inspect',
    cells: Array.from({ length: 100 }, (_, index) => ({ row: index, note: '' })),
    empty: [],
    nothing: null,
    long: 'x'.repeat(500),
    error: { message: '', code: 'X' },
  };
  const pruned = prune(value, { arrayItems: 3, stringChars: 40, depth: 6 }, '', 0, { empties: 0, items: 0, strings: 0, depth: 0 });
  assert.equal(pruned.cells.length, 4, '保留 3 项 + 1 条省略标记');
  assert.match(pruned.cells.at(-1), /\+97 more/);
  assert.equal(Object.hasOwn(pruned, 'empty'), false);
  assert.equal(Object.hasOwn(pruned, 'nothing'), false);
  assert.equal(pruned.long.length < 500, true);
  assert.equal(JSON.parse(JSON.stringify(pruned)).ok, true);
  // 报错子树整棵免剪：message 即使为空也要原样留下。
  assert.deepEqual(pruned.error, { message: '', code: 'X' });
});

test('剪枝阶梯：预算越紧，结果越小，且永远保持合法 JSON', () => {
  const payload = JSON.stringify({ ok: true, rows: Array.from({ length: 900 }, (_, i) => ({ i, pad: 'y'.repeat(60) })) });
  let previous = Number.POSITIVE_INFINITY;
  for (const budget of [20_000, 4_000, 1_200, 400]) {
    const result = compactText(payload, { budget });
    assert.equal(result.changed, true);
    assert.doesNotThrow(() => JSON.parse(result.text), `budget=${budget} 剪完必须仍是合法 JSON`);
    assert.ok(result.text.length <= previous, `更紧的预算不应更大：${previous} -> ${result.text.length}`);
    previous = result.text.length;
  }
});

test('净收益闸门：已经很小、或压不动的输入必须原样返回', () => {
  const small = '{"ok":true}';
  assert.deepEqual(compactText(small, { budget: 1400 }).changed, false);
  const plain = 'a'.repeat(3000);
  const retained = compactText(plain, { budget: 1400 });
  assert.equal(retained.changed, true);
  assert.ok(retained.text.length < plain.length);
  // 幂等：再压一次不应该继续变小（否则说明每轮都在改写同一段前缀）。
  const again = compactText(retained.text, { budget: 1400 });
  assert.equal(again.changed, false);
});

test('文本预算：省略说明必须同时给出「丢了多少 / 多少报错行 / 怎么拿回来」', () => {
  const lines = [];
  for (let index = 0; index < 400; index += 1) lines.push(`line ${index} ${'z'.repeat(40)}`);
  lines[200] = 'ERROR something exploded';
  lines[201] = 'ERROR another failure';
  const result = retainText(lines.join('\n'), 1200, { hint: 're-run with a narrower range' });
  assert.notEqual(result, null);
  assert.match(result.text, /\[…\] omitted \d+ chars \/ \d+ lines of \d+/);
  assert.match(result.text, /re-run with a narrower range/);
  // 报错行要么被捞回来留在正文里，要么被如实计入「丢在中间」——两者必居其一。
  const rescued = /ERROR something exploded/.test(result.text);
  const counted = /\d+ error\/warning lines were in the omitted middle/.test(result.text);
  assert.ok(rescued || counted, '报错行既没被保留也没被计数，说明说明行在撒谎');
  assert.ok(result.text.length < lines.join('\n').length);
});

test('文本预算：捞不回来的报错行必须被精确计数', () => {
  const lines = [];
  for (let index = 0; index < 600; index += 1) {
    lines.push(index % 3 === 0 ? `ERROR failure number ${index} ${'e'.repeat(60)}` : `body ${index} ${'z'.repeat(60)}`);
  }
  const result = retainText(lines.join('\n'), 1000, { hint: 'narrow it down' });
  assert.notEqual(result, null);
  assert.ok(result.importantDropped > 0, '这个构造下必然有报错行捞不回来');
  assert.match(result.text, /\d+ error\/warning lines were in the omitted middle/);
  assert.equal(result.droppedLines > 0, true);
  assert.equal(result.dropped > 0, true);
});

test('确定性：同样的输入产生逐字节相同的输出', () => {
  const payload = JSON.stringify({ ok: true, rows: Array.from({ length: 50 }, (_, i) => ({ i, note: 'n'.repeat(80) })) });
  const a = compactText(payload, { budget: 800 });
  const b = compactText(payload, { budget: 800 });
  assert.equal(a.text, b.text);
});

test('compactContent：只动 text part，图片等结构化块原样保留', () => {
  const parts = [
    { type: 'text', text: JSON.stringify({ ok: true, rows: Array.from({ length: 80 }, (_, i) => ({ i, pad: 'p'.repeat(50) })) }) },
    { type: 'image', attachment: { attachmentId: 'a1' } },
  ];
  const result = compactContent(parts, { budget: 600 });
  assert.equal(result.changed, true);
  assert.equal(result.content.some((part) => part.type === 'image'), true);
  assert.equal(result.content.find((part) => part.type === 'image').attachment.attachmentId, 'a1');
});

//#endregion

//#region memo

test('记忆化：键与参数顺序无关，命中后仍可失效', () => {
  assert.equal(memoKey('status', { file: 'a', unitId: 'u' }), memoKey('status', { unitId: 'u', file: 'a' }));
  assert.notEqual(memoKey('status', { file: 'a' }), memoKey('inspect', { file: 'a' }));
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  const memo = createMemo({ maxEntries: 2 });
  memo.set('k1', 'v1');
  assert.equal(memo.get('k1').text, 'v1');
  assert.equal(memo.get('nope'), undefined);
  memo.set('k2', 'v2');
  memo.set('k3', 'v3');
  assert.equal(memo.stats().size, 2, 'LRU 上限生效');
  assert.equal(memo.get('k1'), undefined, '最旧的条目被挤出');
  assert.equal(memo.invalidate(), 2);
  assert.equal(memo.stats().size, 0);
});

//#endregion

//#region ops / config

test('门面 schema 与描述必须显著小于它取代的 14 个工具', () => {
  const schemaChars = JSON.stringify(facadeParameters()).length;
  const descriptionChars = facadeDescription({ budget: 8, memo: true }).length;
  const total = schemaChars + descriptionChars + 'univer'.length;
  // 实测原 14 个工具的模型可见定义合计 11,511 字符。
  // 阈值放宽到 3,300 是**有意的**：描述里那句 one-shot 引导约 140 字符（≈35 token/请求），
  // 而一次被省掉的往返就是 93,034 token——一次往返就能赚回 2,600 次请求的这行字。
  assert.ok(total < 3_300, `门面合计 ${total} 字符，超出预算`);
  assert.ok(total * 3 < 11_511, '必须比原工具面小三倍以上');
  // 每个 op 都必须在描述里出现，否则模型无法发现它。
  for (const op of OP_NAMES) assert.ok(facadeDescription({ budget: 8, memo: true }).includes(op), `描述缺少 op: ${op}`);
  // 技能文档里写的是 univer_execute 这类已被隐藏的名字，必须明确告诉模型怎么翻译，
  // 否则它会照着技能去调一个不存在的工具，白烧一次完整往返。
  assert.match(facadeDescription({ budget: 8, memo: true }), /univer_<op>/, '必须给出技能名到 op 的翻译提示');
});

test('op 归一化：别名、大小写、前缀都能落到同一个规范 op', () => {
  assert.equal(normalizeOp('status'), 'status');
  assert.equal(normalizeOp('  PRINT_PDF '), 'pdf');
  assert.equal(normalizeOp('univer:execute'), 'execute');
  assert.equal(normalizeOp('screenshot'), 'screenshot');
  assert.equal(normalizeOp('nonsense'), undefined);
  assert.equal(normalizeOp(42), undefined);
  // 每个 op 都必须指向一个真实存在的 univer 工具名。
  for (const [op, spec] of Object.entries(OPS)) assert.match(spec.tool, /^univer_/, `${op} 指向了非 univer 工具`);
});

test('配置：非法输入退化成默认值并告警，绝不抛错', () => {
  const warnings = [];
  assert.deepEqual(normalizeConfig(undefined, (m) => warnings.push(m)), DEFAULTS);
  const bad = normalizeConfig({ maxInlineChars: 'big', nope: 1, screenshotBudget: -5, readConcurrency: 99 }, (m) => warnings.push(m));
  assert.equal(bad.maxInlineChars, DEFAULTS.maxInlineChars);
  assert.equal(bad.screenshotBudget, 0);
  assert.equal(bad.readConcurrency, 16);
  assert.equal(Object.hasOwn(bad, 'nope'), false);
  assert.ok(warnings.length >= 2, `应至少告警 2 次，实际 ${warnings.length}`);
  assert.equal(normalizeConfig('nonsense', () => {}).facadeName, 'univer');
  assert.equal(normalizeConfig({ facadeName: 'bad name!' }, () => {}).facadeName, 'univer');
});

//#endregion

//#region facade

test('门面：必填参数缺失时在本地报错，绝不发起远端调用', async () => {
  let called = 0;
  const { facade } = build({ univer_status: { ...tool('univer_status', { text: 'x' }), execute: async () => { called += 1; return { parts: [] }; } } });
  await assert.rejects(() => facade.definition.execute({ op: 'status' }, {}), /ERROR status requires: file/);
  assert.equal(called, 0, '本地校验失败时不得调用底层工具');
  assert.equal(facade.stats.localErrors, 1);
});

test('门面：未知 op 与未注册工具都给出可执行的下一步', async () => {
  const { facade } = build({});
  await assert.rejects(() => facade.definition.execute({ op: 'nope' }, {}), /missing or unknown "op"/);
  await assert.rejects(() => facade.definition.execute({ op: 'status', file: 'a.univer' }, {}), /univer_status is not registered/);
});

test('门面：转发时摘掉门面自有参数，未知参数原样透传', async () => {
  const seen = [];
  const { facade } = build({
    univer_execute: { ...tool('univer_execute', { text: 'ok' }), execute: async (args) => { seen.push(args); return { parts: [{ type: 'text', text: 'done' }] }; } },
  });
  const value = await facade.definition.execute({ op: 'execute', file: 'a.univer', unitId: 'u1', code: 'x', force: true, weird: 7 }, {});
  assert.deepEqual(seen, [{ file: 'a.univer', unitId: 'u1', code: 'x', weird: 7 }]);
  assert.equal(textOf(value), 'done');
});

test('门面：完全相同的只读调用第二次只回一行指针', async () => {
  let calls = 0;
  const payload = JSON.stringify({ ok: true, units: Array.from({ length: 40 }, (_, i) => ({ id: `u${i}`, name: `n${i}`, pad: 'p'.repeat(30) })) });
  const { facade } = build({
    univer_status: { ...tool('univer_status', { text: payload }), execute: async () => { calls += 1; return { parts: [{ type: 'text', text: payload }] }; } },
  });
  const first = await facade.definition.execute({ op: 'status', file: 'a.univer' }, {});
  const second = await facade.definition.execute({ op: 'status', file: 'a.univer' }, {});
  assert.equal(calls, 1, '第二次不得再调用底层工具');
  assert.match(textOf(second), /unchanged/);
  assert.ok(textOf(second).length < textOf(first).length, '指针必须比载荷短');
  assert.equal(facade.stats.cached, 1);
});

test('门面：batch 内两个完全相同的只读步骤只打一次底层调用', async () => {
  // 这是活的端到端验证里抓到的真实缺陷：两个相同的只读步骤是**并发启动**的，
  // 若只认「已完成」的缓存，第二个会错过缓存再打一次网关。
  let calls = 0;
  let live = 0;
  let peak = 0;
  const { facade } = build({
    univer_status: {
      ...tool('univer_status', { text: 'S' }),
      async execute() {
        calls += 1;
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setTimeout(resolve, 20));
        live -= 1;
        return { parts: [{ type: 'text', text: 'S' }] };
      },
    },
  });
  const value = await facade.definition.execute({
    op: 'batch',
    ops: [{ op: 'status', file: 'a.univer' }, { op: 'status', file: 'a.univer' }],
  }, {});
  assert.equal(calls, 1, '完全相同的只读调用只应执行一次');
  assert.equal(peak, 1, '第二个步骤应当等第一个，而不是并发再打一次');
  assert.match(textOf(value), /unchanged/);
  assert.equal(facade.stats.cached, 1);
});

test('门面：写操作让只读缓存失效', async () => {
  let statusCalls = 0;
  const { facade } = build({
    univer_status: { ...tool('univer_status', { text: 'A' }), execute: async () => { statusCalls += 1; return { parts: [{ type: 'text', text: 'A' }] }; } },
    univer_execute: tool('univer_execute', { text: 'mutated' }),
  });
  await facade.definition.execute({ op: 'status', file: 'a.univer' }, {});
  await facade.definition.execute({ op: 'execute', file: 'a.univer', unitId: 'u1', code: 'x' }, {});
  await facade.definition.execute({ op: 'status', file: 'a.univer' }, {});
  assert.equal(statusCalls, 2, '写之后必须重新取，绝不能拿旧状态糊弄模型');
});

test('门面：batch 把 N 次往返压成 1 次，并标出失败的那一步', async () => {
  let calls = 0;
  const { facade } = build({
    univer_status: { ...tool('univer_status', { text: 'S' }), execute: async () => { calls += 1; return { parts: [{ type: 'text', text: 'S' }] }; } },
    univer_lint: { ...tool('univer_lint', { text: 'L' }), execute: async () => { calls += 1; return { parts: [{ type: 'text', text: 'L' }] }; } },
    univer_execute: { ...tool('univer_execute', { text: 'E' }), execute: async () => { calls += 1; return { parts: [{ type: 'text', text: 'E' }] }; } },
    univer_export: { ...tool('univer_export', { text: 'X' }), execute: async () => { calls += 1; throw new Error('boom'); } },
  });
  const value = await facade.definition.execute({
    op: 'batch',
    ops: [
      { op: 'status', file: 'a.univer' },
      { op: 'lint', file: 'a.univer', unitId: 'u1' },
      { op: 'execute', file: 'a.univer', unitId: 'u1', code: 'x' },
      { op: 'export', file: 'a.univer', unitId: 'u1', output: 'out.pptx' },
    ],
  }, {});
  const text = textOf(value);
  assert.equal(calls, 4);
  assert.match(text, /▸ \[1\] status/);
  assert.match(text, /▸ \[4\] export failed/);
  assert.match(text, /ERROR export/);
  assert.equal(value.ok, false);
});

test('门面：连续的只读步骤在 batch 内并发执行', async () => {
  let peak = 0;
  let live = 0;
  const slow = () => ({
    ...tool('univer_status', { text: 'S' }),
    async execute() {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 25));
      live -= 1;
      return { parts: [{ type: 'text', text: 'S' }] };
    },
  });
  const tools = { univer_status: slow(), univer_inspect: { ...slow(), name: 'univer_inspect' } };
  const config = normalizeConfig({ readConcurrency: 2 });
  const facade = createFacade({ config, resolveTool: (n) => tools[n], memo: createMemo(), log: () => {}, imageLimit: () => undefined });
  await facade.definition.execute({
    op: 'batch',
    ops: [{ op: 'status', file: 'a' }, { op: 'inspect', file: 'a', unitId: 'u' }],
  }, {});
  assert.equal(peak, 2, '两个只读步骤应当重叠执行');
});

test('门面：截图预算用尽后只留文字与落盘路径', async () => {
  const image = () => ({ type: 'image', attachment: { attachmentId: `a${Math.random()}` } });
  const { facade } = build({ univer_screenshot: tool('univer_screenshot', { text: 'shot', image: [image()] }) }, { screenshotBudget: 1 });
  const first = await facade.definition.execute({ op: 'screenshot', file: 'a.univer', unitId: 'u1', output: 'png', pages: [1] }, {});
  assert.equal(imagesOf(first).length, 1);
  const second = await facade.definition.execute({ op: 'screenshot', file: 'a.univer', unitId: 'u1', output: 'png', pages: [2] }, {});
  assert.equal(imagesOf(second).length, 0);
  assert.match(textOf(second), /withheld/);
  assert.match(textOf(second), /force:true/);
  const forced = await facade.definition.execute({ op: 'screenshot', file: 'a.univer', unitId: 'u1', output: 'png', pages: [3], force: true }, {});
  assert.equal(imagesOf(forced).length, 1, 'force 必须能突破预算');
});

test('门面：同一目标重复截图不再重投图片', async () => {
  const { facade } = build({ univer_screenshot: tool('univer_screenshot', { text: 'shot', image: [{ type: 'image', attachment: { attachmentId: 'k' } }] }) });
  await facade.definition.execute({ op: 'screenshot', file: 'a.univer', unitId: 'u1', output: 'png', pages: [1] }, {});
  const again = await facade.definition.execute({ op: 'screenshot', file: 'a.univer', unitId: 'u1', output: 'png', pages: [1] }, {});
  assert.match(textOf(again), /already in this conversation/);
  assert.equal(imagesOf(again).length, 0);
});

test('门面：超过附件上限的截图请求在渲染前自动分片', async () => {
  const batches = [];
  const { facade } = build({
    univer_screenshot: {
      ...tool('univer_screenshot', { text: 'shot' }),
      async execute(args) {
        batches.push(args.pages);
        return { parts: [{ type: 'text', text: `pages ${args.pages.join(',')}` }, { type: 'image', attachment: { attachmentId: `p${args.pages[0]}` } }] };
      },
    },
  });
  const value = await facade.definition.execute({ op: 'screenshot', file: 'a.univer', unitId: 'u1', output: 'png', pages: [1, 2, 3, 4, 5, 6, 7] }, {});
  assert.deepEqual(batches, [[1, 2, 3], [4, 5, 6], [7]], '按附件上限 3 分片');
  assert.equal(imagesOf(value).length, 3);
  assert.equal(facade.stats.chunkedScreenshots, 1);
});

test('回声抑制：结果里只是把调用参数念一遍的字段会被删掉', async () => {
  const { facade } = build({
    univer_execute: tool('univer_execute', {
      text: JSON.stringify({ ok: true, operation: 'execute', file: '/abs/ws/a.univer', unitId: 'u1', result: { changed: 3 } }),
    }),
  });
  const value = await facade.definition.execute({ op: 'execute', file: 'a.univer', unitId: 'u1', code: 'x' }, {});
  const parsed = JSON.parse(textOf(value));
  assert.equal(Object.hasOwn(parsed, 'operation'), false, 'operation 由 op 唯一决定，是纯冗余');
  assert.equal(Object.hasOwn(parsed, 'file'), false, '参数里刚写过这个文件，不必再念一遍');
  assert.equal(parsed.ok, true, 'ok 承载成败，必须保留');
  assert.deepEqual(parsed.result, { changed: 3 }, '真正的新信息一个不能动');
});

test('回声抑制：参数与结果不同源时不许删（那是新信息）', async () => {
  const { facade } = build({
    univer_execute: tool('univer_execute', {
      text: JSON.stringify({ ok: true, file: '/other/place/b.univer', result: { changed: 1 } }),
    }),
  });
  const value = await facade.definition.execute({ op: 'execute', file: 'a.univer', unitId: 'u1', code: 'x' }, {});
  assert.equal(JSON.parse(textOf(value)).file, '/other/place/b.univer', '不是回声就不许删');
});

test('按 op 的预算：svg 结果即使没到全局预算也会被压', async () => {
  const payload = JSON.stringify({ ok: true, operation: 'compile_svg', file: '/a.univer', result: { viewport: { width: 1600, height: 900 }, applied: Array.from({ length: 60 }, (_, i) => ({ i, pad: 'v'.repeat(40) })) } });
  const small = build({ univer_compile_svg: tool('univer_compile_svg', { text: payload }) }, { maxInlineChars: 1400 });
  const wide = build({ univer_compile_svg: tool('univer_compile_svg', { text: payload }) }, { maxInlineChars: 1400, opBudgets: { svg: 300 } });
  const a = textOf(await small.facade.definition.execute({ op: 'svg', file: 'a.univer', unitId: 'u1', page: 1, source: 's.svg' }, {}));
  const b = textOf(await wide.facade.definition.execute({ op: 'svg', file: 'a.univer', unitId: 'u1', page: 1, source: 's.svg' }, {}));
  assert.ok(b.length < a.length, `收紧 svg 预算后应更小：${a.length} -> ${b.length}`);
  assert.ok(b.length <= 400, `svg 结果应落进 300 字符预算附近，实际 ${b.length}`);
});

test('失败记忆化：确定性失败不重跑，超时类仍然允许重试', async () => {
  let calls = 0;
  const boom = (message) => ({
    ...tool('univer_screenshot', { text: 'x' }),
    async execute() { calls += 1; throw new Error(message); },
  });
  const stable = build({ univer_screenshot: boom('image batch exceeds the configured image-count limit') });
  const args = { op: 'screenshot', file: 'a.univer', unitId: 'u1', output: 'png', pages: [1] };
  await assert.rejects(() => stable.facade.definition.execute(args, {}), /exceeds/);
  // 命中的失败仍然是失败：必须继续以 isError 呈现，模型侧的纠错信号才完整。
  await assert.rejects(
    () => stable.facade.definition.execute(args, {}),
    (error) => {
      assert.match(error.message, /exceeds/, '报错必须全文重发，不能让模型去上文里翻');
      return true;
    },
  );
  assert.equal(calls, 1, '完全相同的确定性失败不该重跑（实测每次要烧 8 秒 + 一个往返）');
  assert.equal(stable.facade.stats.cachedFailures, 1);

  let timeoutCalls = 0;
  const flaky = build({
    univer_screenshot: {
      ...tool('univer_screenshot', { text: 'x' }),
      async execute() { timeoutCalls += 1; throw new Error('operation timed out'); },
    },
  });
  await assert.rejects(() => flaky.facade.definition.execute(args, {}), /timed out/);
  await assert.rejects(() => flaky.facade.definition.execute(args, {}), /timed out/);
  assert.equal(timeoutCalls, 2, '超时可能是瞬时的，必须允许重试');
});

test('超限截图分片并发渲染，且输出顺序逐字节确定', async () => {
  let live = 0;
  let peak = 0;
  const { facade } = build({
    univer_screenshot: {
      ...tool('univer_screenshot', { text: 'x' }),
      async execute(args) {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setTimeout(resolve, 15));
        live -= 1;
        return { parts: [{ type: 'text', text: `pages ${args.pages.join(',')}` }, { type: 'image', attachment: { attachmentId: `p${args.pages[0]}` } }] };
      },
    },
  }, { chunkConcurrency: 3, screenshotBudget: 0, dedupeImages: false });
  const value = await facade.definition.execute({ op: 'screenshot', file: 'a.univer', unitId: 'u1', output: 'png', pages: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, {});
  assert.equal(peak, 3, '三片应当重叠渲染，而不是串行等三次浏览器启动');
  const ids = imagesOf(value).map((part) => part.attachment.attachmentId);
  assert.deepEqual(ids, ['p1', 'p4', 'p7'], '并发不允许改变合并顺序');
});

test('门面：底层失败被压成一行并附带下一步', async () => {
  const { facade } = build({ univer_execute: tool('univer_execute', { throws: Object.assign(new Error('unit u1 not found'), { code: 'UNIVER_UNIT_MISSING' }) }) });
  await assert.rejects(
    () => facade.definition.execute({ op: 'execute', file: 'a.univer', unitId: 'u1', code: 'x' }, {}),
    (error) => {
      assert.match(error.message, /ERROR execute UNIVER_UNIT_MISSING: unit u1 not found/);
      assert.match(error.message, /next: call status\{file\} to get a valid unitId/);
      return true;
    },
  );
});

test('门面：结果在返回之前就已经压进预算', async () => {
  const huge = JSON.stringify({ ok: true, rows: Array.from({ length: 400 }, (_, i) => ({ i, pad: 'q'.repeat(80), nil: null })) });
  const { facade } = build({ univer_inspect: tool('univer_inspect', { text: huge }) }, { maxInlineChars: 900 });
  const value = await facade.definition.execute({ op: 'inspect', file: 'a.univer', unitId: 'u1' }, {});
  assert.ok(textOf(value).length < huge.length / 4, '必须显著变小');
  assert.equal(facade.stats.charsAfter < facade.stats.charsBefore, true);
});

//#endregion

test('按页缓存：同一页重复编译只执行一次，其它页不受影响', async () => {
  const calls = [];
  const { facade } = build({
    univer_compile_svg: {
      ...tool('univer_compile_svg', { text: 'compiled' }),
      async execute(args) {
        calls.push(`${args.unitId}#${args.page}`);
        return { parts: [{ type: 'text', text: `compiled ${args.unitId}#${args.page}` }] };
      },
    },
  });
  const svg = (page) => facade.definition.execute({ op: 'svg', file: 'a.univer', unitId: 'u1', page, source: 's.svg' }, {});
  await svg(7);
  await svg(3);
  const again = await svg(7);       // ← 中间夹了别的页，不该失效
  assert.deepEqual(calls, ['u1#7', 'u1#3'], '第 7 页第二次必须命中缓存，不得重新编译');
  assert.match(textOf(again), /unchanged/);
  assert.equal(facade.stats.cachedCompiles, 1);
});

test('按页缓存：同一页换了参数时旧缓存立即失效（页面内容已经变了）', async () => {
  const calls = [];
  const { facade } = build({
    univer_compile_svg: {
      ...tool('univer_compile_svg', { text: 'compiled' }),
      async execute(args) {
        calls.push(args.source);
        return { parts: [{ type: 'text', text: `compiled ${args.source}` }] };
      },
    },
  });
  const svg = (source) => facade.definition.execute({ op: 'svg', file: 'a.univer', unitId: 'u1', page: 7, source }, {});
  await svg('a.svg');
  await svg('b.svg');            // 同一页换了源 → a.svg 的缓存必须作废
  const back = await svg('a.svg');
  assert.deepEqual(calls, ['a.svg', 'b.svg', 'a.svg'], 'a.svg 必须真的重新编译（页面已被 b.svg 改写）');
  assert.equal(/unchanged/.test(textOf(back)), false);
});

test('按页缓存：execute 会作废整张编译缓存（它可能改到任何一页）', async () => {
  const calls = [];
  const { facade } = build({
    univer_compile_svg: {
      ...tool('univer_compile_svg', { text: 'c' }),
      async execute(args) { calls.push(`svg#${args.page}`); return { parts: [{ type: 'text', text: 'c' }] }; },
    },
    univer_execute: {
      ...tool('univer_execute', { text: 'e' }),
      async execute() { calls.push('execute'); return { parts: [{ type: 'text', text: 'e' }] }; },
    },
  });
  await facade.definition.execute({ op: 'svg', file: 'a.univer', unitId: 'u1', page: 7, source: 's.svg' }, {});
  await facade.definition.execute({ op: 'execute', file: 'a.univer', unitId: 'u1', code: 'x' }, {});
  await facade.definition.execute({ op: 'svg', file: 'a.univer', unitId: 'u1', page: 7, source: 's.svg' }, {});
  assert.deepEqual(calls, ['svg#7', 'execute', 'svg#7'], 'execute 之后必须重新编译，绝不能拿过期结果');
});
