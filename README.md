# DSH 手机端插件包（iOS）

这台 iPhone 上正在跑的 6 个 DSH 插件，**原样打包**（源码未改动），用于换机 / 重装后一键恢复。

快照信息：DSH iOS App · 引擎 `0.2.2-rc.1` · profile `web` · Node `v24.20.0`（见 [MANIFEST.json](MANIFEST.json)）。

## 包里有什么

| 插件 | 版本 | 作用 |
|---|---|---|
| `dsh-mobile-ios` | 1.0.0 | 手机端适配层：安全区、抽屉、键盘、弹窗、触控尺寸 |
| `dsh-cookie-guard` | 1.0.0 | 清理登录 Cookie 累积，修请求头超 16KB 后 Web UI 打不开 |
| `dsh-session-cost` | 1.1.0 | 本轮 / 本会话花费显示（DeepSeek 官方峰谷价目） |
| `dsh-tool-token-optimizer` | 1.0.16 | 工具结果无损压缩，省 token，超预算时留头尾 + 精确取回路径 |
| `dsh-univer-turbo` | 1.0.10 | 把 14 个 `univer_*` 工具收敛成一个门面，结果进对话前语义压缩 |
| `dsh-wpac` | 0.8.2 | WPAC agent 预设：四要素追问 + 结构确认弹窗（手机端已适配） |

合计 6 个插件、146 个文件、约 1.1 MB。

## 两种装法

**A. 直接拷目录（推荐，不用解包）**

把仓库里的 `plugins/` 整个目录内容拷进 `~/.dsh/local-plugins/`，得到：

```
~/.dsh/local-plugins/dsh-mobile-ios/
~/.dsh/local-plugins/dsh-cookie-guard/
…
```

**B. 用压缩包**

```bash
tar -xzf plugins.tar.gz -C ~/.dsh/local-plugins/
```

（`plugins.tar.gz` 与 `plugins/` 内容一致，sha256 记在 `MANIFEST.json`。）

**装完还要**：在 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里加上这 6 个包名，然后重启 App——bundle 变更需要重新挂载才生效。

## 说明

- 插件是**原样打包**，没有为了发布改动任何源码；`dsh-wpac` 的工具面按本机 `0.2.2-rc.1` 的 `standard` 同步过（不含 `dsh-tool-office`）。如果换到 `rc.3`，在该插件目录里跑一次 `node scripts/adapt-tools.mjs --write` 再重装即可。
- `dsh-mobile-ios` 只影响手机端 UI，桌面端不受影响。
- `dsh-wpac` 自带的 `corpus/自由之人/` 是作者原创小说原文，仅作为该插件的素材一并打包。
