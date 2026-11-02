// 从旧桥接 discord_dm/codex_progress.mjs 搬来：工作区 git 改动统计（完成行里显示这一轮改了多少）、验证类命令识别。
import { execFile } from 'node:child_process';

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout = '') => (error ? reject(error) : resolve(String(stdout))));
  });
}

function parseNumstat(text) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const [a, d] = line.split('\t', 3);
    if (/^\d+$/.test(a) && /^\d+$/.test(d)) { additions += Number(a); deletions += Number(d); }
  }
  return { additions, deletions };
}

/** cwd 不是 git 仓库就返回 null */
export async function readWorkspaceDiffStats(cwd) {
  try {
    await run(['rev-parse', '--is-inside-work-tree'], cwd);
    const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', '.'], cwd);
    let numstat;
    try {
      numstat = await run(['diff', '--no-ext-diff', '--numstat', 'HEAD', '--', '.'], cwd);
    } catch { // 还没有提交过
      numstat = `${await run(['diff', '--no-ext-diff', '--numstat', '--', '.'], cwd)}\n${await run(['diff', '--cached', '--no-ext-diff', '--numstat', '--', '.'], cwd)}`;
    }
    const files = new Set(status.split('\0').filter((e) => /^.. /.test(e)).map((e) => e.slice(3)));
    return { files, ...parseNumstat(numstat) };
  } catch {
    return null;
  }
}

/** 一轮前后两次采样的差：{ files, additions, deletions }，没变化或不是仓库返回 null */
export function diffDelta(before, after) {
  if (!before || !after) return null;
  const files = [...after.files].filter((f) => !before.files.has(f)).length;
  const additions = Math.max(0, after.additions - before.additions);
  const deletions = Math.max(0, after.deletions - before.deletions);
  return files || additions || deletions ? { files, additions, deletions } : null;
}

// 测试/构建这类验证命令，完成行里单独标出来
const VALIDATION_RULES = [
  ['测试', /(?:^|[\s;&|])(npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bnode\s+--test\b|\b(pytest|vitest|jest)\b/i],
  ['语法检查', /\bnode\s+--check\b|\bpython\s+-m\s+py_compile\b/i],
  ['类型检查', /\btsc\b[^\r\n;&|]*--noEmit\b|\b(mypy|pyright)\b/i],
  ['Lint', /\b(eslint|ruff\s+check|biome\s+check|stylelint)\b/i],
  ['构建', /(?:^|[\s;&|])(npm|pnpm|yarn)\s+(?:run\s+)?build\b|\b(cargo\s+build|go\s+build)\b/i],
];
export const validationKinds = (command) => VALIDATION_RULES.filter(([, re]) => re.test(String(command || ''))).map(([k]) => k);
