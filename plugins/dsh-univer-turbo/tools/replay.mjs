/**
 * 回放测量：把**真实会话日志里的 univer 工具结果**重新过一遍本插件的压缩器，
 * 把「省了多少」从推算变成实测。
 *
 * 为什么必须这么做：工具面的省量是纯算术（schema 就那么大，删掉就是删掉），
 * 但结果侧的省量取决于**真实载荷长什么样**——只有拿真数据回放才不是自说自话。
 *
 * 口径说明（避免误读）：
 * - 字符数是**实测**的；token 用固定换算（默认 /3.6，与既有会话分析一致）。
 * - 「携带成本」= 该结果在它之后每一次请求里都会被重发一次，所以乘数 =
 *   该结果 seq 之后的 assistant/message 条数。这是本仓库会话分析用的同一套模型。
 * - 图片只报**张数与字节数**，不假装算 token：图片 token 是服务商按像素折算的，
 *   日志里只有附件描述符（base64 不在日志里）。
 *
 * 用法：
 *   node tools/replay.mjs [语料目录] [--json]
 * 语料目录是一个装满 `*.jsonl` 的文件夹（会话日志解压后的逐行 JSON）。
 * 没有语料时给出去哪里取的办法，并以退出码 0 结束（不阻塞 CI）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { compactContent, stripEchoText } from '../lib/compact.js';
import { normalizeConfig } from '../lib/config.js';
import { OPS } from '../lib/ops.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dir = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(
  new URL('../../', import.meta.url).pathname, '.uopt-probe', 'usage', 'jsonl',
));

/** 工具名 → 门面 op（回放时要用它查按 op 的预算）。 */
const OP_OF_TOOL = new Map(Object.entries(OPS).map(([op, spec]) => [spec.tool, op]));

if (!fs.existsSync(dir)) {
  console.error(`找不到语料目录：${dir}`);
  console.error('会话日志在 ~/.dsh/sessions/<workspace-slug>/<sessionId>/session.v4.jsonl.zstd（多帧 zstd，');
  console.error('需按魔数 28 B5 2F FD 逐帧解压成 .jsonl 后再指到这里）。');
  process.exit(0);
}

const config = normalizeConfig({
  maxInlineChars: 1400,
  opBudgets: { svg: 480, lint: 900, screenshot: 800 },
});

/** 每场会话：收集调用与结果，并数出每次请求的位置。 */
function scan(file) {
  const calls = new Map();
  const results = [];
  const requestSeqs = [];
  let promptTokens = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const type = event.type;
    const data = event.data ?? {};
    if (type === 'assistant/message') {
      requestSeqs.push(event.seq ?? 0);
      // 有效 prompt = 新输入 + 缓存读（与既有会话分析同一口径）。
      const usage = data.usage ?? {};
      promptTokens += Number(usage.inputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0);
      continue;
    }
    if (type === 'tool/call') {
      const call = data.call ?? data;
      calls.set(call.callId, call);
      continue;
    }
    if (type === 'tool/result') {
      const message = data.message ?? data;
      results.push({ seq: event.seq ?? 0, message });
    }
  }
  return { calls, results, requestSeqs, promptTokens };
}

const rows = [];
let sessions = 0;
let totalPrompt = 0;
let imagesSeen = 0;
let imagesWithheld = 0;
let imageBytes = 0;

for (const name of fs.readdirSync(dir)) {
  if (!name.endsWith('.jsonl')) continue;
  const { calls, results, requestSeqs, promptTokens } = scan(path.join(dir, name));
  const univerResults = results.filter((entry) => {
    const call = calls.get(entry.message.toolCallId);
    return call !== undefined && String(call.name).startsWith('univer');
  });
  if (univerResults.length === 0) continue;
  sessions += 1;
  totalPrompt += promptTokens;
  let deliveredImages = 0;

  for (const entry of univerResults) {
    const call = calls.get(entry.message.toolCallId);
    const tool = String(call.name);
    const op = OP_OF_TOOL.get(tool);
    let parsedArgs = {};
    try {
      parsedArgs = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : (call.arguments ?? {});
    } catch {
      parsedArgs = {};
    }
    const content = Array.isArray(entry.message.content) ? entry.message.content : [];
    const isError = entry.message.isError === true;

    // 失败结果本插件一个字节都不动。
    const before = content.reduce((sum, block) => sum + (block.type === 'text' ? String(block.text ?? '').length : 0), 0);
    let after = before;
    let steps = [];
    if (!isError && op !== undefined) {
      const stripped = content.map((block) => {
        if (block.type !== 'text' || typeof block.text !== 'string') return block;
        const r = stripEchoText(block.text, parsedArgs);
        return r.changed ? { ...block, text: r.text } : block;
      });
      const budget = config.opBudgets[op] ?? config.maxInlineChars;
      const compacted = compactContent(stripped, { budget, maxArrayItems: config.maxArrayItems, maxStringChars: config.maxStringChars, maxDepth: config.maxDepth });
      after = compacted.after;
      steps = compacted.steps;
    }

    // 图片：只数张数与字节，并按预算模拟「会被扣下多少张」（强制放过的不算）。
    for (const block of content) {
      if (block.type !== 'image') continue;
      imagesSeen += 1;
      imageBytes += Number(block.attachment?.bytes ?? 0);
      if (deliveredImages < config.screenshotBudget) {
        deliveredImages += 1;
      } else {
        imagesWithheld += 1;
      }
    }

    // 携带乘数：该结果之后还有多少次请求会重发它。
    const carry = requestSeqs.filter((seq) => seq > entry.seq).length;
    rows.push({ tool, op, before, after, carry, isError, steps });
  }
}

