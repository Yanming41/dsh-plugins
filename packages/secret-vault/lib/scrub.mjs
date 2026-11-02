// 打码：把文本里出现的密钥换成占位符。两层：
//   1. 保险柜里已存的值：Rabin-Karp 滚动哈希索引（内存里只有哈希和长度，不留明文）。哈希命中后由 confirm(ref, 片段)
//      解密那一条做精确比较，所以哈希碰撞不会误打码。换成 [secret:引用名]。
//   2. 没登记的密钥：@sanity-labs/secret-scan（1100+ 条 TruffleHog 规则，按格式认 ghp_ / sk- / JWT 之类）兜底，
//      换成 [secret:unregistered:规则名]。普通密码没有固定格式，这一层认不出来。
import { scan } from '@sanity-labs/secret-scan';

const MOD = 1_000_000_007;
const BASE = 257;
const MIN_LEN = 6; // 太短的值（比如 1234）会误伤正常文字，不参与

// 除了原值，还登记几种常见编码，防止「先编码再打印」把值带出去
export const VARIANTS = {
  raw: (v) => v,
  base64: (v) => Buffer.from(v, 'utf8').toString('base64'),
  base64url: (v) => Buffer.from(v, 'utf8').toString('base64url'),
  url: (v) => encodeURIComponent(v),
  hex: (v) => Buffer.from(v, 'utf8').toString('hex'),
};

function hashOf(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * BASE + s.charCodeAt(i)) % MOD;
  return h;
}

export class Scrubber {
  constructor({ confirm, rules = true } = {}) {
    this.confirm = confirm; // (ref, candidate, variant) => boolean，variant 是 VARIANTS 的键
    this.rules = rules;
    this.byLen = new Map(); // 长度 → Map(哈希 → Set("ref\0variant"))
  }

  /** 登记一个值（只记各编码形式的长度和哈希）。同一个 ref 重复登记会先去掉旧的 */
  add(ref, value) {
    this.remove(ref);
    if (typeof value !== 'string' || value.length < MIN_LEN) return;
    for (const [variant, fn] of Object.entries(VARIANTS)) {
      const form = fn(value);
      if (variant !== 'raw' && form === value) continue;
      const L = form.length;
      if (!this.byLen.has(L)) this.byLen.set(L, new Map());
      const m = this.byLen.get(L);
      const h = hashOf(form);
      if (!m.has(h)) m.set(h, new Set());
      m.get(h).add(`${ref}\0${variant}`);
    }
  }

  remove(ref) {
    for (const [L, m] of this.byLen) {
      for (const [h, keys] of m) {
        for (const k of keys) if (k.startsWith(`${ref}\0`)) keys.delete(k);
        if (!keys.size) m.delete(h);
      }
      if (!m.size) this.byLen.delete(L);
    }
  }

  /** 找出已登记值出现的位置：[{start, end, ref}]，长的优先、不重叠 */
  #findRegistered(text) {
    const hits = [];
    for (const [L, m] of [...this.byLen].sort((a, b) => b[0] - a[0])) {
      if (text.length < L) continue;
      let pow = 1;
      for (let i = 1; i < L; i++) pow = (pow * BASE) % MOD;
      let h = 0;
      for (let i = 0; i < L; i++) h = (h * BASE + text.charCodeAt(i)) % MOD;
      for (let i = 0; ; i++) {
        const keys = m.get(h);
        if (keys) {
          const piece = text.slice(i, i + L);
          for (const k of keys) {
            const [ref, variant] = k.split('\0');
            if (this.confirm(ref, piece, variant)) { hits.push({ start: i, end: i + L, label: variant === 'raw' ? ref : `${ref}:${variant}` }); break; }
          }
        }
        if (i + L >= text.length) break;
        h = (h - (text.charCodeAt(i) * pow) % MOD + MOD) % MOD;
        h = (h * BASE + text.charCodeAt(i + L)) % MOD;
      }
    }
    return hits;
  }

  scrub(input) {
    const text = String(input ?? '');
    const hits = this.#findRegistered(text);
    if (this.rules) {
      for (const s of scan(text)) hits.push({ start: s.start, end: s.end, label: `unregistered:${s.rule}` });
    }
    // 先到先得（已登记的排在前面），去掉重叠，再从后往前替换
    const taken = [];
    for (const h of hits) if (!taken.some((t) => h.start < t.end && t.start < h.end)) taken.push(h);
    taken.sort((a, b) => b.start - a.start);
    let out = text;
    for (const t of taken) out = `${out.slice(0, t.start)}[secret:${t.label}]${out.slice(t.end)}`;
    return out;
  }
}
