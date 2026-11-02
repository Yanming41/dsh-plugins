// dsh 插件 secret-vault：加密保管密码 / token，让 LLM「按引用名使用、看不到值」。提供 ctx.secretVault。
//
// 存储：AES-256-GCM 加密的 vault.json，数据密钥由 DPAPI（Windows）或 0600 密钥文件保护（keyProtector）。
// 录入：缺值时开一次性表单（secret_request），链接自动发到帖子（linkDelivery=auto）或交给模型转发（model）；
//       表单页挂在自己的端口（formServer=own，配合 tailscale serve 给手机/Mac 打开）或 dsh 的 Web 服务（formServer=dsh）。
// 使用：模型只有搜索摘要、要求录入、查录入状态这几个工具，没有任何读明文的工具；
//       填网页/软件、注入环境变量由受信任的代码通过 use() 完成（第 2 阶段）。
// 非 Cordis 的调用方（Claude Code、tars）走本机 API 端口（apiPort，只监听 127.0.0.1，要 Bearer token）。
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadDataKey } from './keyring.mjs';
import { Vault, assertRef, KINDS } from './vault.mjs';
import { createFormHandler, createForms, publicForm } from './forms.mjs';
import { execWithSecrets } from './exec.mjs';
import { fillSecret } from './fill.mjs';

export const name = 'secret-vault';

export const defaults = {
  dir: path.join(os.homedir(), '.dsh-secret-vault'),
  keyProtector: process.platform === 'win32' ? 'dpapi' : 'file', // dpapi | file
  formServer: 'own',        // own：自己开 HTTP 端口；dsh：挂到 dsh 的 webServer
  host: '127.0.0.1',
  port: 8799,               // 表单端口（formServer=own）
  apiPort: 8800,            // 本机 API 端口，0 = 不开
  routePrefix: '/secret',
  publicUrl: '',            // 链接用的外部地址，比如 https://机器名.ts.net；空 = 用 http://host:port
  linkDelivery: 'auto',     // auto：插件直接发到帖子，链接不经过模型；model：把链接交给模型转发
  notifier: { kind: 'discord' }, // discord：用 Cordis 的 discord 服务 send(channelId, text)；http：{kind,url,tokenFile} POST {channelId,text}
  defaultTtlSeconds: 300,
  scanRules: true,          // 打码时用 1100+ 条规则兜底认没登记的密钥
  cdpUrl: 'http://127.0.0.1:9223', // secret_fill web 模式连的浏览器
  desktopFill: 'clipboard', // 桌面软件默认填法：clipboard（受保护剪贴板+粘贴）| autotype（KeePass 式模拟打字）
  clipboardClearSec: 10,    // paste=false 时剪贴板多久后清空
  execShell: process.platform === 'win32' ? 'powershell' : 'bash', // powershell | cmd | bash | sh
  execPolicy: 'any',        // any | allowlist
  execAllow: [],            // execPolicy=allowlist 时允许的命令（正则）
  execTimeoutSec: 120,
  execMaxOutput: 20000,
};

const readOrCreateToken = (file) => {
  if (!existsSync(file)) writeFileSync(file, randomBytes(24).toString('hex'), { mode: 0o600 });
  return readFileSync(file, 'utf8').trim();
};

