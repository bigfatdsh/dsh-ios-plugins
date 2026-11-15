/**
 * 前缀缓存不变量测试。
 *
 * DSH 的请求前缀完全依赖 provider 侧复用：真实会话里 `cacheReadTokens` 占全部 token
 * 的 98.3%，平均每次请求要重发 93,034 token 的上下文。任何**按轮次**的改动都会让
 * 从改动点往后的整段前缀作废，省下的那点 token 会以数倍价格还回去。
 *
 * 所以本插件给自己定了三条硬约束，这里逐条做成可执行的断言：
 *   1. 只在 `agent/created`（会话第一个请求之前）动一次工具表，之后永不增删；
 *   2. 绝不挂 `system-prompt` / `request` / `tool*schema` 之类会改写前缀的事件；
 *   3. 门面的描述与 schema 逐字节确定——同样的配置必然得到同样的文本。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SECTION_NAME, SECTION_TEXT, PPT_SECTION_NAME, PPT_SECTION_TEXT } from '../lib/advice.js';
import { facadeDescription, facadeParameters } from '../lib/ops.js';
import { apply } from '../lib/index.js';

/** 最小上下文：只实现本插件用到的东西。 */
function createRootContext(agents = []) {
  const listeners = [];
  const logs = [];
  const sections = [];
  const ctx = {
    listeners,
    logs,
    sections,
    systemPrompt: { section: (section) => { sections.push(section); return () => {}; } },
    // 真实 Cordis 上下文一定有 `get`；插件只用 `get` 取服务，替身必须一样，
    // 否则测的就不是真实契约了。这里刻意读自身属性，这样测试替换
    // `ctx.systemPrompt`（或删掉它）时 `get` 也跟着变。
    get(name) { return this[name]; },
    agents: { list: () => agents },
    on(event, handler, options) {
      listeners.push({ event, handler, options });
      return () => {};
    },
    inject(services, callback) {
      listeners.push({ event: 'inject', services, callback });
      return { dispose: async () => {} };
    },
    effect(register) { register(); return () => {}; },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: () => {} },
  };
  return ctx;
}

/** agent 作用域上下文：`inject` 立刻兑现。 */
function createAgent(id) {
  const listeners = [];
  const ctx = {
    id,
    listeners,
    get: () => undefined,
    on(event, handler, options) { listeners.push({ event, handler, options }); },
    effect(register) { register(); },
    inject(_services, callback) { callback(ctx); return { dispose: async () => {} }; },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  };
  return { id, ctx };
}

/** 一个能通过 restrict 校验的假 ToolRuntime。 */
function createTools(names) {
  const map = new Map(names.map((name) => [name, { name, execute: async () => ({ parts: [] }) }]));
  return {
    map,
    registered: [],
    restrictions: [],
    get: (name) => map.get(name),
    register(definition) { map.set(definition.name, definition); this.registered.push(definition.name); return () => map.delete(definition.name); },
    view: () => ({ visible: map, restrictableNames: new Set(map.keys()) }),
    restrict(filter) { this.restrictions.push(filter); return () => {}; },
  };
}

test('前缀不变性：根上只挂 agent/created 与兜底 post-execute，且从不挂提示词/请求类事件', () => {
  const ctx = createRootContext();
  apply(ctx, {});
  const events = ctx.listeners.map((item) => item.event).sort();
  // 根上的 post-execute 只覆盖非 agent 作用域的执行（agent 作用域的事件不会派发到根，
  // 所以真正的兜底压缩是在每个 agent 自己的作用域里注册的）。
  // `tools/change` 是工具注册表变化时的全局广播，用于在 univer 工具**晚于本插件**注册时
  // 补做收窄（这两者的就绪顺序是竞态，实测复现过一次）。它只在工具表真的变化时触发。
  assert.deepEqual(events, ['agent/created', 'tools/change', 'tools/post-execute'], `根上事件集合不符：${events}`);
  for (const event of events) {
    assert.equal(/system-prompt|request|tool.*schema|assemble|pre-execute/i.test(event), false, `不得挂 ${event}`);
  }
});

test('工具表只在该 agent 建立时改一次，重复事件不会二次安装', () => {
  const ctx = createRootContext();
  apply(ctx, {});
  const agent = createAgent('session-1');
  agent.ctx.tools = createTools(['univer_status', 'univer_inspect', 'univer_execute']);
  const created = ctx.listeners.find((item) => item.event === 'agent/created');
  created.handler({ agent });
  created.handler({ agent });
  created.handler({ agent });
  const scoped = agent.ctx.listeners.filter((item) => item.event === 'tools/post-execute');
  assert.equal(scoped.length, 1, '同一条 post-execute 监听器只能注册一次');
  assert.equal(agent.ctx.tools.registered.filter((n) => n === 'univer').length, 1, '门面只能注册一次');
  assert.equal(agent.ctx.tools.restrictions.length, 1, 'restrict 只能打一次');
  assert.deepEqual(agent.ctx.tools.restrictions[0].deny, ['univer_execute', 'univer_inspect', 'univer_status']);
});

test('工具表内容逐字节确定：同样的配置必然得到同样的门面', () => {
  const a = JSON.stringify({ description: facadeDescription({ budget: 8, memo: true }), parameters: facadeParameters() });
  const b = JSON.stringify({ description: facadeDescription({ budget: 8, memo: true }), parameters: facadeParameters() });
  assert.equal(a, b);
  // 配置不同则文本不同（预算是写进描述里的，必须如实反映）。
  const c = facadeDescription({ budget: 3, memo: false });
  assert.notEqual(c, facadeDescription({ budget: 8, memo: true }));
  assert.match(c, /capped at 3 per session/);
});

