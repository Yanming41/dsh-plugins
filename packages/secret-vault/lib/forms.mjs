// 一次性录入表单：模型（或插件）要一个密码时开一张表单，链接里的随机令牌就是凭证。
// 链接 ttlSeconds 后过期、只能提交一次；提交的值直接加密进保险柜，调用方只能拿到状态和长度。
import { randomBytes, randomUUID } from 'node:crypto';

export const STATUS = { pending: 'pending', saved: 'saved', cancelled: 'cancelled', expired: 'expired' };
const clampTtl = (s, d) => Math.min(3600, Math.max(30, Number.isFinite(s) ? Math.round(s) : d));
const MAX_BODY = 64 * 1024;

export function createForms({ defaultTtlSeconds = 300, now = Date.now } = {}) {
  const byId = new Map();
  const byToken = new Map();
  const waiters = new Map(); // id → Set<resolve>

  const settleNow = (f) => {
    if (f.status === STATUS.pending && now() > f.expiresAt) f.status = STATUS.expired;
    if (f.status !== STATUS.pending) {
      for (const r of waiters.get(f.id) ?? []) r(f);
      waiters.delete(f.id);
    }
    return f;
  };
  const sweep = setInterval(() => {
    for (const f of byId.values()) {
      settleNow(f);
      if (f.status !== STATUS.pending && now() - f.expiresAt > 3600_000) { byId.delete(f.id); byToken.delete(f.token); }
    }
  }, 30_000);
  sweep.unref?.();

  return {
    create({ ref, title, kind = 'password', username, url, description, multiline = false, ttlSeconds }) {
      const f = {
        id: randomUUID(), token: randomBytes(24).toString('base64url'),
        ref, title: String(title || ref).slice(0, 80), kind, username, url,
        description: description ? String(description).slice(0, 300) : '', multiline: Boolean(multiline),
        status: STATUS.pending, createdAt: now(), expiresAt: now() + clampTtl(ttlSeconds, defaultTtlSeconds) * 1000,
      };
      byId.set(f.id, f);
      byToken.set(f.token, f);
      return f;
    },
    get: (id) => (byId.has(id) ? settleNow(byId.get(id)) : null),
    byToken: (t) => (byToken.has(t) ? settleNow(byToken.get(t)) : null),
    finish(f, status, extra = {}) {
      Object.assign(f, extra, { status, finishedAt: now() });
      settleNow(f);
    },
    /** 等表单离开 pending，最多 waitMs */
    wait(f, waitMs) {
      settleNow(f);
      if (f.status !== STATUS.pending || waitMs <= 0) return Promise.resolve(f);
      return new Promise((resolve) => {
        const set = waiters.get(f.id) ?? new Set();
        waiters.set(f.id, set);
        const done = () => { set.delete(resolve); resolve(settleNow(f)); };
        set.add(resolve);
        setTimeout(done, Math.min(waitMs, f.expiresAt - now() + 50)).unref?.();
      });
    },
    list: () => [...byId.values()].map(settleNow),
    dispose: () => clearInterval(sweep),
  };
}

/** 给调用方（模型/插件）看的结果：没有值，只有状态和长度 */
export const publicForm = (f) => ({
  id: f.id, ref: f.ref, title: f.title, status: f.status,
  expiresAt: new Date(f.expiresAt).toISOString(),
  ...(f.status === STATUS.saved ? { length: f.length } : {}),
});

