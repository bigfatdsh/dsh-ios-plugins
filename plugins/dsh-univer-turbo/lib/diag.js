/**
 * 装配自诊断。
 *
 * 只在排障时启用：把装配过程中每一步的事实追加到一个 JSONL 文件。
 * 之所以需要它：插件行"在装配树里、模块也 import 成功，却没有产生任何效果"这种情况
 * 是**静默失败**——宿主不会报错，日志也拿不到。与其猜，不如让插件自己说话。
 *
 * 由 `config.diag` 打开（默认关）。写文件绝不抛错。
 *
 * @module dsh-univer-turbo/diag
 */

import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FILE = join(process.env.DSH_HOME ?? tmpdir(), 'univer-turbo-diag.jsonl');

/**
 * 追加一条诊断记录。
 *
 * @param {string} event - 事件名。
 * @param {object} [detail] - 附加事实（必须是可 JSON 序列化的）。
 */
export function diag(event, detail) {
  try {
    appendFileSync(FILE, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...(detail ?? {}) })}\n`);
  } catch {
    // 诊断写不出去永远不是错误。
  }
}

/** 诊断文件路径（供文档与排障引用）。 */
export const DIAG_FILE = FILE;
