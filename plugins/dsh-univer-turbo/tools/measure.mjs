/**
 * 度量脚本：把本插件的省量算成**可复核的数字**，而不是形容词。
 *
 * 它做两件事：
 *   1. 从已安装的 `dsh-univer-office` 里抽出 14 个工具的真实定义，用真实运行时的
 *      `parameterSchemaSpecToJsonSchema` 编译成**模型实际看到的样子**，量出字符数；
 *   2. 量出门面工具（描述 + JSON Schema）的字符数，给出「每个请求省多少」。
 *
 * 为什么用字符而不是「token」做主口径：token 数依赖具体 tokenizer，而字符数是
 * 逐字节可复核的。脚本同时给出两种换算（DSH 官方口径 /4、实测口径 /3.6）。
 *
 * 用法：
 *   node tools/measure.mjs [dsh-univer-office/lib/index.js 路径]
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { facadeDescription, facadeParameters } from '../lib/ops.js';

const WORKSPACE = new URL('../../', import.meta.url).pathname;
const BUNDLE = process.argv[2]
  ?? path.join(process.env.DSH_PROFILE_DIR ?? '/Users/yangletian/.dsh/profiles/desktop', 'node_modules', 'dsh-univer-office', 'lib', 'index.js');
const RUNTIME = process.env.DSH_RUNTIME_DIR ?? path.join(WORKSPACE, '.uopt-probe', 'real', 'dsh', 'node_modules');

/** 从源码里取出一个平衡的 `{...}` 块。 */
function blockAt(source, start) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('unbalanced block');
}

/** 真实 DSL → JSON Schema 编译器（拿不到运行时时退回恒等转换，并在输出里说明）。 */
async function loadCompiler() {
  try {
    const module = await import(pathToFileURL(path.join(RUNTIME, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href);
    if (typeof module.parameterSchemaSpecToJsonSchema === 'function') return { compile: module.parameterSchemaSpecToJsonSchema, exact: true };
  } catch {
    // 忽略：下面退回近似口径。
  }
  return { compile: (spec) => spec, exact: false };
}

/** 抽出全部 univer 工具的真实定义。 */
function extractTools(source) {
  const out = [];
  const pattern = /name: "(univer_[a-z_]+)"/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const [, name] = match;
    const at = match.index;
    const description = source.slice(at, at + 4000).match(/description: "((?:[^"\\]|\\.)*)"/);
    const paramsAt = source.indexOf('parameters: {', at);
    let parameters = {};
    if (paramsAt > 0 && paramsAt < at + 3000) {
      parameters = new Function(`return (${blockAt(source, paramsAt + 'parameters: '.length)})`)();
    }
    out.push({ name, description: description ? JSON.parse(`"${description[1]}"`) : '', parameters });
  }
  return out;
}

const { compile, exact } = await loadCompiler();
if (!fs.existsSync(BUNDLE)) {
  console.error(`找不到 dsh-univer-office：${BUNDLE}\n可用参数或 DSH_PROFILE_DIR 指定。`);
  process.exit(1);
}
const tools = extractTools(fs.readFileSync(BUNDLE, 'utf8'));

const rows = tools.map((tool) => {
  const schema = { name: tool.name, description: tool.description, parameters: compile(tool.parameters) };
  const chars = JSON.stringify(schema).length;
  return { name: tool.name, props: Object.keys(tool.parameters).length, chars };
});
rows.sort((a, b) => b.chars - a.chars);

const originalChars = rows.reduce((sum, row) => sum + row.chars, 0);
const facadeChars = JSON.stringify({ name: 'univer', description: facadeDescription({ budget: 8, memo: true }), parameters: facadeParameters() }).length;
const saved = originalChars - facadeChars;
const perRequest = (chars) => ({ official: Math.ceil(chars / 4), measured: Math.round(chars / 3.6) });

console.log(`口径：${exact ? '真实 parameterSchemaSpecToJsonSchema（模型实际看到的形状）' : '近似（未找到真实运行时，按原始 spec 计）'}`);
console.log('');
console.log('原 14 个 univer 工具的模型可见定义：');
console.log('  tool'.padEnd(24) + 'props'.padStart(6) + 'chars'.padStart(8) + '~tok(/4)'.padStart(10));
for (const row of rows) {
  console.log(`  ${row.name.padEnd(22)}${String(row.props).padStart(6)}${String(row.chars).padStart(8)}${String(perRequest(row.chars).official).padStart(10)}`);
}
console.log('');
console.log(`  合计              ${String(rows.length).padStart(4)} 个工具  ${originalChars} 字符  ≈ ${perRequest(originalChars).official} token（官方口径） / ${perRequest(originalChars).measured} token（实测口径）`);
console.log('');
console.log('本插件收窄后的工具面：');
console.log(`  univer（门面 + 描述）  ${facadeChars} 字符  ≈ ${perRequest(facadeChars).official} token（官方口径） / ${perRequest(facadeChars).measured} token（实测口径）`);
console.log('');
console.log('每个请求净省：');
console.log(`  ${saved} 字符  ≈ ${perRequest(saved).official} token（官方口径） / ${perRequest(saved).measured} token（实测口径）  降幅 ${(100 * saved / originalChars).toFixed(1)}%`);
console.log(`  以实测的平均请求长度 93,034 token 计，工具面从 ${(100 * perRequest(originalChars).measured / 93034).toFixed(2)}% 降到 ${(100 * perRequest(facadeChars).measured / 93034).toFixed(2)}%`);