// ---- 页面 ----
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STYLE = `:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--mute:#677086;--line:#d8dce5;--acc:#3b5bdb;--err:#c92a2a}
@media (prefers-color-scheme:dark){:root{--bg:#14161b;--card:#1d2027;--fg:#e8eaf0;--mute:#9aa2b5;--line:#343944;--acc:#748ffc;--err:#ff8787}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:440px;margin:0 auto;padding:32px 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:20px;margin:0 0 6px}p{color:var(--mute);margin:0 0 16px}.meta{font-size:14px;color:var(--mute);margin-bottom:14px;word-break:break-all}
label{display:block;font-size:14px;margin:12px 0 6px}input,textarea{width:100%;font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--fg)}
textarea{min-height:140px;font-family:ui-monospace,Consolas,monospace}.row{display:flex;gap:10px;margin-top:18px}
button{flex:1;font:inherit;padding:11px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg)}
button.go{background:var(--acc);border-color:var(--acc);color:#fff}.err{color:var(--err);font-size:14px;margin-top:10px}.show{font-size:14px;color:var(--mute);margin-top:8px;display:flex;gap:6px;align-items:center}
.show input{width:auto}`;
const page = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main><div class="card">${body}</div></main></body></html>`;

export function renderForm(f, actionPath, error = '') {
  const left = Math.max(0, Math.round((f.expiresAt - Date.now()) / 1000));
  const meta = [f.username && `账号：${esc(f.username)}`, f.url && `网址：${esc(f.url)}`, `保存为：${esc(f.ref)}`, `剩余 ${Math.ceil(left / 60)} 分钟，只能提交一次`].filter(Boolean).join('<br>');
  const input = f.multiline
    ? `<textarea name="value" autocomplete="off" spellcheck="false" required></textarea>`
    : `<input id="v" name="value" type="password" autocomplete="off" spellcheck="false" required>
       <label class="show"><input type="checkbox" onclick="document.getElementById('v').type=this.checked?'text':'password'">显示</label>`;
  return page(f.title, `<h1>${esc(f.title)}</h1>${f.description ? `<p>${esc(f.description)}</p>` : ''}<div class="meta">${meta}</div>
<form method="post" action="${esc(actionPath)}"><label>${f.kind === 'password' ? '密码' : '值'}</label>${input}
${error ? `<div class="err">${esc(error)}</div>` : ''}<div class="row"><button name="action" value="cancel" formnovalidate>取消</button><button class="go" name="action" value="save">加密保存</button></div></form>`);
}

const NOTICE = {
  saved: ['已加密保存', '可以关掉这个页面了。值不会显示给模型。'],
  cancelled: ['已取消', '什么都没有保存。'],
  expired: ['链接已过期', '请让它重新发一个链接。'],
  unknown: ['链接无效', '这个链接不存在或已经用过了。'],
};
export const renderNotice = (k) => page(NOTICE[k][0], `<h1>${NOTICE[k][0]}</h1><p>${NOTICE[k][1]}</p>`);

const HEADERS = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};
const send = (res, status, html) => { res.writeHead(status, { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); };

async function readBody(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** 表单路由：GET /<prefix>/<token> 显示，POST 提交。onSave(f, value) 负责加密存储 */
export function createFormHandler({ forms, prefix, onSave, logger }) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith(`${prefix}/`)) return false;
    const token = url.pathname.slice(prefix.length + 1);
    const f = /^[\w-]{20,64}$/.test(token) ? forms.byToken(token) : null;
    if (!f) { send(res, 404, renderNotice('unknown')); return true; }
    if (f.status !== STATUS.pending) { send(res, 410, renderNotice(f.status === STATUS.saved ? 'unknown' : f.status)); return true; }
    if (req.method === 'GET' || req.method === 'HEAD') { send(res, 200, renderForm(f, url.pathname)); return true; }
    if (req.method !== 'POST') { send(res, 405, renderNotice('unknown')); return true; }
    let body;
    try { body = await readBody(req); } catch (e) { send(res, e.status ?? 400, renderNotice('unknown')); return true; }
    if (body.get('action') === 'cancel') { forms.finish(f, STATUS.cancelled); send(res, 200, renderNotice('cancelled')); return true; }
    let value = body.get('value') ?? '';
    if (!f.multiline) value = value.trim();
    if (!value) { send(res, 422, renderForm(f, url.pathname, '不能为空')); return true; }
    try {
      await onSave(f, value);
    } catch (e) {
      logger?.warn?.(`secret-vault: 保存 ${f.ref} 失败 ${e.message}`);
      send(res, 500, renderForm(f, url.pathname, `保存失败：${String(e.message).slice(0, 200)}`));
      return true;
    }
    forms.finish(f, STATUS.saved, { length: value.length });
    value = null;
    logger?.info?.(`secret-vault: 表单 ${f.id.slice(0, 8)} 已保存到 ${f.ref}`);
    send(res, 200, renderNotice('saved'));
    return true;
  };
}
