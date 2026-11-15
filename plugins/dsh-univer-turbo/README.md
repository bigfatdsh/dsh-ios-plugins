# dsh-univer-turbo

把 `dsh-univer-office` 的**工具调用策略**、**执行速度**和 **token 消耗**一起优化到位。

不是「再加一层截断」，而是从**工具面 → 调用方式 → 结果大小**三处同时下手，每一处都对着
真实会话日志量出来的数字改。

---

## 一、为什么要做：真实账单长什么样

在本机 3 场真实的 Univer 任务（同一份 PPT 任务被跑了两遍）上逐条回放会话日志，得到：

| 指标 | 实测值 |
|---|---|
| 模型往返次数 | 341 |
| 总 token | 31,724,506 |
| 其中**缓存读** | 31,189,632（**98.3%**） |
| 其中输出 | 234,880（0.74%） |
| 平均每次请求的上下文 | **93,034 token** |
| 花费 | 1.8633 元 |

关键不是「总量大」，而是**成本结构**：

- 每一次往返都要把**整段上下文重发一遍**，所以一条 5,000 token 的结果，
  代价是 `5,000 × 后续往返次数`。实测**87.7%~88.3% 的 prompt token 属于这种"携带成本"**。
- 固定开销（系统提示 + 44 个工具 schema）每次请求 42,677 字符 ≈ 11,854 token，
  128 次往返就是 1,389,312 token（占 12.3%）。
- **重复调用**：两场会话里分别有 **26/179** 和 **32/141** 次调用的「工具名 + 参数」完全相同；
  其中 `univer_compile_svg` 重复编译 17 次 / 29 次（每页重编 3~4 遍）。
- **渲染类工具吃掉 77%~90% 的工具耗时**：`compile_svg` 平均 3.09 s、`screenshot` 5.95 s、`lint` 6.72 s。
- 截图是最大的单项携带成本：两场分别 **1.75M / 1.47M token**（73 张图 / 145.2 Mpx）。
- 每张截图重新渲染一次，而同一批 6 张图里最常见的一次失败是
  `Image batch exceeds the configured image-count limit`——渲染了 6~8 秒之后才被拒。

结论很直接：**省 token 的两把钥匙是「减少往返次数」和「让每次往返携带的东西更小」**。
本插件的五个机制就是照这两句话设计的。

---

## 二、它做了什么（五个机制）

### 1. 工具面收敛：14 个工具 → 1 个门面

模型看到的工具表是**每个请求都要重发一次**的前缀。实测 14 个 `univer_*` 工具的模型可见定义：

```
univer_screenshot  1800   univer_api        1276   univer_resources   957
univer_execute      937   univer_import      917   univer_compile_svg 796
univer_inspect      779   univer_unit        770   univer_lint        659
univer_worktree     629   univer_print_pdf   615   univer_export      540
univer_status       495   univer_new         341
                                        合计 11,511 字符 ≈ 2,878~3,198 token
```

收敛成一个 `univer` 门面后：**2,804 字符 ≈ 701~779 token**，
每个请求净省 **8,707 字符 ≈ 2,177~2,419 token（降幅 75.6%）**。

**能力一个不少**，因为门面不重新实现任何东西：
- 原始 14 个工具仍然注册在全局层，只是对这个 agent 打了 `restrict({deny})` 掩码；
- 门面通过 `ctx.tools.get(name)`（**省略 scope = 全局视角**）取回**同一个**原始定义，
  直接调 `definition.execute(args, exec)`——参数校验、错误类型、超时语义全部保持原样。

> 这两条都由**真实 ToolRuntime** 的集成测试守着（不是 mock）：
> `test/integration.test.js` 里 `agent 只看到 ['univer']`、`全局定义仍可解析并成功执行`。

### 2. 结果压缩：先按 JSON 语义压，再按文本预算截

Univer 的结果几乎全是结构化 JSON，特征固定：大量 `null` / `[]` / `{}` 占位、
超长数组、少量真正要看的数字。对这类文本"掐头去尾"会立刻产生两个恶果：
JSON 不再合法（模型无法局部引用，只能重跑），以及尾部的结论字段被截掉。

所以顺序是：

