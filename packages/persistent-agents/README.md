# dsh-plugin-persistent-agents

DeepSeek Harness（dsh）插件：给任意前端（Discord 桥接、网页等）提供**常驻**的 Claude Code / Codex 会话。

和官方 `dsh-subagent-claude-code` / `dsh-subagent-codex` 的区别：官方包每次委派起一个一次性进程、无人值守；
本插件一个对话一个常驻进程，可续接、审批交给人、能中断，适合人长期对话。

## 工作方式

- **Claude Code**：`claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`，
  消息、权限审批（`control_request` / `control_response`）、中断都走同一条 stdio 流。
- **Codex**：`codex app-server`（stdio 上的 JSON-RPC）：`initialize` → `thread/start|resume` → `turn/start`，
  审批是服务端请求 `item/*/requestApproval`，中断是 `turn/interrupt`。
- 会话进程由独立的会话服务（`lib/server.mjs`，只监听 127.0.0.1）管理。插件载入时服务没在跑就自动拉起（detached），
  所以 dsh 热重载 / 重启不会打断会话；插件卸载只断开连接。服务在 `exitIdleMin` 分钟内没有会话也没有插件连着会自己退出；
  `stopOnDispose: true` 则卸载插件时一并关掉。
- 插件和服务之间：HTTP + SSE 事件流，事件带序号，插件重载后补发漏掉的事件。token 自动生成在 `stateDir/token`。

需要本机已安装并登录 `claude`（`~/.local/bin/claude.exe` 或 npm 全局 `@anthropic-ai/claude-code`）和/或 npm 全局 `@openai/codex`。

## 配置

```yaml
- name: dsh-plugin-persistent-agents
  config:
    port: 8797
    window: false        # Windows：在可见终端窗口里跑服务
    stopOnDispose: false
    idleMin: 60          # 会话空闲多久关进程（下次自动续接）
    turnMin: 30          # 一轮最长
    exitIdleMin: 30      # 服务无人使用多久自己退出，0 = 一直跑
    cwd: ~               # 新会话默认工作目录
```

## 服务 `ctx.persistentAgents`

| 方法 | 说明 |
|---|---|
| `start({ engine: 'cc'\|'codex', channelId, prompt, sessionId?, cwd? })` | 发一条消息，结果从 `onResult` 回来 |
| `stop(channelId)` | 中断这一轮 |
| `close(channelId)` | 关掉这个对话的进程 |
| `answer(id, allow)` | 答复审批 |
| `pending()` / `status()` | 正在跑的对话 / 服务状态 |
| `onResult(fn(job, {text, error, sessionId, interrupted}))` | 一轮结束 |
| `onPermission(fn({id, channelId, engine, tool, input}))` | 需要审批 |
| `onSession(fn({channelId, engine, sessionId}))` | 拿到会话 ID（存起来，下次 `start` 传回去就能续接） |

端到端测试（会真的调用 claude / codex）：`node e2e.mjs cc`、`node e2e.mjs codex`。

## 致谢

常驻会话的做法参考了 [cc-connect](https://github.com/chenhg5/cc-connect)（chenhg5，MIT License）：一个对话一个常驻进程、消息写进 stdin、引擎和聊天平台分离、会话按帖子隔离。本包是用 JavaScript 按同样思路重写的 Cordis 插件，没有直接复制它的代码。
