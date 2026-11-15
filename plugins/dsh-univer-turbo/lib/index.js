/**
 * dsh-univer-turbo —— 把 `dsh-univer-office` 的调用成本压到极致。
 *
 * ## 它到底改了什么（一共三件事，全部发生在**结果进入对话之前**）
 *
 * 1. **收窄工具面**：把 14 个 `univer_*` 工具的 schema（实测 11,511 字符 ≈ 3,198 token，
 *    每个请求都要重发一次）换成**一个**约 1,500 字符的门面工具。原始工具仍然注册着，
 *    只是对这个 agent 隐藏；门面通过全局视角把它们原样调起来，能力一个不少。
 * 2. **压缩结果**：inspect / status / lint 返回的结构化 JSON 在进入对话前先做语义剪枝，
 *    再按预算截断，且省略说明行一定写清「丢了多少、里面有多少条报错、怎么拿回来」。
 * 3. **减少往返**：完全相同的只读调用只回一行指针；`op:"batch"` 把 N 次调用压成一次；
 *    连续只读步骤并发执行。
 *
 * ## 为什么必须「每个 agent 装一次」
 *
 * `ToolRuntime` 用 `scopeTarget(this, exec.agent)` 派发事件，agent 作用域是 `isolate`
 * 出来的、与 profile 根**没有父子关系**的独立作用域；根上注册的监听器收不到
 * agent 作用域的事件，而且**不报错**（插件行只是静默地不生效）。
 * 因此本插件走的是：根上等 `agents` → 监听 `agent/created` → 在**该 agent 自己的
 * context** 上 `inject(['tools'], …)` → 在它自己的作用域里完成上面三件事。
 *
 * ## 前缀缓存铁律（不可违反）
 *
 * DSH 的请求前缀完全依赖 provider 侧复用，`cacheReadTokens` 通常占总输入七到九成。
 * 所以本插件：
 * - 只在 `agent/created`（每个会话**第一个请求之前**）动一次工具表，之后**永不**增删；
 * - 绝不改写历史消息、绝不改系统提示的静态部分；
 * - 所有压缩都发生在 `tools/post-execute`，也就是「结果还没进过任何请求」的那一刻；
 * - 输出逐字节确定：同样的输入必然得到同样的结果（没有时间戳、没有随机、没有跨调用状态）。
 *
 * @module dsh-univer-turbo
 */

import { installWriteCostHint, installPptLayoutHint } from './advice.js';
import { diag } from './diag.js';
import { compactContent } from './compact.js';
import { normalizeConfig } from './config.js';
import { createFacade } from './facade.js';
import { createMemo } from './memo.js';

/** Cordis 插件名（短名；包名是 `dsh-univer-turbo`）。 */
export const name = 'univer-turbo';

/** 入口依赖：先拿到 agents 注册表，再按 agent 注入 tools。 */
export const inject = ['agents'];

/** 被本插件接管的工具前缀。 */
const TOOL_PREFIX = /^univer[_-]/;

/** 绝不触碰的保留工具（`restrict()` 点名它会直接抛错）。 */
const RESERVED = new Set(['run_code']);

/**
 * 插件入口。
 *
 * **装配阶段永不抛错**：任何环境差异（context 形状、字段只读、服务缺失……）
 * 都只记一条 warn。本插件的全部价值是「让调用更便宜」，它没有资格让宿主的一行
 * 插件变成 failed，更没有资格影响工具调用本身。
 *
 * @param ctx - Cordis 上下文（根）。
 * @param config - `cordis.patch.yml` 里的 `config`。
 */
export function apply(ctx, config) {
  try {
    install(ctx, config);
  } catch (error) {
    // 装配失败**无条件**留一份现场：宿主不会把它报出来，日志也未必拿得到，
    // 没有现场就只能靠猜——这个插件已经因为"静默失败"浪费过两轮重启。
    try {
      diag('install-failed', { message: error?.message, stack: String(error?.stack ?? '').slice(0, 2000) });
    } catch {
      // 取证失败也不能影响降级。
    }
    try {
      ctx?.logger?.warn?.(`univer-turbo: install failed, plugin disabled: ${error?.stack ?? error}`);
    } catch {
      // 连日志都写不出去时也不能让异常冒泡。
    }
  }
}

