/**
 * 大文件写入的成本提示。
 *
 * ## 为什么这里只有「提示」，没有「机制」
 *
 * 实测里最大的单项成本不是工具结果，而是**模型写进工具调用的参数**：
 * 两场会话里 `write` / `edit` 的参数携带成本分别是 2,491,000 与 3,760,244 token，
 * 占各自会话全部 prompt token 的 22%~30%。最坏的单例是同一个 27KB 的 `build.mjs`
 * 被完整重写两遍，仅这一项就占那场会话的 30.1%。
 *
 * 但**插件无法回收这笔成本**，原因不是难，而是 DSH 的架构里不存在入口：
 *
 * 1. `dsh-agent-loop` 在派发工具**之前**就把助手消息落库了：
 *    ```js
 *    live.settle("assistant/message", () => this.session.append("assistant/message", {
 *        turn, step, message, ...usage, stream
 *    }, { surfaceOp: "append" }).seq);
 *    const toolCalls = message.content.filter((b) => b.type === "tool-call");
 *    const { concluded } = await executeToolCalls(...);   // ← 所有 hook 都在这一步之后
 *    ```
 *    也就是说：模型一吐出参数，它就已经进了历史。`tools/pre-execute` 再拦也拦不掉。
 * 2. `tools/pre-execute` 被框架**明确规定**不允许改写 `exec.arguments`
 *    （否则日志与呈现的参数会与实际运行的内容失去同步）。
 * 3. `tools/post-execute` 只能替换**结果**，而 `write` 的结果只有几百字符。
 * 4. `llm/stream` 技术上能在参数落库前改写它——但改完之后工具会收到「指针」而不是
 *    正文，那会直接把指针文字写进文件。要做到正确，必须再 shadow 一个 `write`
 *    复刻核心工具的全部语义；而 stream 是全局的、shadow 是 per-agent 的，
 *    两者一旦不同步就是**文件损坏**。
 *
 * 因此本模块只做一件确定安全、且成本几乎为零的事：**把成本模型直接告诉模型**，
 * 让它在决策点上知道「整文件重写会把这份内容在此后每一次请求里重发一遍」。
 *
 * ## 诚实标注
 *
 * 这是**行为引导，不是机制**，收益不可保证——它赌的是模型看到这句话后改用 `edit`。
 * 代价是每个请求约 65 token（一段静态、逐字节稳定的系统提示段）。
 * 以实测的 341 次请求计，总成本约 2.2 万 token；而只要它拦住**一次** 27KB 的重写，
 * 就赚回约 250 万 token 的携带成本。赔率约 1:110。
 *
 * 真正的机制级解法不在这里，而在框架的压缩子系统（compaction）：
 * 它会在上下文压力下把旧历史摘要掉，那些巨型参数就是在那一刻被丢弃的。
 * 见 `docs/DESIGN.md` 的「大文件写入参数」一节。
 *
 * @module dsh-univer-turbo/advice
 */

/** 系统提示段的名字（逐字节稳定，参与前缀复用）。 */
export const SECTION_NAME = 'univer-turbo:write-cost';

/** 排序值。取一个足够大的数，让这段落在工具说明之后、运行时上下文之前。 */
export const SECTION_ORDER = 9000;

/**
 * 提示正文。
 *
 * 按 token 密度逐字抠过：英文而不是中文（约 0.25 token/字符 vs 约 1），
 * 只留「成本模型」与「该怎么做」两句，不写背景、不写理由。
 */
export const SECTION_TEXT = [
  'Before writing a large file body: a whole-file `write` is re-sent in every later request of',
  'this session, so changing a few lines of a file you already wrote costs far more than it looks.',
  'Write each file once and prefer `edit` for changes afterwards; re-read it if you need the text.',
].join(' ');

/**
 * 安装提示段。
 *
 * 挂在**根**上下文：段是静态字符串，从第一个请求起就逐字节稳定，因此不违反
 * 「不按轮次增删提示词」的前缀缓存纪律（官方插件也是这么加自己的工具说明的）。
 * 任何失败都只记一条 warn——提示段不是必需品。
 *
 * @param ctx - Cordis 上下文（根）。
 * @param warn - 告警回调。
 * @returns 是否装上了。
 */
export function installWriteCostHint(ctx, warn) {
  // 整段都在 try 里，**包括取服务本身**。
  //
  // 这里踩过一个真实的坑：Cordis 对**未注入**的服务是「访问即抛错」
  // （`cannot get property "systemPrompt" without inject`）。早先的版本把
  // `ctx.systemPrompt` 写在 try 外面，于是这个异常直接冒到 `apply` 的兜底 catch，
  // **整个 install 被中止**——连 agent 接线都没跑到，插件在宿主里表现为"装死"，
  // 而且没有任何可见错误。提示段是可有可无的附属品，它绝不该有能力拖垮主体。
  //
  // 用 `ctx.get(...)` 而不是属性访问：`get` 对未注入的服务返回 undefined，不抛错。
  try {
    // 只用 `get`：它在未注入时返回 undefined。**绝不用属性访问**——哪怕只是三元里的
    // 回退分支也不行，那等于把同一颗雷留在代码里。
    if (typeof ctx?.get !== 'function') {
      warn('systemPrompt.section unavailable; write-cost hint skipped');
      return false;
    }
    const prompt = ctx.get('systemPrompt');
    if (prompt === undefined || prompt === null || typeof prompt.section !== 'function') {
      warn('systemPrompt.section unavailable; write-cost hint skipped');
      return false;
    }
    prompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: SECTION_TEXT });
    return true;
  } catch (error) {
    // 未注入 / 重名 / 顺序值非法 / 该作用域已冻结：都不该影响宿主。
    warn(`write-cost hint failed: ${error?.message ?? error}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 课件版式红线
// ---------------------------------------------------------------------------

/** 课件提示段的名字（逐字节稳定）。 */
export const PPT_SECTION_NAME = 'univer-turbo:ppt-layout';

/** 排在 write-cost 之后，仍落在工具说明之后、运行时上下文之前。 */
export const PPT_SECTION_ORDER = 9001;

/**
 * 提示正文。
 *
 * 同样按 token 密度写：英文、只留可执行的动作，不写背景。
 * 三条都是从真实事故里收回来的（见 docs/PPT_STANDARD.md 第 8 节）：
 * 文字堆叠、数字与单位离太远、只查坐标不看预览。
 */
export const PPT_SECTION_TEXT = [
  'Before laying out slides: estimate the line count of every text block first,',
  'keep at least 0.25in between blocks, and reserve one spare line per block.',
  'Never let two text blocks touch or overlap. Keep a number and its unit in one',
  'paragraph as two runs; never separate them with spaces or a wide empty box.',
  'Render every page and look at the image before delivering — coordinates passing',
  'do not prove that text did not collide.',
].join(' ');

/**
 * 安装课件提示段。
 *
 * 与 `installWriteCostHint` 同性质：静态段、失败只记 warn、不影响宿主。
 *
 * @param ctx - Cordis 上下文。
 * @param warn - 告警回调。
 * @returns 是否成功挂上。
 */
export function installPptLayoutHint(ctx, warn) {
  try {
    const prompt = ctx.get('systemPrompt');
    if (prompt === undefined || prompt === null || typeof prompt.section !== 'function') {
      warn('systemPrompt.section unavailable; ppt-layout hint skipped');
      return false;
    }
    prompt.section({ name: PPT_SECTION_NAME, order: PPT_SECTION_ORDER, text: PPT_SECTION_TEXT });
    return true;
  } catch (error) {
    warn(`ppt-layout hint failed: ${error?.message ?? error}`);
    return false;
  }
}
