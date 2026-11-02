// 本机的 Claude Code / Codex CLI 历史会话列表（从旧桥接 discord_bridge.mjs / codex_exec.mjs 搬来，只读文件头尾）。
import { open, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const RECENTLY_ACTIVE_MS = 5 * 60 * 1000; // 这么久内还在更新的会话，可能正开在别的终端里
const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');

async function readSlice(file, start, length) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}
const parseLines = (text) => text.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const cleanText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// claude --resume 要在会话"所属项目"的目录里跑才找得到它；会话中途可能 cd 过，记录里的 cwd
// 不一定是那个目录。所以在出现过的所有 cwd(和它们的上级目录)里，找名字能对上记录文件夹的那个。
function resolveSessionCwd(file, cwds) {
  const want = path.basename(path.dirname(file));
  for (const c of cwds) {
    for (let d = c; ; d = path.dirname(d)) {
      if (d.replace(/[^a-zA-Z0-9]/g, '-') === want) return d;
      if (path.dirname(d) === d) break;
    }
  }
  return null;
}

async function describeClaudeSession(file, size, mtimeMs) {
  const head = parseLines(await readSlice(file, 0, Math.min(size, 64 * 1024)));
  const tailStart = Math.max(0, size - 256 * 1024);
  const all = [...head, ...parseLines(await readSlice(file, tailStart, size - tailStart))];
  const latest = (type, key) => {
    for (let i = all.length - 1; i >= 0; i--) if (all[i].type === type && all[i][key]) return all[i][key];
    return null;
  };
  return {
    engine: 'cc',
    sessionId: path.basename(file, '.jsonl'),
    file,
    cwd: resolveSessionCwd(file, [...new Set(all.map((e) => e.cwd).filter(Boolean))]),
    title: latest('custom-title', 'customTitle') ?? latest('ai-title', 'aiTitle'),
    lastPrompt: latest('last-prompt', 'lastPrompt'),
    mtimeMs,
  };
}

export async function listClaudeSessions(limit = 10, dir = PROJECTS_DIR) {
  const files = [];
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    for (const f of await readdir(path.join(dir, d.name)).catch(() => [])) {
      if (!/^[0-9a-f-]{36}\.jsonl$/.test(f)) continue;
      const full = path.join(dir, d.name, f);
      const st = await stat(full).catch(() => null);
      if (st?.size) files.push({ file: full, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const d = await describeClaudeSession(f.file, f.size, f.mtimeMs).catch(() => null);
    if (d?.cwd && (d.title || d.lastPrompt)) out.push(d);
  }
  return out;
}

async function collectRollouts(dir, out) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectRollouts(full, out);
    else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) out.push(full);
  }
}

async function describeCodexSession(file, size, mtimeMs, titleIndex) {
  const tailStart = Math.max(0, size - 256 * 1024);
  const records = [
    ...parseLines(await readSlice(file, 0, Math.min(size, 256 * 1024))),
    ...(tailStart ? parseLines(await readSlice(file, tailStart, size - tailStart)) : []),
  ];
  const meta = records.find((e) => e.type === 'session_meta')?.payload;
  if (!meta?.id || !meta.cwd) return null;
  const prompts = records
    .filter((e) => e.type === 'event_msg' && e.payload?.type === 'user_message' && e.payload.message)
    .map((e) => cleanText(e.payload.message))
    .filter(Boolean);
  return {
    engine: 'codex',
    sessionId: meta.id,
    file,
    cwd: meta.cwd,
    title: titleIndex.get(meta.id) ?? prompts[0]?.slice(0, 80) ?? null,
    lastPrompt: prompts.at(-1) ?? null,
    mtimeMs,
  };
}

export async function listCodexSessions(limit = 10, codexHome = CODEX_HOME) {
  const files = [];
  await collectRollouts(path.join(codexHome, 'sessions'), files);
  const stats = (await Promise.all(files.map(async (file) => {
    const s = await stat(file).catch(() => null);
    return s?.size ? { file, size: s.size, mtimeMs: s.mtimeMs } : null;
  }))).filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const titleIndex = new Map();
  for (const row of parseLines(await readFile(path.join(codexHome, 'session_index.jsonl'), 'utf8').catch(() => ''))) {
    if (row.id && row.thread_name) titleIndex.set(row.id, row.thread_name);
  }
  const out = [];
  for (const item of stats.slice(0, Math.max(50, limit * 5))) {
    const s = await describeCodexSession(item.file, item.size, item.mtimeMs, titleIndex).catch(() => null);
    if (s) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

export function formatAgo(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}小时前` : `${Math.floor(h / 24)}天前`;
}