1. 能解析成 JSON → **语义剪枝**：删空值、限数组、限长字符串、限深度，**逐级加严的阶梯**，
   先试最宽松的档位，不够再收紧，直到落进预算；
2. 剪完还超预算 / 本来就不是 JSON → 才退回「头 55% + 尾 35% + 全部可疑行」的文本预算；
3. 任何一步只要没让结果变小，就**原样返回**（净收益闸门，出现三次）。

两条不可让步的规矩：

- **报错子树整棵免剪**（路径上出现 `error/issue/warning/fail/stack/reason/violation` 就跳过），
  报错信息是模型自我纠错的唯一依据；
- 省略说明行必须同时说清三件事——**丢了多少、里面有多少条报错行、怎么拿回来**。
  三者缺一，模型就会重跑一次工具，省下的 token 连本带利还回去。

### 3. 只读记忆化：重复调用只回一行指针

这是唯一一种「省 token 却不丢信息」的压缩：完全相同的只读调用（`status/inspect/lint/api/resources`）
不再执行，也**不再重发载荷**——因为上一次的完整结果仍然在对话历史里，模型抬头就能看到。
命中时只回一行：

```
[…] unchanged since your previous status with these exact arguments — the full result is already above; not repeated.
```

任何写操作（`execute/new/unit/worktree/import/svg`）都会让整张表失效。
宁可多失效一次（多花一次调用），也绝不把过期结果当新结果喂给模型——后者会让模型基于错的状态继续改，
代价是整轮返工。

顺带也省时间：实测重复调用占了 25%~40% 的往返。

### 4. `batch`：把 N 次往返压成 1 次

一次往返 = 一次完整上下文重发。实测里 `univer_compile_svg` 被单独调用 57 次 / 51 次，
每一次都是「改一页 → 编译一页」的小碎步。`batch` 让这些碎步合并：

```jsonc
{ "op": "batch", "ops": [
  { "op": "status",  "file": "a.univer" },
  { "op": "execute", "file": "a.univer", "unitId": "u1", "code": "..." },
  { "op": "lint",    "file": "a.univer", "unitId": "u1" }
] }
```

- 连续的**只读**步骤自动并发执行（`readConcurrency`，默认 2），写步骤串行且作为屏障；
- 部分失败不吞掉：逐条标出 `▸ [3] lint (failed)` 与原因；
- 单次上限 32 步，防止一次调用变成无限循环。

### 5. 截图治理：预算 + 去重 + **渲染前分片**

截图是最贵的单项结果，所以：

- **预算**：每个 agent 会话最多向模型投递 `screenshotBudget`（默认 8）张图，超出的只留文字
  与落盘路径；确实需要时传 `force: true` 突破——边界写在工具描述里，模型看得见，不会静默失效。
- **去重**：文档没变时，同一目标的截图不重复投递图片（结果里直接说明"上一张还在上文"）。
- **分片**：附件服务把「一条消息最多几张图」明白地告诉了我们，所以在**渲染之前**就把
  `pages` 切成合规的分片，**并发**渲染再按原序合并。把实测里「失败 → 重试 → 再失败」的
  6~8 秒 × 2 和两个完整往返，变成一次成功；每次渲染都要独立启动一次浏览器，
  所以并发直接乘在等待时间上（3 片：串行 ≈18 秒 → 并发 3 片 ≈6 秒）。

### 6. 回声抑制：删掉「把参数念一遍」的字段

Univer 的每次结果都是这个形状：

```json
{"ok":true,"operation":"compile_svg","file":"/abs/path/a.univer","result":{...}}
```

`operation` 由 op 唯一决定；`file` / `unitId` / `worktreeId` / `output` / `source` 就是**上一行
工具调用里的参数本身**。模型刚写完这些值，再把它们念回来是纯冗余。

这是少数几种「删掉却不丢信息」的压缩——信息不在结果里，而在紧邻的调用参数里。
**不是回声的就不删**（例如结果里的路径与参数不同源，那是新信息）。

### 7. 按 op 的预算

实测 `univer_compile_svg` 被调用 108 次、结果均值只有 615 字符，却每次都带回路径与
viewport；而 `univer_inspect` 真的可能很大。所以预算按 op 走而不是一刀切：
`svg: 480`、`lint: 900`、`screenshot: 800`，其余用全局 1400。