export async function apply(ctx, options = {}) {
  const config = { ...defaults, ...options, notifier: { ...defaults.notifier, ...options.notifier } };
  mkdirSync(config.dir, { recursive: true });
  const vault = new Vault(path.join(config.dir, 'vault.json'), await loadDataKey(config.dir, config.keyProtector), { scanRules: config.scanRules });
  const execConfig = { shell: config.execShell, policy: config.execPolicy, allow: config.execAllow, timeoutSec: config.execTimeoutSec, maxOutput: config.execMaxOutput };
  const forms = createForms({ defaultTtlSeconds: config.defaultTtlSeconds });
  ctx.effect(() => () => forms.dispose());
  const log = ctx.logger ?? console;

  // ---- 表单页 ----
  const formHandler = createFormHandler({
    forms, prefix: config.routePrefix, logger: log,
    onSave: (f, value) => vault.put(f.ref, value, { title: f.title, kind: f.kind, username: f.username, url: f.url }),
  });
  const origin = () => config.publicUrl.replace(/\/+$/, '') || (config.formServer === 'dsh' ? ctx.get('webServer', false)?.getOrigin?.() : `http://${config.host}:${config.port}`);

  const listen = (port, handler, label) => ctx.effect(() => {
    const server = http.createServer(async (req, res) => {
      try {
        if (!(await handler(req, res))) { res.writeHead(404); res.end(); }
      } catch (e) {
        log.error?.(`secret-vault ${label}: ${e?.stack || e}`);
        if (!res.headersSent) { res.writeHead(500); res.end(); }
      }
    });
    server.on('error', (e) => log.error?.(`secret-vault: ${label} 端口 ${port} 起不来 ${e.message}`));
    server.listen(port, config.host);
    return () => { server.close(); server.closeAllConnections(); };
  });

  if (config.formServer === 'own') listen(config.port, formHandler, '表单');
  else if (config.formServer === 'dsh') {
    ctx.inject(['webServer'], (c) => {
      c.effect(() => c.webServer.register({ kind: 'prefix', path: config.routePrefix, handler: async (req, res) => { if (!(await formHandler(req, res))) { res.writeHead(404); res.end(); } } }));
    });
  } else throw new Error(`未知的 formServer：${config.formServer}`);

  // ---- 发链接 ----
  async function deliver(channelId, text) {
    const n = config.notifier;
    if (n.kind === 'discord') {
      const discord = ctx.get('discord', false);
      if (!discord?.send) throw new Error('没有 discord 服务');
      await discord.send(channelId, text);
    } else if (n.kind === 'http') {
      const token = n.tokenFile ? readFileSync(n.tokenFile, 'utf8').trim() : '';
      const r = await fetch(n.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ channelId, text }) });
      if (!r.ok) throw new Error(`notifier HTTP ${r.status}`);
    } else throw new Error(`未知的 notifier：${n.kind}`);
  }

  // ---- 对外接口 ----
  const service = {
    kinds: KINDS,
    /** 搜索摘要（不含值） */
    search: (query, limit) => vault.search(query, limit),
    list: () => vault.list(),
    has: (ref) => vault.has(ref),
    describe: (ref) => vault.summary(ref),
    /** 开一次性录入表单。delivery 不传就用配置的 linkDelivery；auto 发成功时不返回链接 */
    async request({ ref, title, kind = 'password', username, url, description, multiline, ttlSeconds, channelId, delivery = config.linkDelivery }) {
      assertRef(ref);
      const f = forms.create({ ref, title, kind: KINDS.includes(kind) ? kind : 'secret', username, url, description, multiline, ttlSeconds });
      const link = `${origin()}${config.routePrefix}/${f.token}`;
      const out = publicForm(f);
      if (delivery === 'auto' && channelId) {
        try {
          const mins = Math.round((f.expiresAt - Date.now()) / 60000);
          await deliver(String(channelId), `🔐 需要你填写「${f.title}」${username ? `（账号 ${username}）` : ''}\n${link}\n${mins} 分钟内有效，只能用一次；填的内容直接加密保存，不经过聊天和模型。`);
          return { ...out, delivered: true };
        } catch (e) {
          log.warn?.(`secret-vault: 链接自动发送失败，改为返回给调用方：${e.message}`);
          return { ...out, delivered: false, deliveryError: e.message, url: link };
        }
      }
      return { ...out, delivered: false, url: link };
    },
    /** 录入状态；waitSeconds>0 时等它离开 pending */
    async requestStatus(id, waitSeconds = 0) {
      const f = forms.get(id);
      if (!f) throw new Error('没有这个表单（可能服务重启过）');
      return publicForm(await forms.wait(f, Math.min(600, Math.max(0, waitSeconds)) * 1000));
    },
    cancelRequest(id) {
      const f = forms.get(id);
      if (!f) throw new Error('没有这个表单');
      if (f.status === 'pending') forms.finish(f, 'cancelled');
      return publicForm(f);
    },
    /** 把值填到网页（web）或桌面软件（clipboard / autotype），值不返回 */
    fill: (opts) => (assertRef(opts.ref), fillSecret(vault, opts, { cdpUrl: config.cdpUrl, desktopFill: config.desktopFill, clipboardClearSec: config.clipboardClearSec })),
    /** 带密钥环境变量跑命令，输出打码 */
    exec: (opts) => execWithSecrets(vault, opts, execConfig),
    // 以下只给受信任的插件代码，不做成模型工具
    put: (ref, value, meta) => vault.put(ref, value, meta),
    updateMeta: (ref, meta) => vault.updateMeta(ref, meta),
    copy: (from, to, meta) => vault.copy(from, to, meta),
    remove: (ref) => vault.remove(ref),
    use: (ref, fn) => vault.use(ref, fn),
    /** 打码兜底：已存的值换成 [secret:引用名]；没登记但像密钥的（按规则库）换成 [secret:unregistered:规则名] */
    scrub: (text) => vault.scrub(text),
  };
  ctx.provide('secretVault', service);

  // ---- 模型工具（宿主有 tools 服务时才注册，比如 dsh） ----
  ctx.inject(['tools'], (c) => registerTools(c, service));

  // ---- 本机 API（Claude Code / tars 这类非 Cordis 调用方） ----
  if (config.apiPort) {
    const apiToken = readOrCreateToken(path.join(config.dir, 'api_token'));
    listen(config.apiPort, async (req, res) => {
      const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); return true; };
      if (req.headers.origin || req.headers.authorization !== `Bearer ${apiToken}`) return json(401, { error: 'unauthorized' });
      const url = new URL(req.url ?? '/', 'http://x');
      const body = async () => { let s = ''; for await (const c of req) { s += c; if (s.length > 16384) throw new Error('too large'); } return s ? JSON.parse(s) : {}; };
      try {
        if (req.method === 'GET' && url.pathname === '/api/search') return json(200, service.search(url.searchParams.get('q') ?? '', Number(url.searchParams.get('limit')) || 20));
        if (req.method === 'POST' && url.pathname === '/api/request') return json(200, await service.request(await body()));
        if (req.method === 'POST' && url.pathname === '/api/fill') return json(200, await service.fill(await body()));
        if (req.method === 'POST' && url.pathname === '/api/exec') return json(200, await service.exec(await body()));
        // 写入类：值只进不出（put 收值、copy 在进程内复制），返回的都是摘要
        if (req.method === 'POST' && url.pathname === '/api/put') { const b = await body(); const { ref, value, ...meta } = b; return json(200, await service.put(ref, value, meta)); }
        if (req.method === 'POST' && url.pathname === '/api/copy') { const b = await body(); return json(200, await service.copy(b.from, b.to, b.meta ?? {})); }
        if (req.method === 'POST' && url.pathname === '/api/meta') { const b = await body(); const { ref, ...meta } = b; return json(200, await service.updateMeta(ref, meta)); }
        let m = url.pathname.match(/^\/api\/request\/([\w-]+)$/);
        if (req.method === 'GET' && m) return json(200, await service.requestStatus(m[1], Number(url.searchParams.get('wait')) || 0));
        m = url.pathname.match(/^\/api\/request\/([\w-]+)\/cancel$/);
        if (req.method === 'POST' && m) return json(200, service.cancelRequest(m[1]));
        return json(404, { error: 'not found' });
      } catch (e) {
        return json(400, { error: e.message });
      }
    }, 'API');
  }
}

