/**
 * 加载器保真测试：**按宿主真实的挂载方式**装载插件。
 *
 * ## 为什么单开一个文件
 *
 * 其余集成测试都是 `apply(root, config)`——把**根上下文**直接交给 `apply`。
 * 但宿主不是这么做的：它走 `ctx.plugin(module, config)`，Cordis 会为插件建一个
 * **fiber**，并把 fiber 的 ctx 交给 `apply`。这两者在 Cordis 里语义不同：
 *
 * - 根上下文：访问任何服务都不会抛错；
 * - fiber 上下文：**访问未 `inject` 的服务直接抛错**
 *   ——`cannot get property "X" without inject`。
 *
 * 这个差别造成过一次真实的静默故障：`lib/advice.js` 曾经在 try 之外访问
 * `ctx.systemPrompt`（插件只 inject 了 `agents`），异常冒到 `apply` 的兜底 catch，
 * **整个 install 被中止**——连 agent 接线都没跑到，插件在宿主里表现为"装死"，
 * 而所有直接调用 `apply(root, …)` 的测试全部照常通过。
 *
 * 所以这一组测试的意义不是"再测一遍功能"，而是**用真实的装载路径再测一遍**。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { installWriteCostHint, SECTION_TEXT } from '../lib/advice.js';

const WORKSPACE = new URL('../../', import.meta.url).pathname;
const RUNTIME = process.env.DSH_RUNTIME_DIR
  ?? join(WORKSPACE, '.uopt-probe', 'real', 'dsh', 'node_modules');
const AVAILABLE = existsSync(join(RUNTIME, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'));
const SKIP = AVAILABLE ? false : '真实运行时不存在；先运行 node tools/extract-runtime.mjs';

/** 按绝对路径加载真实包。 */
async function loadRuntime() {
  const cordis = await import(pathToFileURL(join(RUNTIME, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href);
  const tools = await import(pathToFileURL(join(RUNTIME, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href);
  const prompt = await import(pathToFileURL(join(RUNTIME, '@deepseek-ai', 'dsh-system-prompt', 'lib', 'index.js')).href);
  const scope = await import(pathToFileURL(join(RUNTIME, '@deepseek-ai', 'dsh-scope', 'lib', 'index.js')).href);
  return { cordis, tools, prompt, scope };
}

/** 最小的 agents 服务。 */
function agentsService(cordis, entries) {
  return class Agents extends cordis.Service {
    constructor(ctx) {
      super(ctx, 'agents');
      this.list = () => entries;
    }
  };
}

/** 一个能通过 restrict 校验的假 univer 工具。 */
function univerTool(name) {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
    async execute() { return { parts: [] }; },
  };
}

test('加载器保真：installWriteCostHint 在未注入 systemPrompt 的 fiber 上绝不抛错', { skip: SKIP }, async () => {
  const { cordis } = await loadRuntime();
  const root = new cordis.Context();
  const seen = [];
  // 一个只有 agents 的宿主：没有 systemPrompt。
  await root.plugin(agentsService(cordis, []));

  let installed;
  const probe = (ctx) => {
    // 关键：这里拿到的是 **fiber ctx**。直接写 `ctx.systemPrompt` 会抛
    // `cannot get property "systemPrompt" without inject`。
    installed = installWriteCostHint(ctx, (message) => seen.push(message));
    // 顺带证明这个环境确实会抛——否则本测试是空的。
    try {
      void ctx.systemPrompt;
      seen.push('PROPERTY-ACCESS-DID-NOT-THROW');
    } catch (error) {
      seen.push(`PROPERTY-ACCESS-THREW:${error.message}`);
    }
  };
  probe.inject = ['agents'];
  await root.plugin(probe);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(installed, false, '拿不到 systemPrompt 时应返回 false，而不是抛错');
  assert.equal(
    seen.some((line) => typeof line === 'string' && line.startsWith('PROPERTY-ACCESS-THREW')),
    true,
    '前提校验：这个环境里属性访问确实会抛错，本测试才有意义',
  );
  await root.fiber.dispose();
});

test('加载器保真：按 ctx.plugin(module) 装载后，收窄与提示段都真的生效', { skip: SKIP }, async () => {
  const { cordis, tools: toolsPkg, prompt, scope } = await loadRuntime();
  const root = new cordis.Context();
  await root.plugin(prompt.default);
  await root.plugin(toolsPkg.default, { mode: 'native' });

  // univer 工具先注册好（模拟 "dsh-univer-office 已就绪"）。
  const names = ['univer_status', 'univer_inspect', 'univer_execute'];
  const univer = (ctx) => { for (const name of names) ctx.tools.register(univerTool(name)); };
  univer.inject = ['tools'];
  await root.plugin(univer);

  // 真实装载路径：把**模块**交给 Cordis，而不是直接调 apply(root, …)。
  const entries = [];
  const agent = { id: 'loader-fidelity' };
  agent.ctx = scope.createScope(root, agent).ctx;
  entries.push(agent);
  await root.plugin(agentsService(cordis, entries));

  const module = await import('../lib/index.js');
  await root.plugin(module, {});
  root.emit('agent/created', { agent });
  await new Promise((resolve) => setTimeout(resolve, 80));

  // ① 收窄生效
  const visible = root.tools.schemas(agent).map((schema) => schema.name);
  assert.deepEqual(visible, ['univer'], `门面必须补上、原工具必须隐藏，实际 ${visible}`);

  // ② 写入成本提示真的进了系统提示
  const assembled = await root.systemPrompt.assemble({});
  assert.equal(assembled.sections.some((section) => section.text === SECTION_TEXT), true, '提示段没进系统提示');

  // ③ 兜底压缩监听器也挂上了（能改写 univer 结果）
  const huge = JSON.stringify({ ok: true, rows: Array.from({ length: 400 }, (_, i) => ({ i, pad: 'z'.repeat(60) })) });
  const decision = await root.events.waterfall(
    agent,
    'tools/post-execute',
    { name: 'univer_inspect', arguments: {} },
    { isError: false, content: [{ type: 'text', text: huge }] },
    async () => ({ kind: 'accept' }),
  );
  assert.ok(decision.content[0].text.length < huge.length / 3, '兜底压缩没有生效');
  await root.fiber.dispose();
});

test('加载器保真：缺少 systemPrompt 的宿主里，主体功能仍然完整（提示段单独降级）', { skip: SKIP }, async () => {
  const { cordis, tools: toolsPkg, scope } = await loadRuntime();
  const root = new cordis.Context();
  // 只装 ToolRuntime 需要的东西会缺 systemPrompt —— 所以直接手搓一个 tools 服务，
  // 复现"宿主没有 systemPrompt"的极端环境。
  const tools = new Map();
  class Tools extends cordis.Service {
    constructor(ctx) {
      super(ctx, 'tools');
      this.register = (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name); };
      this.get = (name) => tools.get(name);
      this.view = () => ({ visible: tools, knownNames: new Set(tools.keys()), restrictableNames: new Set(tools.keys()) });
      this.restrict = (filter) => { this.lastFilter = filter; return () => {}; };
    }
  }
  await root.plugin(Tools);
  for (const name of ['univer_status', 'univer_execute']) tools.set(name, univerTool(name));

  const entries = [];
  const agent = { id: 'no-prompt' };
  agent.ctx = scope.createScope(root, agent).ctx;
  entries.push(agent);
  await root.plugin(agentsService(cordis, entries));

  const module = await import('../lib/index.js');
  // 关键：这里绝不能因为拿不到 systemPrompt 就整个中止。
  await root.plugin(module, {});
  root.emit('agent/created', { agent });
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(tools.has('univer'), true, '没有 systemPrompt 也必須完成收窄（门面已注册）');
  const service = root.get('tools');
  assert.deepEqual(service.lastFilter?.deny, ['univer_execute', 'univer_status'], '原工具必须被 deny');
  await root.fiber.dispose();
});