### 8. 失败记忆化

实测里 `Image batch exceeds the configured image-count limit` 连撞 3 次，
每次烧掉 **8 秒 + 一个完整往返**（≈93,000 token 的上下文重发）。

现在**确定性失败**（文件不存在、参数非法、浏览器缺失……）不再重跑，直接回上一次的报错，
而且**报错永远全文重发**——它是模型唯一能据以纠错的东西，不能让它去上文里翻。
超时/中断类**不记**（可能是瞬时的），文档一变整张表也失效。

### 9. 增量收窄与晚注册重试（正确性修复）

`dsh-univer-office` 是**一个接一个**注册它的 14 个工具的，而 `tools/change` 在每一次注册后
都会广播；同时本插件 `inject: ['agents']` 与它的 `inject: ['univer','tools']` 谁先就绪是**竞态**。
早先的版本在这里有两个真实缺陷（都已复现并修复）：

1. 首次看不到 univer 工具就**直接放弃且永不重试** → 门面不注册、14 个工具原样露出；
2. 用一个布尔量 latch 收窄状态，且重试时**重复注册门面**（同名工具会抛错）→
   在第一个工具出现时就锁死，随后注册的工具全部漏网。

现在是**事件驱动 + 增量**：`tools/change` 每次广播都重扫一遍，只处理「这一轮新出现的」
工具名，门面只注册一次，并留一条有限的定时兜底。两条路径都有回归测试
（其中一条跑在**真实 ToolRuntime** 上，直接断言晚注册后 14 个工具全部被隐藏）。

### 10. 按页的编译缓存（提速）

`compile_svg` 是写操作，用全局失效会自我作废——「编译第 7 页 → 编译第 3 页 → 再编译第 7 页」
永远命中不了。而实测 57 次编译只有 40 组不同参数（另一场 51 次 / 22 组），
**重复编译 17~29 次，每次 3.09 秒**。

所以单独开一张按**页**记账的缓存，失效规则保守优先：

- 某页被重新编译 → 只作废**该页**的旧参数条目（页面内容已变），其它页不受影响；
- 任何 `execute` 或结构性写（worktree/unit/import/new）→ **整张作废**，
  因为 `execute` 里是任意 Facade 代码，可能改到任何一页。

宁可多编译一次，也绝不把过期结果交给模型。

### 11. 大文件写入提示（行为引导，非机制）

实测最大单项成本是**模型写进工具调用的参数**：两场会话里 `write`/`edit` 的参数携带成本
分别是 2,491,000 与 3,760,244 token，占各自会话的 **22%~30%**。

**这笔成本在插件层无法回收**，因为 DSH 的架构里不存在入口：

- `dsh-agent-loop` 在派发工具**之前**就落库了助手消息（`session.append("assistant/message")`
  在 `executeToolCalls` 之前），所以所有 hook 跑起来时，参数早已进了历史；
- `tools/pre-execute` 被框架明确规定不能改写 `exec.arguments`；
- `tools/post-execute` 只能换结果，而 `write` 的结果只有几百字符；
- `llm/stream` 能在落库前改写参数，但工具随后会收到「指针」而不是正文——那会把指针文字
  写进文件；要正确就得再 shadow 一个 `write` 复刻核心工具全部语义，而 stream 是全局的、
  shadow 是 per-agent 的，**两者不同步就是文件损坏**。

所以这里只加一段**静态系统提示**（约 71 token/请求，逐字节稳定），把成本模型直接告诉
模型。赔率约 **1:110**（341 次请求共约 2.2 万 token；拦住一次 27KB 重写就省约 250 万）。
`writeCostHint: false` 可一键关掉。

> 真正的机制级解法在框架的压缩子系统：上下文压力触发时会把旧历史摘要掉，
> 那些巨型参数就是在那一刻被丢弃的。见 `docs/DESIGN.md`。

### 12. 课件版式红线（行为引导，非机制）

做课堂演示时的两次真实翻车，都出在「坐标检查通过、肉眼一看就废」：