/**
 * 真正的安装过程。
 *
 * @param ctx - Cordis 上下文。
 * @param config - 原始配置。
 */
function install(ctx, config) {
  const log = (message, detail) => {
    try {
      ctx?.logger?.debug?.(`univer-turbo: ${message}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
    } catch {
      // 日志不是必需品。
    }
  };
  const warn = (message) => {
    try {
      ctx?.logger?.warn?.(`univer-turbo: ${message}`);
    } catch {
      // 同上。
    }
  };
  const cfg = normalizeConfig(config, warn);
  if (cfg.diag) diag('apply', { config: cfg, agents: safeAgentIds(ctx) });

  const totals = {
    scopes: 0,
    collapsed: 0,
    hiddenTools: 0,
    results: 0,
    resultsChanged: 0,
    charsBefore: 0,
    charsAfter: 0,
    tokensSaved: 0,
  };

  /** 已接线过的 agent（按对象身份记账，重复的 created 事件不会重复接线）。 */
  const wired = new WeakSet();

  /**
   * 已经 `inject(['tools'])` 兑现、但**可能还没完成收窄**的作用域。
   *
   * 为什么需要这张表：本插件 `inject: ['agents']`，而 `dsh-univer-office` 的工具插件
   * `inject: ['univer', 'tools']`——后者要等网关服务就绪。两者谁先就绪是**竞态**：
   * 本插件可能先跑，此时一个 `univer_*` 都还没注册。早先的版本在这种情况下直接放弃
   * 且永不重试，于是门面不注册、14 个工具原样露出（本机实测复现过一次）。
   *
   * 现在改成事件驱动：`tools/change` 是工具注册表每次变化时的全局广播，
   * 收到就把还没收窄完的作用域再试一次。
   */
  const pending = [];

  /**
   * 尝试在一个 agent 作用域里完成安装。可反复调用，幂等。
   *
   * @param scoped - 该作用域内 `tools` 已就绪的上下文。
   * @param label - 诊断标签。
   * @param state - 该作用域的安装状态。
   */
  const attempt = (scoped, label, state) => {
    if (state.busy === true) return;
    state.busy = true;
    try {
      if (cfg.diag) diag('attempt', { label, busy: state.busy, facadeRegistered: state.facadeRegistered, denied: state.denied.size, hasScoped: scoped !== undefined && scoped !== null, hasTools: scoped?.tools !== undefined, toolsType: typeof scoped?.tools });
      if (state.compaction !== true) {
        registerCompaction(scoped, cfg, totals, log);
        state.compaction = true;
      }
      if (!cfg.collapseTools) return;
      const tools = scoped?.tools;
      if (tools === undefined || typeof tools.register !== 'function') {
        warn(`scope ${label} has no tools service; skipped`);
        return;
      }

      // 工具名必须**已经存在于全局层**，否则 `restrict()` 会直接抛错。
      //
      // 关键：`dsh-univer-office` 是**一个接一个**注册它的 14 个工具的，而
      // `tools/change` 在每一次注册后都会广播。所以这里必须做**增量**收窄——
      // 只处理「这一轮新出现的」工具。早先的版本用一个布尔量 latch，
      // 结果在第一个工具出现时就锁死，其余 13 个永远漏网（本机插桩实测复现）。
      const discovered = discoverUniverTools(tools);
      if (cfg.diag) diag('discover', { label, discovered: discovered.length, names: discovered.slice(0, 20), denied: state.denied.size });
      const hidden = discovered.filter((name) => !state.denied.has(name));
      if (hidden.length === 0) {
        // 正常竞态：univer 工具还没注册（或已全部收窄）。等下一次 `tools/change`。
        if (state.waited !== true) {
          state.waited = true;
          log(`scope ${label}: no new univer tools yet; will retry on tools/change`);
        }
        return;
      }

      // 门面**只注册一次**：同一作用域里重复 register 同名工具会直接抛错，
      // 而 `attempt` 会被 `tools/change` 反复调用。早先漏了这一步，
      // 于是第二次尝试就抛错返回，后面的工具永远收窄不到（本机插桩实测复现）。
      if (state.facadeRegistered !== true) {
        if (state.facade === undefined) {
          state.facade = createFacade({
            config: cfg,
            resolveTool: (toolName) => safeGet(tools, toolName),
            memo: createMemo(),
            log,
            imageLimit: () => {
              try {
                return scoped.get?.('attachments')?.imageLimits;
              } catch {
                return undefined;
              }
            },
          });
        }
        try {
          state.releaseFacade = tools.register(state.facade.definition);
          state.facadeRegistered = true;
        } catch (error) {
          warn(`scope ${label}: facade registration failed (${error?.message ?? error}); leaving the original tools visible`);
          return;
        }
      }

      try {
        tools.restrict({ deny: hidden });
      } catch (error) {
        // 收窄失败必须回滚门面，否则模型会同时看到门面和 14 个原工具，反而更贵。
        warn(`scope ${label}: restrict failed (${error?.message ?? error}); rolling the facade back`);
        try {
          release(state.releaseFacade);
        } catch {
          // 回滚失败只能接受：至少日志里说清楚了。
        }
        state.facadeRegistered = false;
        state.releaseFacade = undefined;
        return;
      }
      for (const name of hidden) state.denied.add(name);
      if (cfg.diag) diag('restricted', { label, added: hidden, total: state.denied.size });
      totals.hiddenTools += hidden.length;
      log(`collapsed ${hidden.length} tool(s) into "${cfg.facadeName}"`, { scope: label, total: state.denied.size });
    } finally {
      state.busy = false;
    }
  };

  /** 工具表每次变化都重试一遍还没收窄完的作用域。 */
  const retryPending = () => {
    for (const entry of pending) {
      try {
        attempt(entry.scoped, entry.label, entry.state);
      } catch (error) {
        warn(`retry failed for ${entry.label}: ${error?.message ?? error}`);
      }
    }
  };

  if (typeof ctx.on === 'function') {
    try {
      ctx.on('tools/change', () => {
        if (cfg.diag) diag('tools-change', { pending: pending.length });
        retryPending();
      });
    } catch (error) {
      warn(`tools/change listener failed: ${error?.message ?? error}`);
    }
  }

  const installForAgent = (agent) => {
    if (agent === null || typeof agent !== 'object') return;
    if (wired.has(agent)) return;
    wired.add(agent);
    const agentCtx = agent.ctx;
    if (agentCtx === undefined || typeof agentCtx.inject !== 'function') return;
    const label = `agent:${String(agent.id ?? '?').slice(0, 8)}`;
    try {
      if (cfg.diag) diag('inject-call', { label });
      agentCtx.inject(['tools'], (scoped) => {
        if (cfg.diag) diag('inject-fired', { label, hasScoped: scoped !== undefined && scoped !== null, scopeKeyType: typeof scoped?.tools });
        const state = { busy: false, compaction: false, facade: undefined, facadeRegistered: false, releaseFacade: undefined, denied: new Set(), waited: false };
        try {
          attempt(scoped, label, state);
        } catch (error) {
          warn(`scope ${label}: install failed: ${error?.stack ?? error}`);
        }
        // 条目常驻：univer-office 的 14 个工具是分多次注册的，每一次都可能带出新的名字。
        // 扫描一张几十项的表，代价可以忽略；漏掉一个工具则会白占 schema，代价大得多。
        if (cfg.collapseTools) {
          pending.push({ scoped, label, state });
          scheduleRetry();
        }
      });
    } catch (error) {
      warn(`scope ${label}: inject failed: ${error?.message ?? error}`);
    }
  };

  /**
   * 有限次数的定时兜底重试。
   *
   * `tools/change` 是主路径；这个定时器只防「事件没到」的极端情况
   * （例如注册发生在监听器挂上之前）。次数很少、间隔递增，之后彻底停止，
   * 不会长期占用宿主资源。
   */
  let retryTimer;
  const scheduleRetry = (round = 0) => {
    if (pending.length === 0 || round >= 6) return;
    if (typeof setTimeout !== 'function') return;
    retryTimer ??= setTimeout(() => {
      retryTimer = undefined;
      retryPending();
      if (pending.length > 0) scheduleRetry(round + 1);
    }, 200 * (round + 1));
    // 后台兜底不该吊住事件循环：宿主本来就长寿，但测试进程与退出路径必须能走掉。
    retryTimer?.unref?.();
  };

  /** 作用域释放时清掉定时器。 */
  try {
    ctx.effect(() => () => { if (retryTimer !== undefined) clearTimeout(retryTimer); }, 'univer-turbo.retry-timer');
  } catch {
    // 没有 effect 就算了，定时器本来就有限次。
  }

  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', (payload) => installForAgent(payload?.agent));
  }
  // 插件晚于 agent 启动时（热重载 / 后装）也要补装已存在的 agent。
  try {
    const agents = ctx.agents;
    if (agents !== undefined && typeof agents.list === 'function') {
      const list = agents.list();
      if (cfg.diag) diag('backfill', { count: Array.isArray(list) ? list.length : -1 });
      for (const agent of list) installForAgent(agent);
    }
  } catch (error) {
    warn(`back-fill failed: ${error?.message ?? error}`);
  }

  // ── 可选功能：一律排在关键路径之后 ──────────────────────────────────────────
  //
  // 这里曾经出过一次静默故障：成本提示在 try 之外访问了未注入的 `systemPrompt`，
  // 异常冒到 `apply` 的兜底 catch，**整个 install 被中止**——连 agent 接线都没跑到。
  // 教训不是"那行要包 try"，而是**可选功能绝不允许排在关键路径前面**：
  // 只要顺序对了，再出同类问题也只会少一个附加功能，主体照样工作。

  // 根作用域也挂一份兜底压缩：覆盖非 agent 作用域的执行（例如宿主自身的诊断调用）。
  try {
    registerCompaction(ctx, cfg, totals, log);
  } catch (error) {
    warn(`root compaction hook failed: ${error?.message ?? error}`);
  }

  // 大文件写入的成本提示：静态段，从第一个请求起就逐字节稳定。
  try {
    if (cfg.writeCostHint) installWriteCostHint(ctx, warn);
  } catch (error) {
    warn(`write-cost hint failed: ${error?.message ?? error}`);
  }

  // 课件版式红线：与大文件提示同一性质，只在用户做幻灯片时有用，对其它任务无害。
  try {
    if (cfg.pptLayoutHint) installPptLayoutHint(ctx, warn);
  } catch (error) {
    warn(`ppt-layout hint failed: ${error?.message ?? error}`);
  }

  /** 只读统计面：供测试与诊断读取；不注册服务、不产生任何 token。 */
  try {
    ctx.univerTurboStats = { snapshot: () => ({ ...totals }) };
  } catch {
    // 某些 context 形状拒绝写入自定义属性：统计不是必需品，忽略。
  }
}

/**
 * 找出这个作用域继承到的全部 univer 工具。
 *
 * 用**全局视角**（`view(undefined)`）枚举，而不是当前作用域视角：
 * 后者会受此前已经打上的 restrict 掩码影响，导致重复安装时看不到任何工具。
 *
 * @param tools - ToolRuntime 服务。
 * @returns {string[]} 需要隐藏的工具名。
 */
function discoverUniverTools(tools) {
  const names = new Set();
  try {
    const view = tools.view(undefined);
    for (const key of view?.visible?.keys?.() ?? []) {
      if (TOOL_PREFIX.test(key) && !RESERVED.has(key)) names.add(key);
    }
  } catch {
    // 拿不到视图时退回已知清单，保证核心能力仍可用。
  }
  // 兜底：即使视图读取失败，也把标准工具名纳入（restrict 自己会校验存在性）。
  for (const known of [
    'univer_status', 'univer_inspect', 'univer_execute', 'univer_lint', 'univer_screenshot',
    'univer_export', 'univer_print_pdf', 'univer_new', 'univer_unit', 'univer_worktree',
    'univer_import', 'univer_compile_svg', 'univer_resources', 'univer_api',
  ]) {
    if (names.has(known)) continue;
    if (safeGet(tools, known) !== undefined) names.add(known);
  }
  return [...names].sort();
}

/** 安全地按全局视角取一个工具定义。 */
/** 只读地列出当前 agent id，用于诊断。 */
function safeAgentIds(ctx) {
  try {
    const list = ctx?.agents?.list?.();
    return Array.isArray(list) ? list.map((agent) => String(agent?.id ?? '?').slice(0, 8)) : null;
  } catch {
    return 'unavailable';
  }
}

function safeGet(tools, toolName) {
  try {
    return typeof tools.get === 'function' ? tools.get(toolName) : undefined;
  } catch {
    return undefined;
  }
}

/** 用完即弃的注册回滚：disposer 可能是函数，也可能是 `{dispose}`；两者都不许抛出去。 */
function release(disposer) {
  if (typeof disposer === 'function') return disposer();
  if (disposer !== null && typeof disposer === 'object' && typeof disposer.dispose === 'function') {
    return disposer.dispose();
  }
  return undefined;
}

/**
 * 注册结果压缩监听器。
 *
 * 契约（来自既有插件的实测结论）：
 * - `prepend: true` + **先 `await next()`** → 看到的是所有下游转换器处理完的最终内容，
 *   不会与官方 spill-policy / fs-search 互相覆盖；
 * - 用 `WeakSet` 按结果对象身份去重：根与 agent 两处注册可能同时命中同一条结果；
 * - 任何异常都只记日志、原样放行——压缩器的 bug 绝不能变成工具调用的 bug。
 *
 * @param scope - 作用域上下文。
 * @param cfg - 配置。
 * @param totals - 统计累加器。
 * @param log - 调试日志。
 */
function registerCompaction(scope, cfg, totals, log) {
  if (typeof scope?.on !== 'function') return;
  const handled = new WeakSet();
  const handler = async (exec, result, next) => {
    const decision = await next();
    if (decision.kind !== 'accept') return decision;
    // 下游已经换成了结构化 value：那不是文本结果，无权改动。
    if (Object.hasOwn(decision, 'value')) return decision;
    if (result === null || typeof result !== 'object') return decision;
    if (handled.has(result)) return decision;
    handled.add(result);
    // 失败结果是模型自我纠错的唯一依据：一个字节都不动。
    if (result.isError === true) return decision;
    if (!cfg.compactResults) return decision;
    const tool = exec?.name ?? '';
    if (!TOOL_PREFIX.test(tool)) return decision;
    const content = decision.content ?? result.content;
    if (!Array.isArray(content) || content.length === 0) return decision;
    try {
      const compacted = compactContent(content, {
        budget: cfg.maxInlineChars,
        hint: 're-run with narrower arguments to see the rest',
        maxArrayItems: cfg.maxArrayItems,
        maxStringChars: cfg.maxStringChars,
        maxDepth: cfg.maxDepth,
        pruneEmpty: cfg.pruneEmpty,
      });
      if (!compacted.changed) return decision;
      totals.results += 1;
      totals.resultsChanged += 1;
      totals.charsBefore += compacted.before;
      totals.charsAfter += compacted.after;
      totals.tokensSaved += Math.ceil((compacted.before - compacted.after) / 4);
      if (cfg.debug) log(`${tool} ${compacted.before} -> ${compacted.after} chars`, { steps: compacted.steps });
      return { ...decision, content: compacted.content };
    } catch (error) {
      try {
        scope?.logger?.warn?.(`univer-turbo: skipped ${tool}: ${error?.message ?? error}`);
      } catch {
        // 忽略。
      }
      return decision;
    }
  };
  scope.on('tools/post-execute', handler, { prepend: true });
}
