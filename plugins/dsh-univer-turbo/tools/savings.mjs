/**
 * 节省率 / 提速率 统一度量。
 *
 * 全部数字来自**真实会话日志**，不是推算：
 * - token 侧：把每一条 univer 结果真的过一遍压缩器，再按「这条结果之后还剩多少次请求」
 *   加权（携带成本模型），与既有会话分析同一口径；
 * - 时间侧：直接从日志的 `tool/call → tool/result` 时间戳量出每次调用的真实耗时，
 *   再乘上本插件能确凿消除的那部分调用。
 *
 * 口径纪律（避免自欺）：
 * 1. 只统计**机制确定能省**的部分；
 * 2. 依赖模型配合的（batch、one-shot 引导、截图预算被 force 绕过）**不计入**，
 *    单独列在最后；
 * 3. 图片只报张数，不假装算 token——日志里只有附件描述符，没有 base64。
 *
 * 用法：node tools/savings.mjs [语料目录] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';

import { compactContent, stripEchoText } from '../lib/compact.js';
import { normalizeConfig } from '../lib/config.js';
import { OPS } from '../lib/ops.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const dir = path.resolve(argv.find((a) => !a.startsWith('--')) ?? path.join(
  new URL('../../', import.meta.url).pathname, '.uopt-probe', 'usage', 'jsonl',
));

const OP_OF_TOOL = new Map(Object.entries(OPS).map(([op, spec]) => [spec.tool, op]));
/** 会作废整张编译缓存的写操作（与 facade.js 的失效规则保持一致）。 */
const HARD_WRITES = new Set(['univer_execute', 'univer_new', 'univer_unit', 'univer_worktree', 'univer_import']);
const CHARS_PER_TOKEN = 3.6;

const config = normalizeConfig({
  maxInlineChars: 1400,
  opBudgets: { svg: 480, lint: 900, screenshot: 800 },
});

if (!fs.existsSync(dir)) {
  console.error(`找不到语料目录：${dir}`);
  process.exit(0);
}

/** 解析一场会话：调用、结果、请求位置，全部按 seq 排序。 */
function scan(file) {
  const calls = new Map();
  const timeline = [];
  let promptTokens = 0;
  let requests = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const data = event.data ?? {};
    if (event.type === 'assistant/message') {
      requests += 1;
      const usage = data.usage ?? {};
      promptTokens += Number(usage.inputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0);
      timeline.push({ kind: 'request', seq: event.seq ?? 0 });
      continue;
    }
    if (event.type === 'tool/call') {
      const call = data.call ?? data;
      calls.set(call.callId, call);
      timeline.push({ kind: 'call', seq: event.seq ?? 0, time: event.time, callId: call.callId, name: String(call.name ?? '') });
      continue;
    }
    if (event.type === 'tool/result') {
      const message = data.message ?? data;
      timeline.push({ kind: 'result', seq: event.seq ?? 0, time: event.time, callId: message.toolCallId, message });
    }
  }
  timeline.sort((a, b) => a.seq - b.seq);
  const times = timeline.map((e) => Number(e.time)).filter((t) => Number.isFinite(t) && t > 0);
  const wallSeconds = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 1000 : 0;
  return { calls, timeline, requests, promptTokens, wallSeconds };
}

const perSession = [];
const stats = {
  sessions: 0,
  requests: 0,
  promptTokens: 0,
  univerCalls: 0,
  univerResults: 0,
  // token 侧
  surfaceCharsSaved: 0,
  resultCharsBefore: 0,
  resultCharsAfter: 0,
  carriedTokensSaved: 0,
  // 时间侧
  toolSeconds: 0,
  univerSeconds: 0,
  renderSeconds: 0,
  savedSecondsCompile: 0,
  savedSecondsFailure: 0,
  savedSecondsChunk: 0,
  redundantCompiles: 0,
  repeatedFailures: 0,
  overLimitScreenshots: 0,
  // 图片
  imagesSeen: 0,
  imagesWithheld: 0,
  wallSeconds: 0,
};