- 第 2 页正文估 3 行排成 4 行，向下压住了红色注解——框没重叠，字重叠了；
- 「140.19 万亿元」的数字与单位之间空了将近一英寸——单位位置按 `text_w` 推算，
  而半角数字的实测宽度比估算窄。

这两条不是工具能修的，只能靠生成时的约束。所以插件往系统提示里加了**第二段静态文本**
（约 96 token/请求，逐字节稳定，`pptLayoutHint: false` 可关）：

1. 先估行数再排版，块间至少 0.25in，每块多留一行；
2. 数字与单位放同一个段落、两个 run，禁止用空格或宽框对齐；
3. 交付前必须导出每页预览图并逐页看——坐标通过不等于没压字。

完整标准见 [`docs/PPT_STANDARD.md`](docs/PPT_STANDARD.md)：交付物、结构、字号表、
排版铁律、自检四项、动效写法、讲稿格式、按时间倒序的踩坑记录。

### 附：本地校验与自解释的报错

必填参数缺失、op 拼错、工具未注册，全部在**本地**回答，一次远端往返都不花：

```
ERROR status requires: file (this op needs file; no remote call was made)
ERROR execute UNIVER_UNIT_MISSING: unit u1 not found
next: call status{file} to get a valid unitId
```

模型不用猜、也不用"试着调一次看看"。

---

## 三、它**没有**做什么，以及为什么

这一节和上面同样重要——有几件"看起来更省"的事，做下去会把成本推高。

### 绝不改写历史消息

前缀缓存占到全部 token 的 98.3%，任何对**已经发出去过**的消息的改写，都会让从改动点往后的
整段前缀作废。所以本插件：

- 只在 `agent/created`（会话第一个请求之前）动**一次**工具表，之后永不增删；
- 绝不触碰历史消息、绝不改系统提示的静态部分、绝不按轮次增删工具表；
- 所有压缩都发生在 `tools/post-execute`——也就是「结果还没进过任何请求」的那一刻；
- 输出逐字节确定：没有时间戳、没有随机、没有跨调用状态。

`test/cache.test.js` 把这些做成了可执行断言（挂载的事件集合、重复安装幂等、门面文本确定性）。

### 不与通用截断器抢活

本 profile 里已经装着 `dsh-tool-token-optimizer`（通用文本截断，实测省 62.8%）。
本插件**不重复造**那一层，只做它做不到的三件事：
工具面收敛、Univer JSON 的语义剪枝、图片与往返次数治理。两者互补，串在同一条 waterfall 上。

### 不做「引用前文」式的压缩

把大结果折叠成"见上文"会随历史演化而失效，收益远小于前缀作废的代价。

---

## 四、安装

```bash
NODE=/Users/yangletian/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
PNPM=/Users/yangletian/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs
PKG=/Users/yangletian/Documents/deepseek-harness/default-workspace/dsh-univer-turbo

cd "$PKG" && $NODE $PNPM pack          # → dsh-univer-turbo-1.0.0.tgz
dsh plugin --profile desktop add "file:$PKG/dsh-univer-turbo-1.0.0.tgz"
```

然后确认 profile 的 `package.json` 里 **两处**都有它（deps + `dsh.profile.bundles`），
并**重启宿主**。`dsh.profile.bundles` 的顺序即补丁层顺序，本行应排在 `dsh-univer-office` 之后。

**回滚**（三级，从轻到重）：

1. `cordis.patch.yml` 里给这一行加 `disabled: true` → 立即回到未安装状态；
2. 从 `dsh.profile.bundles` 里删掉这一行；
3. `dsh plugin --profile desktop remove dsh-univer-turbo`。

---

## 五、配置

全部有默认值，**什么都不配即为最优**。非法输入一律退化成默认值并留一条 warn，绝不抛错。