if (rows.length === 0) {
  console.error(`在 ${dir} 里没找到任何 univer 工具结果。`);
  process.exit(0);
}

const CHARS_PER_TOKEN = 3.6;
const tok = (chars) => chars / CHARS_PER_TOKEN;
const byTool = new Map();
for (const row of rows) {
  const bucket = byTool.get(row.tool) ?? { calls: 0, before: 0, after: 0, carried: 0, images: 0 };
  bucket.calls += 1;
  bucket.before += row.before;
  bucket.after += row.after;
  bucket.carried += (row.before - row.after) * row.carry;
  byTool.set(row.tool, bucket);
}

const totalBefore = rows.reduce((sum, row) => sum + row.before, 0);
const totalAfter = rows.reduce((sum, row) => sum + row.after, 0);
const totalCarriedSaved = rows.reduce((sum, row) => sum + (row.before - row.after) * row.carry, 0);
const changed = rows.filter((row) => row.after < row.before).length;

if (asJson) {
  console.log(JSON.stringify({
    sessions,
    results: rows.length,
    changed,
    charsBefore: totalBefore,
    charsAfter: totalAfter,
    charsSaved: totalBefore - totalAfter,
    carriedTokensSaved: Math.round(tok(totalCarriedSaved)),
    promptTokens: Math.round(totalPrompt),
    resultSharePct: Number((100 * tok(totalCarriedSaved) / totalPrompt).toFixed(2)),
    imagesSeen,
    imagesWithheld,
    imageBytes,
    perTool: [...byTool].map(([tool, b]) => ({ tool, ...b, carriedTokens: Math.round(tok(b.carried)) })),
  }, null, 2));
  process.exit(0);
}

console.log(`回放语料：${dir}`);
console.log(`会话 ${sessions} 场 · univer 结果 ${rows.length} 条 · 其中被改动 ${changed} 条（${(100 * changed / rows.length).toFixed(1)}%）`);
console.log('');
console.log('按工具（字符数为实测）：');
console.log('  ' + 'tool'.padEnd(22) + 'calls'.padStart(6) + 'chars前'.padStart(9) + 'chars后'.padStart(9) + '省%'.padStart(7) + '携带省(tok)'.padStart(13));
for (const [tool, b] of [...byTool].sort((x, y) => y[1].carried - x[1].carried)) {
  const pct = b.before === 0 ? 0 : (100 * (b.before - b.after) / b.before);
  console.log('  ' + tool.padEnd(22) + String(b.calls).padStart(6) + String(b.before).padStart(9) + String(b.after).padStart(9) + pct.toFixed(1).padStart(7) + String(Math.round(tok(b.carried))).padStart(13));
}
console.log('');
console.log(`结果文本合计：${totalBefore} → ${totalAfter} 字符（省 ${totalBefore - totalAfter}，${(100 * (totalBefore - totalAfter) / totalBefore).toFixed(1)}%）`);
console.log(`换算成携带成本：约省 ${Math.round(tok(totalCarriedSaved)).toLocaleString()} token（按每条结果之后剩余的请求次数加权）`);
const carriedTokens = tok(totalCarriedSaved);
console.log(`这些会话的有效 prompt 合计：${Math.round(totalPrompt).toLocaleString()} token`);
console.log(`结果压缩占其中：${(100 * carriedTokens / totalPrompt).toFixed(2)}%`);
console.log(`图片：日志里共 ${imagesSeen} 张 / ${(imageBytes / 1048576).toFixed(1)} MB；按每会话 ${config.screenshotBudget} 张预算，会被扣下 ${imagesWithheld} 张（图片 token 未计入上面的数字）`);
