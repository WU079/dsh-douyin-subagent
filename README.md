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
| `douyin-mcp-windows-amd64.exe` | prebuilt binary from [yunsur/douyin-mcp releases](https://github.com/yunsur/douyin-mcp/releases). The plugin spawns it on `:18080`; you point `mcpExe` at it |
| a Chromium-based browser (Edge/Chrome) | only for login + publishing; the plugin drives it over CDP on port 9222 with a dedicated `--user-data-dir` |
| a Douyin account | log in once through the browser, export cookies, done |

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
| `douyin-mcp-windows-amd64.exe` | [yunsur/douyin-mcp releases](https://github.com/yunsur/douyin-mcp/releases) 的预编译版；插件会在 `:18080` 拉起它，路径用 `mcpExe` 配 |
| Chromium 系浏览器（Edge/Chrome） | 只用来登录和发布；插件用独立的 `--user-data-dir` 通过 CDP 驱动它 |
| 抖音账号 | 在受控浏览器里扫一次码，导出 cookie 即可 |

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