/** 门面工具的模型可见定义字符数（实测值，由 tools/measure.mjs 复核）。 */
const FACADE_CHARS = 3130;
const ORIGINAL_TOOL_CHARS = 11511;

for (const name of fs.readdirSync(dir)) {
  if (!name.endsWith('.jsonl')) continue;
  const { calls, timeline, requests, promptTokens, wallSeconds } = scan(path.join(dir, name));
  const univerCalls = timeline.filter((e) => e.kind === 'call' && e.name.startsWith('univer'));
  if (univerCalls.length === 0) continue;

  stats.sessions += 1;
  const session = {
    id: name.replace(/^.*___/, '').replace(/\.jsonl$/, ''),
    requests, promptTokens, wallSeconds,
    surfaceTokens: (ORIGINAL_TOOL_CHARS - FACADE_CHARS) * requests / CHARS_PER_TOKEN,
    carried: 0,
    savedSeconds: 0,
    redundantCompiles: 0,
    repeatedFailures: 0,
    overLimit: 0,
  };
  perSession.push(session);
  stats.requests += requests;
  stats.promptTokens += promptTokens;
  stats.wallSeconds += wallSeconds;
  stats.univerCalls += univerCalls.length;
  stats.surfaceCharsSaved += (ORIGINAL_TOOL_CHARS - FACADE_CHARS) * requests;

  // 结果映射 + 每次调用的真实耗时
  const callAt = new Map(univerCalls.map((e) => [e.callId, e]));
  const durations = new Map();
  for (const entry of timeline) {
    if (entry.kind !== 'result') continue;
    const call = callAt.get(entry.callId);
    if (call === undefined) continue;
    const seconds = Math.max(0, (Number(entry.time) - Number(call.time)) / 1000);
    if (Number.isFinite(seconds)) durations.set(entry.callId, seconds);
    stats.univerSeconds += seconds;
    if (/screenshot|compile_svg|lint|print_pdf/.test(call.name)) stats.renderSeconds += seconds;
  }
  for (const entry of timeline) {
    if (entry.kind === 'result') {
      const call = callAt.get(entry.callId);
      if (call !== undefined) stats.toolSeconds += Math.max(0, (Number(entry.time) - Number(call.time)) / 1000);
    }
  }

  // ── token 侧：逐条结果过压缩器 ───────────────────────────────────────────
  let deliveredImages = 0;
  for (const entry of timeline) {
    if (entry.kind !== 'result') continue;
    const owner = callAt.get(entry.callId);
    if (owner === undefined) continue;
    stats.univerResults += 1;
    const call = calls.get(entry.callId);
    const op = OP_OF_TOOL.get(owner.name);
    let args = {};
    try {
      args = typeof call?.arguments === 'string' ? JSON.parse(call.arguments) : (call?.arguments ?? {});
    } catch {
      args = {};
    }
    const content = Array.isArray(entry.message.content) ? entry.message.content : [];
    for (const block of content) {
      if (block.type !== 'image') continue;
      stats.imagesSeen += 1;
      // 按会话的图片预算：每个会话最多投递 screenshotBudget 张。
      if (deliveredImages >= config.screenshotBudget) stats.imagesWithheld += 1;
      else deliveredImages += 1;
    }
    const before = content.reduce((sum, b) => sum + (b.type === 'text' ? String(b.text ?? '').length : 0), 0);
    let after = before;
    if (entry.message.isError !== true && op !== undefined) {
      const stripped = content.map((b) => {
        if (b.type !== 'text' || typeof b.text !== 'string') return b;
        const r = stripEchoText(b.text, args);
        return r.changed ? { ...b, text: r.text } : b;
      });
      const budget = config.opBudgets[op] ?? config.maxInlineChars;
      after = compactContent(stripped, {
        budget,
        maxArrayItems: config.maxArrayItems,
        maxStringChars: config.maxStringChars,
        maxDepth: config.maxDepth,
      }).after;
    }
    stats.resultCharsBefore += before;
    stats.resultCharsAfter += after;
    const carry = timeline.filter((e) => e.kind === 'request' && e.seq > entry.seq).length;
    const carried = (before - after) * carry / CHARS_PER_TOKEN;
    stats.carriedTokensSaved += carried;
    session.carried += carried;
  }

  // ── 时间侧 ①：重复的 compile_svg 会被按页缓存挡掉 ─────────────────────────
  const seenCompiles = new Map();  // key -> true
  let svgCacheValid = true;
  for (const entry of timeline) {
    if (entry.kind === 'call') {
      const call = calls.get(entry.callId);
      if (HARD_WRITES.has(entry.name)) svgCacheValid = false;
      if (entry.name !== 'univer_compile_svg') continue;
      let args = {};
      try {
        args = typeof call?.arguments === 'string' ? JSON.parse(call.arguments) : {};
      } catch {
        args = {};
      }
      const key = `${args.unitId ?? '?'}#${args.page ?? '?'}#${args.source ?? '?'}#${args.mode ?? 'replace'}`;
      if (svgCacheValid && seenCompiles.has(key)) {
        stats.redundantCompiles += 1;
        session.redundantCompiles += 1;
        const saved = durations.get(entry.callId) ?? 0;
        stats.savedSecondsCompile += saved;
        session.savedSeconds += saved;
      }
      seenCompiles.set(key, true);
      svgCacheValid = true;   // 编译自己那一页不算「硬写」
    }
  }

  // ── 时间侧 ②：完全相同的失败调用会被记忆化挡掉 ────────────────────────────
  const seenFailures = new Set();
  for (const entry of timeline) {
    if (entry.kind !== 'result') continue;
    if (entry.message.isError !== true) continue;
    const owner = callAt.get(entry.callId);
    if (owner === undefined) continue;
    const call = calls.get(entry.callId);
    const key = `${owner.name}\u0000${typeof call?.arguments === 'string' ? call.arguments : JSON.stringify(call?.arguments ?? {})}`;
    if (seenFailures.has(key)) {
      stats.repeatedFailures += 1;
      session.repeatedFailures += 1;
      const saved = durations.get(entry.callId) ?? 0;
      stats.savedSecondsFailure += saved;
      session.savedSeconds += saved;
    }
    seenFailures.add(key);
  }

  // ── 时间侧 ③：超过附件上限的截图（渲染前分片 + 并发）──────────────────────
  for (const entry of timeline) {
    if (entry.kind !== 'result') continue;
    const text = (entry.message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    if (!/image-count limit|exceeds the configured/i.test(text)) continue;
    stats.overLimitScreenshots += 1;
    session.overLimit += 1;
    const saved = durations.get(entry.callId) ?? 0;
    stats.savedSecondsChunk += saved;
    session.savedSeconds += saved;
  }
}

const tok = (chars) => chars / CHARS_PER_TOKEN;
const surfaceTokens = tok(stats.surfaceCharsSaved);
const totalSaved = surfaceTokens + stats.carriedTokensSaved;
const mechanicalPct = (100 * totalSaved) / stats.promptTokens;
const savedSeconds = stats.savedSecondsCompile + stats.savedSecondsFailure + stats.savedSecondsChunk;
const savedTimePct = (100 * savedSeconds) / (stats.toolSeconds || 1);

if (asJson) {
  console.log(JSON.stringify({ ...stats, surfaceTokens: Math.round(surfaceTokens), totalSavedTokens: Math.round(totalSaved), mechanicalPct: Number(mechanicalPct.toFixed(2)), savedSeconds: Math.round(savedSeconds), savedTimePct: Number(savedTimePct.toFixed(2)) }, null, 2));
  process.exit(0);
}

const n = (value) => Math.round(value).toLocaleString();
console.log(`语料：${dir}`);
console.log(`会话 ${stats.sessions} 场 · 请求 ${stats.requests} 次 · univer 调用 ${stats.univerCalls} 次 · univer 结果 ${stats.univerResults} 条`);
console.log(`有效 prompt 合计：${n(stats.promptTokens)} token`);
console.log('');
console.log('══ token 侧（机制确定能省，不含依赖模型配合的部分）══');
console.log(`  ① 工具面收敛   ${ORIGINAL_TOOL_CHARS} → ${FACADE_CHARS} 字符 × ${stats.requests} 次请求`);
console.log(`                 = ${n(surfaceTokens)} token`);
console.log(`  ② 结果压缩     ${n(stats.resultCharsBefore)} → ${n(stats.resultCharsAfter)} 字符（省 ${(100 * (stats.resultCharsBefore - stats.resultCharsAfter) / stats.resultCharsBefore).toFixed(1)}%）`);
console.log(`                 按携带成本加权 = ${n(stats.carriedTokensSaved)} token`);
console.log(`  ─────────────────────────────────────────────`);
console.log(`  合计省 ${n(totalSaved)} token  =  ${mechanicalPct.toFixed(2)}%`);
console.log('');
console.log('══ 时间侧（只算本插件能确凿消除的调用）══');
console.log(`  ③ 重复编译被按页缓存挡掉：${stats.redundantCompiles} 次，省 ${stats.savedSecondsCompile.toFixed(1)} 秒`);
console.log(`  ④ 重复失败被记忆化挡掉：  ${stats.repeatedFailures} 次，省 ${stats.savedSecondsFailure.toFixed(1)} 秒`);
console.log(`  ⑤ 超限截图改走渲染前分片：${stats.overLimitScreenshots} 次，省 ${stats.savedSecondsChunk.toFixed(1)} 秒`);
console.log(`  ─────────────────────────────────────────────`);
console.log(`  工具耗时合计 ${stats.toolSeconds.toFixed(1)} 秒 → 省 ${savedSeconds.toFixed(1)} 秒  =  ${savedTimePct.toFixed(1)}%（占工具耗时）`);
console.log(`  会话墙钟合计 ${stats.wallSeconds.toFixed(1)} 秒 → 同一笔节省  =  ${(100 * savedSeconds / (stats.wallSeconds || 1)).toFixed(1)}%（占墙钟）`);
console.log(`  （其中渲染类工具 ${stats.renderSeconds.toFixed(1)} 秒，占工具耗时 ${(100 * stats.renderSeconds / (stats.toolSeconds || 1)).toFixed(0)}%；`);
console.log(`    墙钟的其余部分是模型推理与人工等待，本插件不改变往返次数，因此动不了）`);
console.log('');
console.log('══ 分会话明细（前两场是真实 PPT 任务，第三场是插件安装会话、几乎没有 univer 工作）══');
console.log('  会话'.padEnd(20) + '请求'.padStart(6) + '省token'.padStart(10) + '占比'.padStart(8) + '省秒'.padStart(8) + '墙钟'.padStart(9) + '提速'.padStart(8) + '重复编译'.padStart(10));
for (const session of perSession.sort((a, b) => b.savedSeconds - a.savedSeconds)) {
  const savedTokens = session.surfaceTokens + session.carried;
  console.log('  ' + session.id.slice(0, 18).padEnd(18)
    + String(session.requests).padStart(6)
    + n(savedTokens).padStart(10)
    + `${(100 * savedTokens / (session.promptTokens || 1)).toFixed(1)}%`.padStart(8)
    + session.savedSeconds.toFixed(0).padStart(8)
    + `${session.wallSeconds.toFixed(0)}s`.padStart(9)
    + `${(100 * session.savedSeconds / (session.wallSeconds || 1)).toFixed(1)}%`.padStart(8)
    + String(session.redundantCompiles).padStart(10));
}
console.log('');
console.log('══ 未计入的部分（依赖模型配合，无法保证）══');
console.log(`  · batch 合并往返 / one-shot 引导：潜在最大，但取决于模型是否照做`);
console.log(`  · 截图预算：日志里 ${stats.imagesSeen} 张图，超预算的会被扣下；模型 force:true 即归零`);
console.log(`  · 只读记忆化：省的是网关调用与延迟，token 侧只是一行指针`);