test('门面 schema 不含易变字段（时间戳/随机/环境相关）', () => {
  const text = JSON.stringify(facadeParameters());
  assert.equal(/\d{10,}/.test(text), false, 'schema 里不应出现时间戳');
  assert.equal(/(Date|now\(\)|random)/i.test(text), false);
});

test('装配阶段永不抛错：坏 ctx、坏配置都只降级', () => {
  assert.doesNotThrow(() => apply(undefined, {}));
  assert.doesNotThrow(() => apply({}, 'nonsense'));
  assert.doesNotThrow(() => apply({ on: () => { throw new Error('boom'); } }, {}));
  const ctx = createRootContext();
  assert.doesNotThrow(() => apply(ctx, { maxInlineChars: NaN, facadeName: 42 }));
  const agent = createAgent('bad');
  agent.ctx.tools = undefined;
  assert.doesNotThrow(() => ctx.listeners.find((i) => i.event === 'agent/created').handler({ agent }));
  assert.doesNotThrow(() => ctx.listeners.find((i) => i.event === 'agent/created').handler({ agent: null }));
  assert.doesNotThrow(() => ctx.listeners.find((i) => i.event === 'agent/created').handler(undefined));
});

test('系统提示段：静态、逐字节确定，且只注册一次', () => {
  const a = createRootContext();
  const b = createRootContext();
  apply(a, {});
  apply(b, {});
  assert.equal(a.sections.length, 2, '应注册两段：写入成本 + 课件版式');
  assert.equal(b.sections.length, 2);
  const wa = a.sections.find((s) => s.name === SECTION_NAME);
  const wb = b.sections.find((s) => s.name === SECTION_NAME);
  // 逐字节相同 → 前缀复用成立。
  assert.deepEqual(wa, wb);
  assert.equal(typeof wa.order, 'number');
  assert.equal(Number.isFinite(wa.order), true);
  assert.equal(wa.text, SECTION_TEXT);
  const pa = a.sections.find((s) => s.name === PPT_SECTION_NAME);
  assert.ok(pa, '课件版式段必须注册');
  assert.equal(pa.text, PPT_SECTION_TEXT);
  assert.equal(Number.isFinite(pa.order), true);
  assert.notEqual(PPT_SECTION_NAME, SECTION_NAME);
  // 稳定：不含时间戳、随机、计数这类会让前缀每轮变化的东西。
  for (const text of [SECTION_TEXT, PPT_SECTION_TEXT]) {
    assert.equal(/\d{6,}|Date|now\(|random|Math\./i.test(text), false);
  }
});

test('系统提示段：可以一键关掉', () => {
  const ctx = createRootContext();
  apply(ctx, { writeCostHint: false, pptLayoutHint: false });
  assert.equal(ctx.sections.length, 0);
  // 只关一个时，另一个不受影响。
  const only = createRootContext();
  apply(only, { writeCostHint: false });
  assert.equal(only.sections.some((s) => s.name === SECTION_NAME), false);
  assert.equal(only.sections.some((s) => s.name === PPT_SECTION_NAME), true);
});

test('大文件写入提示：systemPrompt 不可用或抛错时只降级，不影响宿主', () => {
  const noPrompt = createRootContext();
  delete noPrompt.systemPrompt;
  assert.doesNotThrow(() => apply(noPrompt, {}));
  // 连 `get` 都没有的上下文（例如早期宿主）也必须只是降级。
  const noGet = createRootContext();
  delete noGet.get;
  delete noGet.systemPrompt;
  assert.doesNotThrow(() => apply(noGet, {}));

  const broken = createRootContext();
  broken.systemPrompt = { section: () => { throw new Error('layer frozen'); } };
  assert.doesNotThrow(() => apply(broken, {}));
  assert.equal(broken.logs.some((line) => /write-cost hint failed/.test(line)), true);
});

test('晚注册竞态：univer 工具比插件晚出现时，靠 tools/change 补做收窄', () => {
  // 复现真实故障：本插件 inject ['agents'] 先就绪，而 dsh-univer-office 的工具插件
  // 要等网关服务，于是首次尝试时一个 univer_* 都看不到。
  const ctx = createRootContext();
  apply(ctx, {});
  const agent = createAgent('late');
  const tools = createTools([]);          // 此刻还没有任何 univer 工具
  agent.ctx.tools = tools;
  ctx.listeners.find((i) => i.event === 'agent/created').handler({ agent });

  assert.equal(tools.registered.length, 0, '看不到 univer 工具时不应注册门面（白占 schema）');
  assert.equal(tools.restrictions.length, 0);

  // 稍后 univer 工具才注册进来 → 广播 tools/change
  for (const name of ['univer_status', 'univer_execute']) tools.map.set(name, { name, execute: async () => ({ parts: [] }) });
  ctx.listeners.find((i) => i.event === 'tools/change').handler();

  assert.deepEqual(tools.registered, ['univer'], '补做收窄时必须注册门面');
  assert.equal(tools.restrictions.length, 1, '补做收窄时必须打上 restrict');
  assert.deepEqual(tools.restrictions[0].deny, ['univer_execute', 'univer_status']);
  // 再广播一次不能重复安装。
  ctx.listeners.find((i) => i.event === 'tools/change').handler();
  assert.deepEqual(tools.registered, ['univer'], '幂等：不得二次注册');
  assert.equal(tools.restrictions.length, 1);
});
