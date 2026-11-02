// /reload <id>：把 profile 补丁里这个插件的 config.rev 加 1，dsh 看到配置变化就会重载它。
// 改代码不需要这个——hmr 监视着 plugins/ 和 lib/，保存即重载；/reload 用于想手动重启某个插件（比如重连网关）。
import { readFileSync, writeFileSync } from 'node:fs';

export function bumpRev(patchFile, id) {
  const lines = readFileSync(patchFile, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === `- id: ${id}`);
  if (start < 0) return false;
  for (let i = start + 1; i < lines.length && !/^\s*- id:/.test(lines[i]); i++) {
    const m = lines[i].match(/^(\s*rev:\s*)(\d+)\s*$/);
    if (m) {
      lines[i] = `${m[1]}${Number(m[2]) + 1}`;
      writeFileSync(patchFile, lines.join('\n'));
      return true;
    }
  }
  return false;
}
