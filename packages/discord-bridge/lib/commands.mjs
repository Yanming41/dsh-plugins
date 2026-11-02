// threads 和 lobby 两个插件共用的命令定义（放这里，免得两个插件互相 import）。

// lobby 插件处理的命令；threads 插件见到就跳过
export const LOBBY_COMMAND = /^\/(cc|codex|sessions|codex-sessions|resume|codex-resume|list)(?:\s|$)/;

export const HELP = [
  '**帖子里**',
  '• 直接发消息 → 交给当前引擎；@CC / @Codex / @DS-Agent 指定谁来做，之后它就是默认',
  '• `/agent [dsh|cc|codex]` 看/换引擎（会补上切换期间的对话）',
  '• `/stop` 中止正在跑的一轮（排队的一起清掉）　`/new`（`/clear`）开新会话　`/end` 关掉进程（记录保留）　`/screen` 看现在在干嘛',
  '• `/model 名字`　`/effort low|medium|high`　`/mode plan|accept|auto|default`（CC / Codex）',
  '• `/compact`　`/context`　`/cost`（Claude Code 自带命令）',
  '• 忙的时候发的消息会排队，前一轮结束自动发；消息上 👀 收到 → ⏳ 在跑 → ✅ 完成；只有最终回复会推送通知',
  '**开帖 / 接回会话**（主频道或任意 dsh 帖子里发）',
  '• `/cc 标题`　`/codex 标题` 开新帖',
  '• `/sessions` + `/resume 编号`、`/codex-sessions` + `/codex-resume 编号` 接回电脑上的历史会话（标 ⚠️ 的加 `!`）',
  '• `/list` 看已绑定的帖子',
].join('\n');
