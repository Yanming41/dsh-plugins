# dsh-plugin-secret-vault

DeepSeek Harness 的加密密钥保险柜：**模型按引用名使用密码 / token，永远看不到值**；缺值时发一次性链接，在手机或 Mac 上填写。

## 和市场上其它插件的区别

| | secret-vault | dsh-vault | dsh-secret-paste | dsh-secret-form |
|---|---|---|---|---|
| 加密存储 | AES-256-GCM + DPAPI | AES-256-GCM + 主密码 | 明文 0600 | 明文 0600 |
| 模型能读明文 | **不能**（没有读值工具） | 能（vault_get / vault_fill） | 能（secret_resolve） | 不能 |
| 远程录入 | 一次性链接 | 设置页 | 粘贴 | 一次性链接 |

## 工作方式

- **存储**：`~/.dsh-secret-vault/vault.json`。每条记录 = 摘要（引用名、标题、账号、网址、标签，用来搜索）+ 密文。密文用 AES-256-GCM，每条独立 IV，AAD 绑定引用名。数据密钥由 `keyProtector` 保护。
- **录入**：`secret_request` 开一次性表单（默认 5 分钟、只能提交一次），提交的值直接加密入库，调用方只拿到状态和长度。
- **使用**：模型的工具里没有任何一个返回值：
  - `secret_search` 搜摘要；`secret_request` / `_status` / `_cancel` 管录入表单；
  - `secret_fill` 把值填到别处，三种 `mode`：
    - `web`：CDP `Input.insertText` 插入浏览器标签页里**当前聚焦的任意元素**（不限密码框；可给 `selector` 先 focus）；
    - `clipboard`：受保护剪贴板（`ExcludeClipboardContentFromMonitorProcessing`、不进剪贴板历史、不上云），默认 Ctrl+V 粘贴到前台窗口后立刻清空，`paste:false` 留给人手动粘贴、几秒后清空；
    - `autotype`：KeePass 式 `SendInput` Unicode 模拟打字，不碰剪贴板；
    - 桌面两种模式可给 `window`（标题片段）先切前台；Windows 锁屏时会直接报错（锁屏下按键送不到任何窗口）。
  - `secret_exec` 把值作为环境变量注入命令（`env: {变量名: 引用名}`），输出打码后返回。
- **打码**：`ctx.secretVault.scrub(text)`。已存的值用 Rabin-Karp 滚动哈希找（内存里只有哈希，命中后解密那一条精确比对），原值以及 base64 / base64url / URL / hex 编码形式都换成 `[secret:引用名(:编码)]`；没登记但像密钥的，用 `@sanity-labs/secret-scan` 的 1100+ 条规则兜底换成 `[secret:unregistered:规则名]`。短于 6 个字符的值不参与。
- **局限**：`secret_exec` 里命令拿得到值，刻意变形（逐字符打印、加密）后的输出打码拦不住；需要时把 `execPolicy` 设成 `allowlist`。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `dir` | `~/.dsh-secret-vault` | 数据目录 |
| `keyProtector` | Windows `dpapi`，其它 `file` | `dpapi`：绑定 Windows 账户；`file`：0600 密钥文件 |
| `formServer` | `own` | `own`：自己开端口；`dsh`：挂到 dsh 的 webServer |
| `host` / `port` | `127.0.0.1` / `8799` | 表单端口（`own` 时） |
| `apiPort` | `8800` | 本机 API（只监听 127.0.0.1，Bearer token 在 `dir/api_token`）；`0` 关闭 |
| `publicUrl` | 空 | 链接用的外部地址，比如 `tailscale serve` 给的 `https://机器名.ts.net:8443` |
| `linkDelivery` | `auto` | `auto`：插件直接把链接发到帖子，不经过模型；`model`：链接返回给模型转发 |
| `notifier` | `{kind:'discord'}` | `discord`：用 Cordis 的 `discord` 服务；`http`：`{kind,url,tokenFile}`，POST `{channelId,text}` |
| `defaultTtlSeconds` | `300` | 链接有效期（30~3600） |
| `scanRules` | `true` | 打码时用规则库兜底认没登记的密钥 |
| `cdpUrl` | `http://127.0.0.1:9223` | `secret_fill` web 模式连的浏览器调试端口 |
| `desktopFill` | `clipboard` | 桌面默认填法：`clipboard` / `autotype` |
| `clipboardClearSec` | `10` | `paste:false` 时剪贴板多久后清空 |
| `execShell` | Windows `powershell`，其它 `bash` | `powershell` / `cmd` / `bash` / `sh` |
| `execPolicy` / `execAllow` | `any` / `[]` | `allowlist` 时只允许匹配这些正则的命令 |
| `execTimeoutSec` / `execMaxOutput` | `120` / `20000` | 超时和输出上限 |

## 手机 / Mac 打开链接

表单只监听本机，用 Tailscale 暴露给自己的设备（只有 tailnet 内能访问）：

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8799
```

再把 `publicUrl` 设成 `https://<机器名>.ts.net:8443`。

## 本机 API

`Authorization: Bearer <dir/api_token>`：

- `GET /api/search?q=关键词`
- `POST /api/request` `{ref, title, kind, username, url, description, multiline, ttlSeconds, channelId, delivery}`
- `GET /api/request/<id>?wait=秒`
- `POST /api/request/<id>/cancel`
- `POST /api/fill` `{ref, mode, tab, selector, window, paste, enterForNewline}`
- `POST /api/exec` `{command, env, cwd, timeoutSec}`
- `POST /api/put` `{ref, value, title, kind, username, url, tags, notes}`：写入（导入用），只返回摘要
- `POST /api/copy` `{from, to, meta}`：在进程内复制值（比如通用密码登录成功后建站点条目）
- `POST /api/meta` `{ref, ...摘要字段}`：只改摘要

没有读取值的接口。

## 同机其它进程直接读

同一台机器、同一个系统用户下的其它程序（比如浏览器自动化、Discord 桥接）可以用只读入口在自己进程里解密，值不经过任何接口：

```js
import { openVault } from 'dsh-plugin-secret-vault/reader';
const vault = openVault();               // 默认 ~/.dsh-secret-vault，Windows 用 DPAPI
await vault.use('bots/cc-token', (token) => client.login(token));
```

每次调用都重新读文件，能拿到 dsh 那边的最新写入；写入请走上面的本机 API，避免两个进程同时写同一个文件。