export function registerTools(ctx, service) {
  const out = { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] };
  ctx.tools.register({
    name: 'secret_search',
    description: '在密钥保险柜里按关键词搜索已保存的密码 / token。只返回摘要（引用名 ref、标题、账号、网址、标签、长度），永远不返回值。找到 ref 后交给填写/执行类工具使用，或者告诉用户。',
    parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', description: '空格分开的关键词，全部命中；空字符串列出全部' }, limit: { type: 'integer' } }, required: ['query'] },
    output: out,
    execute: (a) => service.search(a.query, a.limit),
  });
  ctx.tools.register({
    name: 'secret_request',
    description: '保险柜里没有需要的密码 / token 时，开一个一次性录入表单让用户填写，而不是让用户把密码打在聊天里。给了 channelId 且配置为自动发送时，链接由插件直接发到那个帖子，你拿不到链接，只需告诉用户去点；否则会返回 url，原样转给用户。之后用 secret_request_status 查是否已保存。值永远不会返回给你。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        ref: { type: 'string', description: '保存用的引用名，小写分段，比如 discord/password、bots/cc-token、site/example.com' },
        title: { type: 'string', description: '给用户看的标题，几个字' },
        kind: { type: 'string', enum: KINDS },
        username: { type: 'string', description: '相关账号（会显示在表单上并存进摘要）' },
        url: { type: 'string', description: '相关网址' },
        description: { type: 'string', description: '一两句说明这是做什么用的' },
        multiline: { type: 'boolean', description: '多行值（证书、私钥）用 true' },
        ttlSeconds: { type: 'integer', description: '有效期 30~3600 秒，默认 300' },
        channelId: { type: 'string', description: '要把链接发到的 Discord 帖子/频道 ID（知道就填）' },
      },
      required: ['ref', 'title'],
    },
    output: out,
    execute: (a) => service.request(a),
  });
  ctx.tools.register({
    name: 'secret_request_status',
    description: '查 secret_request 开的表单状态：pending / saved（带长度）/ cancelled / expired。waitSeconds>0 会等用户提交，最多那么多秒。',
    parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, waitSeconds: { type: 'integer' } }, required: ['id'] },
    output: out,
    execute: (a) => service.requestStatus(a.id, a.waitSeconds),
  });
  ctx.tools.register({
    name: 'secret_fill',
    description: '把保险柜里某个引用名的值填到别处，值不经过你。mode=web：插入到浏览器标签页里当前聚焦的元素（任意输入组件都行；先点一下要填的框，或者给 selector）；mode=clipboard：受保护剪贴板（不进剪贴板历史、不上云），默认粘贴到前台窗口后立刻清空；mode=autotype：模拟键盘逐字打进前台窗口。给 window（窗口标题片段）会先切到那个窗口。不填 mode 时：给了 tab/selector 就是 web，否则用配置的桌面默认方式。不会帮你提交表单。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        ref: { type: 'string' },
        mode: { type: 'string', enum: ['web', 'clipboard', 'autotype'] },
        tab: { type: 'string', description: 'web：标签页网址或标题里的关键字' },
        selector: { type: 'string', description: 'web：要先 focus 的元素 CSS 选择器（可选）' },
        window: { type: 'string', description: 'clipboard/autotype：先切到前台的窗口标题片段（可选）' },
        paste: { type: 'boolean', description: 'clipboard：true 自动 Ctrl+V 后清空（默认）；false 留给人手动粘贴，几秒后清空' },
        enterForNewline: { type: 'boolean', description: 'autotype：值里的换行按回车键发' },
      },
      required: ['ref'],
    },
    output: out,
    execute: (a) => service.fill(a),
  });
  ctx.tools.register({
    name: 'secret_exec',
    description: '跑一条命令，把保险柜里的值作为环境变量注入（env 写 {变量名: 引用名}），命令里用 $env:变量名（PowerShell）或 $变量名（bash）引用，不要把值写进命令。stdout/stderr 返回前会打码：出现的密钥值（含 base64/hex/URL 编码形式）都会变成 [secret:引用名]。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        command: { type: 'string' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: '{变量名: 引用名}' },
        cwd: { type: 'string' },
        timeoutSec: { type: 'integer' },
      },
      required: ['command'],
    },
    output: out,
    execute: (a) => service.exec(a),
  });
  ctx.tools.register({
    name: 'secret_request_cancel',
    description: '取消一个还没提交的录入表单，链接立即失效。',
    parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] },
    output: out,
    execute: (a) => service.cancelRequest(a.id),
  });
}
