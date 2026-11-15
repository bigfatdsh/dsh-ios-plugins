/**
 * 从宿主自带的 `app.asar` 里提取真实 DSH 运行时，供集成测试使用。
 *
 * 集成测试需要 `@deepseek-ai/cordis`、`dsh-tools`、`dsh-system-prompt`、`dsh-scope`
 * 这些真实包——只有它们才能证明「restrict + 门面转发 + post-execute 派发」这套接线
 * 在真运行时上成立，而不是在 mock 上成立。
 *
 * 用法：
 *   node tools/extract-runtime.mjs [目标目录]
 * 默认目标：<工作区>/.uopt-probe/real/dsh/node_modules
 *
 * 说明：这里没有用 `@electron/asar`，而是直接解析 asar 容器格式。原因有两个：
 * 一是 profile 侧插件解析不到任何额外依赖；二是顺便把「asar 头部按 **4 字节**对齐」
 * 这个容易写错的细节固定下来（按 16 字节对齐会让每个文件都少掉开头几个字节）。
 */

import fs from 'node:fs';
import path from 'node:path';

const ASAR = process.env.DSH_ASAR
  ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const UNPACKED = `${ASAR}.unpacked`;
const DEFAULT_DEST = path.join(
  new URL('../../', import.meta.url).pathname,
  '.uopt-probe', 'real', 'dsh', 'node_modules',
);
const dest = path.resolve(process.argv[2] ?? DEFAULT_DEST);

if (!fs.existsSync(ASAR)) {
  console.error(`找不到 app.asar：${ASAR}\n可用 DSH_ASAR 环境变量指定路径。`);
  process.exit(1);
}

const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(12);
const headerBuf = Buffer.alloc(headerSize);
fs.readSync(fd, headerBuf, 0, headerSize, 16);
const header = JSON.parse(headerBuf.toString('utf8'));
const baseOffset = 16 + headerSize + ((4 - (headerSize % 4)) % 4);

const entries = [];
(function walk(node, prefix) {
  for (const [key, value] of Object.entries(node.files ?? {})) {
    const target = `${prefix}/${key}`;
    if (value.files) walk(value, target);
    else entries.push({ path: target, offset: Number(value.offset), size: value.size, unpacked: Boolean(value.unpacked), link: value.link });
  }
})(header, '');

let written = 0;
for (const entry of entries) {
  if (!entry.path.startsWith('/dsh/node_modules/')) continue;
  const target = path.join(dest, entry.path.slice('/dsh/node_modules/'.length));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (entry.link !== undefined) {
    try { fs.symlinkSync(entry.link, target); } catch { /* 已存在 */ }
    written += 1;
    continue;
  }
  let buffer;
  if (entry.unpacked) {
    const source = path.join(UNPACKED, entry.path);
    if (!fs.existsSync(source)) continue;
    buffer = fs.readFileSync(source);
  } else {
    buffer = Buffer.alloc(entry.size);
    fs.readSync(fd, buffer, 0, entry.size, baseOffset + entry.offset);
  }
  fs.writeFileSync(target, buffer);
  written += 1;
}

console.log(`已提取 ${written} 个文件 → ${dest}`);
console.log('现在可以运行：node --test "test/*.test.js"');
