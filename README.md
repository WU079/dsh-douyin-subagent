# dsh-douyin-subagent

> A "scroll Douyin" plugin for [DSH](https://github.com/deepseek-ai/deepseek-harness) — modeled on
> [dsh-bili-subagent](https://github.com/Yuuyuko-uu/dsh-bili-subagent). At valley hours it sends a subagent to browse
> Douyin: search videos, read details, go through the comments, pick what is worth watching, and report back.
> The hard part (Douyin APIs, signing, login state) is provided by
> [yunsur/douyin-mcp](https://github.com/yunsur/douyin-mcp) — 133 tools over plain HTTP.

English | [中文](#中文)

## What you get

- **11 tools**: `dy_status` / `dy_config` / `dy_login` / `dy_search` / `dy_video` / `dy_comments` /
  `dy_comment` / `dy_publish` / `dy_scan` / `dy_tools` / `dy_mcp`
- **Valley-time timer**: 13:00–15:00 and 19:00–10:00 (next day), weekends count as valley all day.
  At the appointed time it hands a trigger to the target session; the agent then runs `dy_scan` itself.
  `perDay` rounds per day, at least `gapMin` minutes apart.
- **Charter** `prompts/duty.md` (overridable at `$DSH_HOME/douyin-duty/duty.md`): verify login, search 2–3 keyword
  variants, read details and comments, pick at most N, "better nothing than junk", never guess.
- **Reports** at `$DSH_HOME/douyin-duty/out/<date>.md`.

## Requirements

| piece | what |
|---|---|
| DSH | a profile that can install plugins (this is a bundle plugin, `dsh.bundle` declared) |
| `douyin-mcp-windows-amd64.exe` | prebuilt binary from [yunsur/douyin-mcp releases](https://github.com/yunsur/douyin-mcp/releases) — **pinned to `v0.1.0`**, see [Version pinning](#version-pinning). The plugin spawns it on `:18080`; you point `mcpExe` at it |
| a Chromium-based browser (Edge/Chrome) | only for login + publishing; the plugin drives it over CDP on port 9222 with a dedicated `--user-data-dir` |
| a Douyin account | log in once through the browser, export cookies, done |

## Version pinning

The plugin treats `douyin-mcp` as an **external binary**, so an upstream change would otherwise break it
silently — with an error that looks like anything but "wrong version". It is therefore pinned to the exact
build that has been tested:

| item | value |
|---|---|
| release | [`yunsur/douyin-mcp` `v0.1.0`](https://github.com/yunsur/douyin-mcp/releases/tag/v0.1.0) (2026-10-07) |
| asset | `douyin-mcp-windows-amd64.exe` |
| size | `38575616` bytes |
| SHA-256 | `0795584ff1343ff3d6c963a23ec2098b96cc9cea7bfd73eac4c33149b9963134` |
| download | <https://github.com/yunsur/douyin-mcp/releases/download/v0.1.0/douyin-mcp-windows-amd64.exe> |

Before spawning the server (and again after `initialize`, where `serverInfo` is available) the plugin hashes
the binary and compares it with this table. A mismatch is **reported, not swallowed** — `dy_*` tools return:

```
douyin-mcp 不是测试过的那个构建：测试过的是 yunsur/douyin-mcp v0.1.0（douyin-mcp-windows-amd64.exe，
sha256 0795584ff134…，38575616 字节）；你这个是 sha256 22e3dbef2237…、17156096 字节，
serverInfo.version=1.0.0（…\douyin-login-windows-amd64.exe）。版本号碰巧一样但二进制不同。
改法：从 https://github.com/yunsur/douyin-mcp/releases/download/v0.1.0/douyin-mcp-windows-amd64.exe
下回测试过的那个 exe；或者把 mcpVersionCheck 设成 "warn"（只警告、照常用）/"off"（完全不检查）。
```

`dy_status` reports the same verdict as `mcp.version`: `{level: ok|warn|error|off, tested, detected, message}`.

Two things worth knowing:

- **`serverInfo.version` is not a release number.** The upstream binary hardcodes `"version": "1.0.0"` in
  `initialize` regardless of the tag it was built from, so the real lock is the **SHA-256**; the version string
  is only a secondary signal (a changed `serverInfo` usually means the interface moved too).
- **Only the Windows asset is hashed.** On other platforms the check falls back to comparing
  `serverInfo.version` and reports `level: "warn"` ("unverifiable") rather than claiming a match.

Override with `mcpVersionCheck`:

| value | behaviour |
|---|---|
| `strict` (default) | different binary ⇒ error; `dy_*` refuse to run |
| `warn` | different binary ⇒ logged and shown in `dy_status`; tools still run |
| `off` | no check at all (a mismatch will then fail wherever upstream changed) |

Re-testing a newer upstream release is a deliberate step: bump `TESTED_MCP` in `lib/mcpVersion.mjs`, run a
`dy_scan` + `dy_comments` round, then update this table.

## Install

```bash
dsh plugin --profile <your-profile> add github:WU079/dsh-douyin-subagent
```

Then restart DSH (or reload the profile) — the `dy_*` tools show up.

## First run

1. Put `douyin-mcp-windows-amd64.exe` anywhere and tell the plugin where:

   ```
   dy_config { "patch": { "mcpExe": "D:/tools/douyin-mcp-windows-amd64.exe" } }
   ```

   (or set `DOUYIN_MCP_EXE` in the host environment)

2. Log in:

   ```
   dy_login { "action": "open" }   # opens a controlled Edge window at douyin.com
   # scan the official QR code with the Douyin app
   dy_login { "action": "save" }   # exports cookies from the browser over CDP
   dy_status                       # should now show your nickname
   ```

   Because the browser is a dedicated profile, it keeps its login: next time you can just
   `dy_login { "action": "save" }` to refresh the cookie file.

3. Use it:

   ```
   dy_scan { "direction": "本地语音克隆 踩坑", "n": 1 }
   dy_search { "keyword": "..." }
   dy_video { "aweme_id": "..." }
   dy_comments { "aweme_id": "...", "count": 30 }
   ```

## Config

`dy_config` reads/writes `$DSH_HOME/douyin-duty/config.json`.

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | plugin on/off |
| `autoMode` | `valley` | `manual` / `valley` / `always` |
| `noon` / `night` | `true` | which windows are active |
| `perDay` / `gapMin` | `2` / `180` | auto rounds per day / minutes between rounds |
| `direction` | `""` | what to look for |
| `keywords` | `[]` | fallback directions |
| `perScan` | `1` | how many items each round |
| `mcpExe` | `""` | path to `douyin-mcp-windows-amd64.exe` |
| `mcpPort` | `18080` | MCP HTTP port |
| `mcpToken` | generated | bearer token for the local MCP server; random on first run if empty |
| `mcpVersionCheck` | `strict` | `douyin-mcp` version gate: `strict` / `warn` / `off` (see [Version pinning](#version-pinning)) |
| `browserPort` | `9222` | CDP port of the controlled browser |
| `browserProfile` | `<home>/browser` | `--user-data-dir` of that browser |
| `cookieFile` | `<home>/cookies.txt` | where the exported cookie lives |
| `targetSession` | `""` | session to deliver the trigger to; empty = most recent |
| `triggerPrompt` | built-in | text handed to the session |
| `reportLevel` | `full` | `full` / `brief` / `off` |

## Notes & boundaries

- **The MCP server is local-only.** The plugin spawns it with a random per-install bearer token bound to `127.0.0.1`.
- **Publishing** through the MCP tools needs extra TICKET/TS_SIGN/PRIVATE_KEY material that most accounts cannot
  mint; in practice publishing goes through the creator web UI. `vendor/douyin-tools/` has the CDP helpers for that.
- **`check_login_status` lies.** Judge login state by `get_my_profile` returning `status_code === 0`
  (`dy_status` does this for you).
- **Cookies expire**; refresh with `dy_login { action: "save" }` while the controlled browser is still logged in.
- **Young accounts are rate-limited.** Comment/publish in small amounts and spaced out.
- Nothing here is affiliated with Douyin/ByteDance. Use it for personal browsing; respect their terms and other
  people's privacy. Read other people's comments, don't mass-harvest them.

## License

MIT — see [LICENSE](LICENSE).

---

# 中文

> 给 DSH 的「刷抖音」插件，照着 [dsh-bili-subagent](https://github.com/Yuuyuko-uu/dsh-bili-subagent) 做的。
> 谷时到点派子代理去抖音：搜视频、看详情、翻评论、挑出值得看的，回来汇报。
> 能力来自 [yunsur/douyin-mcp](https://github.com/yunsur/douyin-mcp)（133 个工具，纯 HTTP）。

## 有什么

- **11 个工具**：`dy_status` / `dy_config` / `dy_login` / `dy_search` / `dy_video` / `dy_comments` /
  `dy_comment` / `dy_publish` / `dy_scan` / `dy_tools` / `dy_mcp`
- **谷时定时器**：中午 13:00–15:00、夜里 19:00–次日 10:00，周末整天算谷时；到点往目标会话递一句话，
  agent 自己用 `dy_scan` 刷。每天 `perDay` 轮，两轮至少隔 `gapMin` 分钟。
- **值班章程**：`prompts/duty.md`（家里 `$DSH_HOME/douyin-duty/duty.md` 优先，可自己改）。
- **报告**：`$DSH_HOME/douyin-duty/out/<日期>.md`。

## 依赖

| 件 | 说明 |
|---|---|
| DSH | 能装插件（本插件声明了 `dsh.bundle`） |
| `douyin-mcp-windows-amd64.exe` | [yunsur/douyin-mcp releases](https://github.com/yunsur/douyin-mcp/releases) 的预编译版，**锁在 `v0.1.0`**（见下面「版本锁定」）；插件会在 `:18080` 拉起它，路径用 `mcpExe` 配 |
| Chromium 系浏览器（Edge/Chrome） | 只用来登录和发布；插件用独立的 `--user-data-dir` 通过 CDP 驱动它 |
| 抖音账号 | 在受控浏览器里扫一次码，导出 cookie 即可 |

## 版本锁定

`douyin-mcp` 是**外部可执行文件**，上游一改接口，这边就会坏 —— 而且报出来的错看着像别的问题。
所以插件把它锁死在**实际测过的那个构建**上：

| 项 | 值 |
|---|---|
| release | [`yunsur/douyin-mcp` `v0.1.0`](https://github.com/yunsur/douyin-mcp/releases/tag/v0.1.0)（2026-10-07） |
| 资产 | `douyin-mcp-windows-amd64.exe` |
| 大小 | `38575616` 字节 |
| SHA-256 | `0795584ff1343ff3d6c963a23ec2098b96cc9cea7bfd73eac4c33149b9963134` |
| 下载 | <https://github.com/yunsur/douyin-mcp/releases/download/v0.1.0/douyin-mcp-windows-amd64.exe> |

**起了服务之前**先算一遍 exe 的哈希对上表；连上之后**再用 `serverInfo` 复核一遍**。对不上就明确报错
（`dy_*` 工具直接把这段话抛出来）：

```
douyin-mcp 不是测试过的那个构建：测试过的是 yunsur/douyin-mcp v0.1.0（douyin-mcp-windows-amd64.exe，
sha256 0795584ff134…，38575616 字节）；你这个是 sha256 22e3dbef2237…、17156096 字节，
serverInfo.version=1.0.0（…\douyin-login-windows-amd64.exe）。版本号碰巧一样但二进制不同。
改法：从 https://github.com/yunsur/douyin-mcp/releases/download/v0.1.0/douyin-mcp-windows-amd64.exe
下回测试过的那个 exe；或者把 mcpVersionCheck 设成 "warn"（只警告、照常用）/"off"（完全不检查）。
```

`dy_status` 的 `mcp.version` 里能看到同一份结论：`{level: ok|warn|error|off, tested, detected, message}`。

两个容易踩的点：

- **`serverInfo.version` 不是版本号**：上游二进制在 `initialize` 里把 `"version"` 写死成 `"1.0.0"`，跟它从哪个 tag
  编出来无关 —— 所以真正的锁是 **SHA-256**，版本号只是辅助信号（接口变了它通常会跟着变）。
- **只锁 Windows 资产的哈希**。其它平台上退化成只比 `serverInfo.version`，结论给 `level: "warn"`（「没法核实」），
  不会假装对上。

想放行用 `mcpVersionCheck`：

| 值 | 行为 |
|---|---|
| `strict`（默认） | 二进制对不上就报错，`dy_*` 不干活 |
| `warn` | 对不上只记日志 + 在 `dy_status` 里显示，工具照常用 |
| `off` | 完全不检查（那就只能等上游改动时自己面对报错） |

真要升级到新版：改 `lib/mcpVersion.mjs` 里的 `TESTED_MCP`，跑一轮 `dy_scan` + `dy_comments` 验一遍，再更新这张表。

## 安装

```bash
dsh plugin --profile <你的 profile> add github:WU079/dsh-douyin-subagent
```

重启 DSH，工具里就会出现 `dy_*`。

## 第一次用

1. 把 `douyin-mcp-windows-amd64.exe` 放好，告诉插件位置：

   ```
   dy_config { "patch": { "mcpExe": "D:/tools/douyin-mcp-windows-amd64.exe" } }
   ```

   （或在宿主环境变量里设 `DOUYIN_MCP_EXE`）

2. 登录：

   ```
   dy_login { "action": "open" }   # 起一个受控 Edge 打开 douyin.com
   # 用手机抖音扫官方二维码登录
   dy_login { "action": "save" }   # 通过 CDP 把 cookie 导出来
   dy_status                       # 这时应该能看到昵称
   ```

3. 用起来：

   ```
   dy_scan { "direction": "本地语音克隆 踩坑", "n": 1 }
   dy_search { "keyword": "..." }
   dy_video { "aweme_id": "..." }
   dy_comments { "aweme_id": "...", "count": 30 }
   ```

## 配置

`dy_config` 读写 `$DSH_HOME/douyin-duty/config.json`，字段见上方英文表格（同一张表）。
其中 `mcpVersionCheck` 管 douyin-mcp 的版本闸（`strict` / `warn` / `off`，默认 `strict`，见「版本锁定」）。

## 注意与边界

- **MCP 只监听本机**：插件启动它时用每次安装随机生成的 Bearer token，绑在 `127.0.0.1`。
- **发布**：MCP 的发布工具需要 TICKET/TS_SIGN/PRIVATE_KEY 这类材料，多数账号拿不到；实际发布走创作者中心网页，
  `vendor/douyin-tools/` 里有配套的 CDP 脚本。
- **`check_login_status` 会误报**：判断登录看 `get_my_profile` 的 `status_code === 0`（`dy_status` 已经替你处理）。
- **cookie 会过期**：受控浏览器还登着的时候，`dy_login { action: "save" }` 重新导一次。
- **新号风控严**：评论、发布小量、隔开。
- 与抖音/字节跳动无关；个人使用，遵守对方条款、尊重别人隐私。看评论可以，别批量抓。

## 许可

MIT，见 [LICENSE](LICENSE)。

## 设置里的控制面板（0.1.1 起）

装好之后，进 **设置 → 刷抖音**，可以改：

- 总开关（关掉后定时器不动，`dy_*` 工具和手动 `/刷` 还能用）
- 自动模式：只手动 / 只在谷时 / 全天；中午、晚上两个谷时开关
- 每天最多刷几轮、两轮之间至少隔多少分钟、每轮挑几条
- 方向、关键词候选、报告里对你的称呼、报告详细程度
- 底部一行状态：今天第几轮、MCP 在不在线、登录态、上次刷的时间、最近一份报告

面板走插件自己挂的 `/api/douyin-duty/*` 路由读写 `$DSH_HOME/douyin-duty/config.json`，和 `dy_config` 工具改的是同一份。浏览器半端 `client.js` 的约定抄自 `dsh-bili-subagent`（`window.__ModuleLoader__.load` + `slots.inject('settings.section')`）。

## 评论/回复：页面签名直发（0.2.0 起）

MCP 的 `post_video_comment` 要 `ticket/ts_sign`（IM 会话签名），纯 cookie 登录拿不到，所以 `dy_comment` 会先走一条更简单的路：

1. 你有一个**已登录 douyin.com** 的 Chromium/Edge，开着远程调试端口（`cdpPort`，默认 `9333`）：
   ```
   "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9333 ^
     --user-data-dir=F:\douyin-browser https://www.douyin.com/
   ```
   （用着刷视频的窗口也行，只要带 `--remote-debugging-port`）
2. 插件连上 CDP，在页面上下文里调 `window.byted_acrawler.frontierSign` 生成 `X-Bogus`，再用页面自己的 `fetch`
   发 `POST /aweme/v1/web/comment/publish`。cookie、指纹、签名都是真的，等同网页自己发评论。
3. 实测：连续 5 条回复（含楼中楼 `reply_id`）全部 HTTP 200、返回 `cid`，没有触发滑块/短信验证；
   `dy_comment { "aweme_id": "...", "content": "...", "reply_id": "..." }` 的返回里 `via` 会是 `page`。
4. 页面不在（CDP 连不上）时自动退回 MCP——那条路通常仍会失败，但不会让工具直接崩。

只用最小参数（`device_platform` / `aid` / `aweme_id` / `reply_id` + `X-Bogus`）即可，不需要 msToken、verifyFp 那些模板参数；
真遇到风控（返回非 200 或需要验证），工具会把响应片段抛出来，这会儿应该停下来人工处理，别硬重试。
