/**
 * 集成测试：跑在**真实的** Cordis + 真实 ToolRuntime 上。
 *
 * 单元测试证明「算法对」，这里证明「接线对」——因为这一层最容易出错的地方
 * 恰恰不是算法，而是三件事：
 *   1. `restrict()` 只能点名**全局已注册**的工具，否则直接抛错；
 *   2. 受限之后，门面还能不能从**全局视角**把原定义取回来并调用；
 *   3. `tools/post-execute` 在这条作用域上到底会不会被派发到。
 *
 * 真实运行时来自宿主自带的 app.asar。默认从工作区的 `.uopt-probe/real/dsh/node_modules`
 * 读取；不存在时整组测试**跳过**（而不是失败），保证在别的机器上 `npm test` 依然全绿。
 *
 * 想在这台机器上补齐真实运行时：
 *   node tools/extract-runtime.mjs
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { SECTION_NAME, SECTION_TEXT } from '../lib/advice.js';
import { apply } from '../lib/index.js';

const WORKSPACE = new URL('../../', import.meta.url).pathname;
const RUNTIME = process.env.DSH_RUNTIME_DIR
  ?? join(WORKSPACE, '.uopt-probe', 'real', 'dsh', 'node_modules');
const AVAILABLE = existsSync(join(RUNTIME, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'));
const SKIP = AVAILABLE ? false : '真实运行时不存在；先运行 node tools/extract-runtime.mjs';

/** 按绝对路径加载真实包（包内部的裸导入会从它自己的位置解析，无需 symlink）。 */
async function loadRuntime() {
  const cordis = await import(pathToFileURL(join(RUNTIME, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href);
  const tools = await import(pathToFileURL(join(RUNTIME, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href);
  const prompt = await import(pathToFileURL(join(RUNTIME, '@deepseek-ai', 'dsh-system-prompt', 'lib', 'index.js')).href);
  const scope = await import(pathToFileURL(join(RUNTIME, '@deepseek-ai', 'dsh-scope', 'lib', 'index.js')).href);
  return { cordis, tools, prompt, scope };
}

/**
 * 真实 14 个 univer 工具的**实测模型可见定义字符数**（见 tools/measure.mjs）。
 * 集成测试用它们构造同等体量的假工具，这样「工具面变小了多少」才是可比的真实数字，
 * 而不是被一堆 300 字符的玩具 schema 稀释掉。
 */
const REAL_TOOL_CHARS = Object.freeze({
  univer_status: 495, univer_inspect: 779, univer_execute: 937, univer_lint: 659,
  univer_screenshot: 1800, univer_export: 540, univer_print_pdf: 615, univer_new: 341,
  univer_unit: 770, univer_worktree: 629, univer_import: 917, univer_compile_svg: 796,
  univer_resources: 957, univer_api: 1276,
});
const REAL_TOTAL_CHARS = Object.values(REAL_TOOL_CHARS).reduce((sum, value) => sum + value, 0);

/** 造一个与真实 univer 工具**同等体量**的假工具（描述按实测字符数补齐）。 */
function fakeUniverTool(name, text, extra = {}) {
  const target = REAL_TOOL_CHARS[name] ?? 600;
  const base = {
    name,
    description: '',
    parameters: {
      type: 'object',
      properties: { file: { type: 'string' }, unitId: { type: 'string' }, worktreeId: { type: 'string' }, output: { type: 'string' } },
      required: ['file'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => value.parts,
    },
    async execute() {
      return { parts: [{ type: 'text', text: typeof text === 'function' ? text() : text }, ...(extra.images ?? [])] };
    },
  };
  const head = `Realistic ${name} definition.`;
  base.description = head + ' x'.repeat(Math.max(0, target - JSON.stringify({ ...base, description: head }).length - 1));
  return base;
}

/** 全部 14 个工具名（与真实安装一致）。 */
const ALL_TOOLS = Object.keys(REAL_TOOL_CHARS);

/** 搭起「真实运行时 + 假 univer 插件 + 本插件」的完整场景。 */
async function scenario(pluginConfig = {}) {
  const { cordis, tools: toolsPkg, prompt, scope } = await loadRuntime();
  const root = new cordis.Context();
  await root.plugin(prompt.default);
  await root.plugin(toolsPkg.default, { mode: 'native' });

  const univerPlugin = (ctx) => {
    for (const name of ALL_TOOLS) {
      ctx.tools.register(fakeUniverTool(name, name === 'univer_inspect'
        ? JSON.stringify({ ok: true, rows: Array.from({ length: 200 }, (_, i) => ({ i, pad: 'p'.repeat(60), empty: [] })) })
        : `result of ${name}`));
    }
  };
  univerPlugin.inject = ['tools'];
  await root.plugin(univerPlugin);

  const globalNames = [...root.tools.view(undefined).visible.keys()];
  const beforeChars = JSON.stringify(root.tools.schemas(undefined)).length;

  // 模拟宿主：建一个 agent 作用域，把 {id, ctx} 交给插件。
  const agent = { id: 'session-integration' };
  const created = scope.createScope(root, agent);
  agent.ctx = created.ctx;

  apply(root, pluginConfig);
  root.emit('agent/created', { agent });
  // `inject(['tools'], …)` 是异步的：给它一拍。
  await new Promise((resolve) => setTimeout(resolve, 80));

  const key = agent;
  const afterSchemas = root.tools.schemas(key);
  const facade = root.tools.get('univer', key);
  return { root, agent, key, globalNames, beforeChars, afterSchemas, facade, toolsPkg };
}

test('集成：14 个 univer 工具被收窄成一个门面，且原工具对模型不可见', { skip: SKIP }, async () => {
  const { root, key, globalNames, beforeChars, afterSchemas } = await scenario();
  assert.ok(globalNames.includes('univer_status'), '前置条件：univer 工具确实注册在全局层');
  const names = afterSchemas.map((schema) => schema.name);
  assert.deepEqual(names.filter((name) => name.startsWith('univer')), ['univer'], `agent 只应看到门面，实际看到 ${names}`);
  const afterChars = JSON.stringify(afterSchemas).length;
  assert.ok(beforeChars >= REAL_TOTAL_CHARS * 0.8, `前置条件：原工具面应接近实测的 ${REAL_TOTAL_CHARS} 字符，实际 ${beforeChars}`);
  assert.ok(afterChars < beforeChars, `工具面必须变小：${beforeChars} -> ${afterChars}`);
  // 真实账：原 14 个工具 11,511 字符 → 门面约 2,700 字符。
  assert.ok(afterChars < REAL_TOTAL_CHARS / 3, `收敛幅度不足：${REAL_TOTAL_CHARS} -> ${afterChars}`);
  // 原工具对模型不可见，但全局层仍然完好（门面要靠它转发）。
  assert.equal(root.tools.get('univer_status', key), undefined, '受限工具在该作用域读作不存在');
  assert.notEqual(root.tools.get('univer_status'), undefined, '全局定义必须仍然存在');
  await root.fiber.dispose();
});

test('集成：门面通过全局视角把受限的原工具调起来', { skip: SKIP }, async () => {
  const { root, key, facade } = await scenario();
  assert.equal(typeof facade?.execute, 'function', '门面必须可执行');
  const value = await facade.execute({ op: 'status', file: 'a.univer' }, {});
  assert.match(value.parts[0].text, /result of univer_status/);
  await root.fiber.dispose();
});

test('集成：门面结果在进入对话之前就被压进预算', { skip: SKIP }, async () => {
  const { root, key, facade } = await scenario({ maxInlineChars: 900 });
  const value = await facade.execute({ op: 'inspect', file: 'a.univer', unitId: 'u1' }, {});
  const text = value.parts[0].text;
  assert.ok(text.length < 900, `结果应落在预算内，实际 ${text.length}`);
  assert.doesNotThrow(() => JSON.parse(text), '压缩后必须仍是合法 JSON');
  await root.fiber.dispose();
});

test('集成：tools/post-execute 在 agent 作用域被真实派发并改写内容', { skip: SKIP }, async () => {
  const { root, key, toolsPkg } = await scenario({ maxInlineChars: 500 });
  const huge = JSON.stringify({ ok: true, rows: Array.from({ length: 300 }, (_, i) => ({ i, pad: 'z'.repeat(60) })) });
  const result = { isError: false, content: [{ type: 'text', text: huge }] };
  const decision = await root.events.waterfall(
    key,
    'tools/post-execute',
    { name: 'univer_inspect', arguments: {} },
    result,
    async () => ({ kind: 'accept' }),
  );
  assert.equal(decision.kind, 'accept');
  assert.ok(decision.content[0].text.length < huge.length / 3, '兜底压缩必须生效');
  // 失败结果必须逐字节原样放行。
  const failed = { isError: true, content: [{ type: 'text', text: huge }] };
  const failedDecision = await root.events.waterfall(
    key, 'tools/post-execute', { name: 'univer_inspect', arguments: {} }, failed, async () => ({ kind: 'accept' }),
  );
  assert.deepEqual(failedDecision, { kind: 'accept' }, '失败结果不得被改写');
  await root.fiber.dispose();
});

test('集成：关闭 collapseTools 时不注册门面，只保留兜底压缩', { skip: SKIP }, async () => {
  const { root, key, afterSchemas } = await scenario({ collapseTools: false });
  const names = afterSchemas.map((schema) => schema.name);
  assert.equal(names.includes('univer'), false, '不收敛时不应多占一份 schema');
  assert.ok(names.includes('univer_status'), '原工具应保持可见');
  await root.fiber.dispose();
});

test('集成：没有 univer 工具时插件安静退场，不抛错也不注册门面', { skip: SKIP }, async () => {
  const { cordis, tools: toolsPkg, prompt, scope } = await loadRuntime();
  const root = new cordis.Context();
  await root.plugin(prompt.default);
  await root.plugin(toolsPkg.default, { mode: 'native' });
  const agent = { id: 'empty' };
  const created = scope.createScope(root, agent);
  agent.ctx = created.ctx;
  apply(root, {});
  root.emit('agent/created', { agent });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(root.tools.schemas(agent).map((s) => s.name), []);
  await root.fiber.dispose();
});

test('集成：写入成本提示真的进了真实 SystemPrompt 的组装结果', { skip: SKIP }, async () => {
  const { cordis, prompt } = await loadRuntime();
  const root = new cordis.Context();
  await root.plugin(prompt.default);
  apply(root, {});
  // 真实契约：assemble() 返回的是结构化结果，不是字符串。
  const assembled = await root.systemPrompt.assemble({});
  const mine = assembled.sections.find((section) => section.name === SECTION_NAME);
  assert.notEqual(mine, undefined, '提示段没有进入真实组装结果');
  assert.equal(mine.text, SECTION_TEXT, '文本必须逐字节一致');
  // 再组装一次必须逐字节相同（前缀缓存要求）。
  const again = await root.systemPrompt.assemble({});
  assert.equal(JSON.stringify(again), JSON.stringify(assembled), '两次组装必须逐字节一致');
  // 它必须排在工具说明之后（order 足够大）。
  const names = assembled.sections.map((section) => section.name);
  assert.ok(names.indexOf(SECTION_NAME) > 0);
  // 关掉之后必须彻底消失。
  const off = new cordis.Context();
  await off.plugin(prompt.default);
  apply(off, { writeCostHint: false });
  const without = await off.systemPrompt.assemble({});
  assert.equal(without.sections.some((section) => section.name === SECTION_NAME), false);
  await root.fiber.dispose();
  await off.fiber.dispose();
});

test('集成（竞态回归）：univer 工具晚于本插件注册时，tools/change 能补做收窄', { skip: SKIP }, async () => {
  const { cordis, tools: toolsPkg, prompt, scope } = await loadRuntime();
  const root = new cordis.Context();
  await root.plugin(prompt.default);
  await root.plugin(toolsPkg.default, { mode: 'native' });

  // ① 先建 agent 并装插件——此刻一个 univer 工具都还没有（复现真实竞态：
  //    本插件 inject ['agents'] 先就绪，而 univer-office 的工具要等网关服务）。
  const agent = { id: 'late-registration' };
  const created = scope.createScope(root, agent);
  agent.ctx = created.ctx;
  apply(root, {});
  root.emit('agent/created', { agent });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(root.tools.schemas(agent).map((s) => s.name), [], '此刻还没有任何工具');
  assert.equal(root.tools.get('univer', agent), undefined, '看不到 univer 工具时不该注册门面');

  // ② univer 工具这才注册进来。
  const late = (ctx) => {
    for (const name of ALL_TOOLS) ctx.tools.register(fakeUniverTool(name, `result of ${name}`));
  };
  late.inject = ['tools'];
  await root.plugin(late);
  await new Promise((resolve) => setTimeout(resolve, 60));

  // ③ 真实 ToolRuntime 必须在注册表变化时广播 tools/change，把门面补上。
  const names = root.tools.schemas(agent).map((s) => s.name).filter((n) => n.startsWith('univer'));
  assert.deepEqual(names, ['univer'], `工具晚注册后必须补做收窄，实际可见 ${names}`);
  assert.equal(root.tools.get('univer_status', agent), undefined, '原工具必须被隐藏');
  assert.notEqual(root.tools.get('univer_status'), undefined, '全局定义仍在');
  await root.fiber.dispose();
});
