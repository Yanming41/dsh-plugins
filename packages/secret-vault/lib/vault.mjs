// 加密存储：一个 vault.json，每条记录 = 摘要（明文，用来搜索）+ 密文（AES-256-GCM，每条独立随机 IV，AAD 绑定引用名，
// 密文不能被挪到别的引用名下）。摘要里绝不放密码类字段。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Scrubber, VARIANTS } from './scrub.mjs';

// 引用名：小写分段路径，比如 discord/password、bots/cc-token、site/discord.com
export const REF = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
export const assertRef = (ref) => {
  if (typeof ref !== 'string' || ref.length > 120 || !REF.test(ref)) throw new Error(`引用名不合法：${ref}（小写字母/数字/._-，用 / 分段）`);
  return ref;
};
const META_FIELDS = ['title', 'kind', 'username', 'url', 'tags', 'notes'];
export const KINDS = ['password', 'token', 'api-key', 'secret', 'note'];

export class Vault {
  constructor(file, key, { scanRules = true, scrub = true } = {}) {
    this.file = file;
    this.key = key;
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, entries: {} };
    this.queue = Promise.resolve();
    // 打码索引：启动时解密一遍只为算哈希，明文不留
    this.scrubber = new Scrubber({ rules: scanRules, confirm: (ref, piece, variant) => this.#matches(ref, piece, variant) });
    if (scrub) for (const ref of Object.keys(this.data.entries)) this.scrubber.add(ref, this.#decrypt(ref, this.data.entries[ref]));
  }

  #matches(ref, piece, variant = 'raw') {
    const e = this.data.entries[ref];
    return Boolean(e) && VARIANTS[variant](this.#decrypt(ref, e)) === piece;
  }

  #save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  #encrypt(ref, value) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(ref));
    const ct = Buffer.concat([c.update(JSON.stringify({ value }), 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
  }

  #decrypt(ref, e) {
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(e.iv, 'base64'));
    d.setAAD(Buffer.from(ref));
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(e.ct, 'base64')), d.final()]).toString('utf8')).value;
  }

  /** 摘要：给搜索和模型看的，不含密文 */
  summary(ref) {
    const e = this.data.entries[ref];
    if (!e) return null;
    const out = { ref };
    for (const k of META_FIELDS) if (e[k] !== undefined && e[k] !== '') out[k] = e[k];
    out.length = e.length;
    out.updatedAt = e.updatedAt;
    return out;
  }

  has(ref) { return Boolean(this.data.entries[ref]); }

  list() { return Object.keys(this.data.entries).sort().map((r) => this.summary(r)); }

  /** 关键词搜索摘要（空格分开的词全部命中，不分大小写） */
  search(query = '', limit = 20) {
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    return this.list().filter((s) => {
      const hay = [s.ref, s.title, s.kind, s.username, s.url, ...(s.tags ?? []), s.notes].filter(Boolean).join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    }).slice(0, limit);
  }

  /** 写入（新建或覆盖值）。meta 只接受摘要字段 */
  put(ref, value, meta = {}) {
    assertRef(ref);
    if (typeof value !== 'string' || !value) throw new Error('值不能为空');
    return (this.queue = this.queue.then(() => {
      const now = new Date().toISOString();
      const prev = this.data.entries[ref];
      const entry = { ...(prev ?? { createdAt: now }) };
      for (const k of META_FIELDS) if (meta[k] !== undefined) entry[k] = meta[k];
      if (entry.kind && !KINDS.includes(entry.kind)) entry.kind = 'secret';
      Object.assign(entry, this.#encrypt(ref, value), { length: value.length, updatedAt: now });
      this.data.entries[ref] = entry;
      this.#save();
      this.scrubber.add(ref, value);
      return this.summary(ref);
    }));
  }

  /** 只改摘要字段，不碰密文 */
  updateMeta(ref, meta) {
    return (this.queue = this.queue.then(() => {
      const e = this.data.entries[ref];
      if (!e) throw new Error(`没有这个引用名：${ref}`);
      for (const k of META_FIELDS) if (meta[k] !== undefined) e[k] = meta[k];
      e.updatedAt = new Date().toISOString();
      this.#save();
      return this.summary(ref);
    }));
  }

  remove(ref) {
    return (this.queue = this.queue.then(() => {
      const had = Boolean(this.data.entries[ref]);
      delete this.data.entries[ref];
      if (had) { this.#save(); this.scrubber.remove(ref); }
      return had;
    }));
  }

  /** 把 from 的值复制到 to（值不出这个进程）。用于「通用密码登录成功后建站点专属条目」 */
  copy(from, to, meta = {}) {
    const e = this.data.entries[from];
    if (!e) throw new Error(`没有这个引用名：${from}`);
    return this.put(to, this.#decrypt(from, e), meta);
  }

  /** 取明文交给回调用，用完不留。只给受信任的插件代码，不暴露成模型工具 */
  async use(ref, fn) {
    const e = this.data.entries[ref];
    if (!e) throw new Error(`没有这个引用名：${ref}`);
    let value = this.#decrypt(ref, e);
    try { return await fn(value); } finally { value = null; }
  }

  /** 打码：已存的值换成 [secret:引用名]，没登记但像密钥的换成 [secret:unregistered:规则名] */
  scrub(text) { return this.scrubber.scrub(text); }
}
