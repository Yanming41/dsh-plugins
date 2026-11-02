# dsh-plugins

[DeepSeek Harness（dsh）](https://github.com/deepseek-ai) 插件，每个都是一个可以单独安装的组合包（bundle）：

| 包 | 说明 |
|---|---|
| [`dsh-plugin-discord-bridge`](packages/discord-bridge) | 在 Discord 帖子里和 dsh / Claude Code / Codex 对话：一个 agent 一个 bot、@ 路由、工作区锁和排队、进度消息、选项/复制按钮、LaTeX 渲染、开帖和接回本机历史会话 |
| [`dsh-plugin-persistent-agents`](packages/persistent-agents) | 常驻 Claude Code / Codex 会话服务：续接、人工审批、中断、工具调用进度 |
| [`dsh-plugin-secret-vault`](packages/secret-vault) | 加密密钥保险柜：模型只按引用使用密钥、看不到明文；一次性链接从手机/Mac 填写 |
| [`dsh-plugin-secret-guard`](packages/secret-guard) | 密钥泄漏守卫：进日志、上下文、系统提示词、遥测、对外消息前打码 |

## 安装

在 dsh 网页的「插件 → 发现」里添加索引源：

```
https://yanming41.github.io/dsh-plugins/index.json
```

或者直接按 Git 地址安装某个包（见 dsh 插件管理器文档）。

## 致谢

persistent-agents 和 discord-bridge 的常驻会话、帖子 ↔ agent 桥接方式参考了 [cc-connect](https://github.com/chenhg5/cc-connect)（MIT）。

## 许可

MIT
