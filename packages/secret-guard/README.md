# dsh-plugin-secret-guard

DeepSeek Harness 的密钥泄漏守卫：在文本进入**会话日志、模型上下文、系统提示词、遥测**以及**发往外部**之前打码。
单独装就能用（规则库认格式化的密钥）；和 [secret-vault](../secret-vault) 一起装，连你自己存过的普通密码也能精确认出来。

## 为什么守入口

dsh 发给模型的请求是会话日志算出来的（`llm/stream` 拿到的是冻结对象，不许改写）。所以守住**进日志的每个入口**：
进来的全是打过码的，模型从头到尾没见过明文，它自己的回复和工具调用参数也就带不出明文。

| 钩子 | 管什么 | 开关 `hooks.*` |
|---|---|---|
| `agent/pre-step` | 用户消息（含粘贴进来的密钥） | `userInput` |
| `tools/post-execute` | 工具结果 | `toolOutput` |
| `tools/ptc-dispatch-log` | `run_code` 子调用的日志副本 | `ptcLog` |
| `system-prompt/assemble` | 系统提示词（instructions 文件里写了密钥也拦） | `systemPrompt` |
| `session-telemetry/record` | 导出的遥测记录 | `telemetry` |

出口：插件提供 `secretGuard` 服务，发消息、写日志的插件自己接上：

```js
const scrub = (text) => ctx.get('secretGuard', false)?.scrub(text) ?? text;
await channel.send(scrub(text));
```

## 和 dsh-secret-scrub 的区别

| | secret-guard | dsh-secret-scrub |
|---|---|---|
| 认格式化密钥（ghp_ / sk- / AKIA / JWT …） | 1100+ 条规则（@sanity-labs/secret-scan） | 内置分级规则 |
| 认你自己存的普通密码 | 配 secret-vault 时精确比对（含 base64 / hex / URL 编码形式） | 认不出 |
| 系统提示词、遥测 | 管 | 不管 |
| 出口（Discord 等） | 提供 `scrub` 服务 | 不管 |

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `vault` | `auto` | `auto`：有 `secretVault` 服务就用它精确认存过的值；`off`：只用规则 |
| `rules` | `true` | 规则库（接上保险柜时由保险柜那边跑，不重复） |
| `extra` | `[]` | 自定义正则 `[{ name, pattern }]`，命中换成 `[secret:custom:name]` |
| `hooks` | 全开 | 见上表，可单独关 |
| `log` | `true` | 打码时记一行（只记位置，不记内容） |

占位符：`[secret:引用名]`、`[secret:引用名:base64]`（保险柜里的值）、`[secret:unregistered:规则名]`、`[secret:custom:名字]`。

## 局限

- 打码是单向的，命中的位置模型只看到占位符。
- 刻意变形（逐字符拆开、自定义加密）后的值认不出来。
- 不经过 dsh 的程序（外部脚本、其它 agent 的上下文）管不到，需要它们自己调 `scrub`。
