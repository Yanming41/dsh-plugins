# dsh-plugin-discord-bridge

在 Discord 帖子里和 DeepSeek Harness（dsh）、Claude Code、Codex 对话。三个 Cordis 插件：

| 插件 | 作用 |
|---|---|
| `discord` | 连 Discord 网关，提供 `ctx.discord`：收消息/按钮、发消息/文件/按钮、表情、改消息、论坛标签、开帖。可选一个 agent 一个 bot 身份（@ 谁就交给谁）。本地接口 `POST /send_file`、`POST /submit`。 |
| `threads` | 把帖子接到 agent：每帖一个默认引擎（`dsh` / `cc` / `codex`），切换时自动补上别的引擎在这个帖子里的对话。 |
| `lobby` | 开帖、接回本机历史会话：`/cc 标题`、`/codex 标题`、`/sessions` + `/resume 编号`、`/codex-sessions` + `/codex-resume 编号`、`/list`。 |

Claude Code / Codex 引擎来自 [`dsh-plugin-persistent-agents`](../persistent-agents)，要先装它。

## 功能

- **工作区锁**：每个帖子同一时间只有一个 agent 在跑（dsh / CC / Codex 都算）。忙时来的消息排队（存盘，重启不丢），上一轮结束自动发下一条；`/stop` 中止并清空队列。
- **状态展示**：消息上 👀 收到 → ⏳ 在跑 → ✅ 完成 / ⏹️ 中止 / ❌ 出错；一条进度消息原地刷新（用时、最近的工具调用），结束改成完成行（工具调用次数、git 改动 +/−、跑过的测试/构建）；论坛帖子标签在「进行中 / 等待中」之间切换。进度、排队提示静默发送，只有最终回复推送通知。
- **回复按钮**：agent 回复里的 ```` ```choices ```` 块变成选项按钮（点了作为你的消息发出），其余代码块加「📋 复制」按钮（手机上一点就能复制）。
- **公式**：单独成行的 LaTeX 在本机渲染成图片，行内公式转 Unicode，代码块不动。
- **帖子命令**：`/agent`、`/new`（`/clear`）、`/stop`、`/end`、`/screen`、`/model`、`/effort`、`/mode`、`/compact`、`/context`、`/cost`、`/help`、`/reload`。
- **大厅模式**：`discord.lobbies` 里的频道只收 `/` 开头的会话命令，其余消息不碰（可以和别的 bot 共用一个频道）。
- 附件下载到本机，路径交给 agent；发出去的文字经过 `secretGuard`（装了 [`dsh-plugin-secret-guard`](../secret-guard) 时）打码。

## 配置

```yaml
- id: discord
  name: dsh-plugin-discord-bridge/discord
  config:
    token: ''              # bot token；留空就读环境变量 DISCORD_TOKEN
    ownerId: '123…'        # 只处理这个用户的消息和按钮
    ownerName: 用户         # 「XX 选了」里显示的名字
    channels: ['…']        # 监听的频道/帖子；lobby 开出来的帖子会自动加进来
    lobbies: []            # 大厅频道（只收会话命令）
    apiPort: 8796          # 本地接口端口（只监听 127.0.0.1）
    apiTokenFile: ''       # 本地接口的 bearer token 文件；默认 <状态目录>/api_token，没有就生成
    agentBots:             # 可选：一个 agent 一个 bot，值是 secret-vault 里的引用
      cc: bots/cc-token
- id: threads
  name: dsh-plugin-discord-bridge/threads
  config:
    defaultEngine: dsh     # 新帖子的默认引擎：dsh / cc / codex
    provider: deepseek-official
    model: deepseek-flash  # dsh 引擎用的模型
    cwd: ~                 # 默认工作目录（lobby 接回的会话用它自己的目录）
    ownerName: 用户
    extraHint: ''          # 每轮附加给 CC/Codex 的说明，{channelId} 换成帖子 ID
    syncCodexAgents: false # true：把 ~/.claude/CLAUDE.md 同步成 Codex 的 ~/.codex/AGENTS.md
- id: lobby
  name: dsh-plugin-discord-bridge/lobby
  config:
    parent: '…'            # 新帖开在哪个频道下（论坛频道开论坛帖，文字频道开公开帖）
    cwd: ~                 # /cc /codex 新会话的工作目录
```

状态目录：环境变量 `DSH_DISCORD_STATE`，默认 `~/.dsh-discord/state`。`status.json` 里写着监听的频道列表，别的程序可以据此避让。

斜杠命令要自己用 Discord API 注册（同名命令会被转成手打文字处理）。

## 致谢

常驻 Claude Code / Codex 会话、帖子 ↔ agent 的桥接方式参考了 [cc-connect](https://github.com/chenhg5/cc-connect)（MIT）。

## 许可

MIT