| 键 | 默认 | 作用 |
|---|---|---|
| `collapseTools` | `true` | 是否收窄工具面（关掉则也不注册门面，避免白占 schema） |
| `facadeName` | `'univer'` | 门面工具名 |
| `compactResults` | `true` | 结果压缩总开关 |
| `maxInlineChars` | `1400` | 单条结果的内联预算（字符） |
| `maxArrayItems` / `maxStringChars` | `40` / `240` | JSON 剪枝第一档 |
| `pruneEmpty` | `true` | 是否删除空值 |
| `maxDepth` | `8` | JSON 最大深度 |
| `memoizeReads` | `true` | 只读记忆化 |
| `memoPayloadChars` | `600` | 命中时载荷小于该值就重发，否则只回指针 |
| `screenshotBudget` | `8` | 每个会话最多投递几张截图；`0` = 不限制 |
| `dedupeImages` | `true` | 同一目标不重复投递图片 |
| `stripEcho` | `true` | 删掉结果里只是回声调用参数的字段 |
| `opBudgets` | `{svg:480, lint:900, screenshot:800}` | 按 op 收紧内联预算 |
| `memoizeFailures` | `true` | 确定性失败不重跑（超时类除外） |
| `readConcurrency` | `2` | `batch` 内连续只读步骤的并发上限 |
| `chunkConcurrency` | `2` | 超限截图分片时的并发渲染上限 |
| `defaultScreenshotScale` | `0`（不干预） | 截图默认缩放；0.75 ≈ 图片成本减半 |
| `writeCostHint` | `true` | 系统提示里的「整文件写入很贵」静态段 |
| `pptLayoutHint` | `true` | 系统提示里的「课件版式红线」静态段（见 docs/PPT_STANDARD.md） |
| `debug` | `false` | 调试日志 |

---

## 六、测试与度量

```bash
NODE=/Users/yangletian/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node

$NODE tools/extract-runtime.mjs      # 从 app.asar 提取真实运行时（只需一次）
$NODE --test "test/*.test.js"        # 34 项测试
$NODE tools/measure.mjs              # 复算工具面省量
```

- `test/unit.test.js`（23 项）：压缩算法、记忆化、op 归一化、配置健壮性、门面行为
  （本地报错、指针、写失效、batch、并发、截图预算/去重/分片、错误格式化）。
- `test/integration.test.js`（6 项）：**真实 Cordis + 真实 ToolRuntime**——
  收窄是否真的生效、受限后门面还能不能调起来、`tools/post-execute` 在 agent 作用域
  会不会被真的派发、失败结果是否逐字节放行、没有 univer 工具时是否安静退场。
  真实运行时缺失时整组**跳过**而不是失败。
- `test/cache.test.js`（5 项）：前缀缓存不变量、重复安装幂等、门面文本确定性、装配永不抛错。

度量脚本用真实运行时的 `parameterSchemaSpecToJsonSchema` 编译真实工具定义，
所以量的是**模型实际看到的形状**，不是源码里的字面量。

---

## 七、已知边界（说清楚，不含糊）

- **工具面收敛只在会话开始时生效**。插件晚于 agent 启动（热重载）时会补装已存在的 agent，
  但已经发出去的请求不受影响。
- **图片本身不做重编码**。降采样需要 PNG 编解码，代价与风险都不成比例；
  本插件改为从源头治理（预算、去重、渲染前分片、默认不去截）。
- **成本结构决定了「省往返」比「省结果」更重要**：一条结果只付一次生成代价，
  却要付 N 次携带代价。所以 `batch` 的收益通常大于压缩同一条结果。
- **本插件不改变模型看到的事实**：它只减少重复、冗余与占位符；
  报错、结论、ID、计数一个不动。

---

## 八、目录

```
lib/
  index.js      Cordis 外壳：每 agent 安装、收窄工具面、注册兜底压缩
  facade.js     门面：op 派发、本地校验、记忆化、batch、截图治理、错误格式化
  ops.js        op 表：门面与真实工具之间唯一的映射真源 + 模型可见的 schema/描述
  compact.js    结果压缩：JSON 语义剪枝（阶梯） + 文本预算 + 诚实省略说明
  memo.js       只读记忆化：稳定键、LRU、写失效
  config.js     配置解析：非法输入退化、数值夹紧
test/           单元 / 真实运行时集成 / 前缀缓存不变量
tools/          extract-runtime.mjs（提取真实运行时）、measure.mjs（复算省量）
docs/           DESIGN.md（设计取舍）、MEASUREMENTS.md（实测数据）
                PPT_STANDARD.md（课堂演讲 PPT 版式标准，现行版）
```

MIT.
