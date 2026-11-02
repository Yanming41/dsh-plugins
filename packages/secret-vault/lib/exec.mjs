// secret_exec：跑命令时把引用名对应的值注入成环境变量。命令行里只有变量名，值不进参数（进程列表看得到参数）；
// stdout / stderr 经打码后才返回，原值和常见编码形式都会被换成占位符。
// 局限：命令能拿到值，故意变形（比如逐字符打印）的输出打码拦不住——所以 execPolicy 可以收紧成白名单。
import { spawn } from 'node:child_process';
import path from 'node:path';

const SHELLS = {
  powershell: () => [path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command']],
  cmd: () => [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c']],
  bash: () => ['bash', ['-lc']],
  sh: () => ['sh', ['-c']],
};

/**
 * @param vault  Vault 实例
 * @param opts   { command, env: {变量名: 引用名}, cwd, timeoutSec }
 * @param config { shell, policy, allow, maxOutput }
 */
export async function execWithSecrets(vault, { command, env = {}, cwd, timeoutSec }, config) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('command 不能为空');
  if (config.policy === 'allowlist' && !config.allow.some((p) => new RegExp(p).test(command))) {
    throw new Error('这条命令不在 execAllow 白名单里');
  }
  for (const name of Object.keys(env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`环境变量名不合法：${name}`);
  const shellFn = SHELLS[config.shell];
  if (!shellFn) throw new Error(`未知的 execShell：${config.shell}`);

  // 逐个 use() 取值，组装子进程环境；值只存在于这个对象和子进程里
  const childEnv = { ...process.env };
  const entries = Object.entries(env);
  const run = async (i) => {
    if (i < entries.length) return vault.use(entries[i][1], (value) => { childEnv[entries[i][0]] = value; return run(i + 1); });
    const [bin, pre] = shellFn();
    return new Promise((resolve) => {
      const child = spawn(bin, [...pre, command], { cwd, env: childEnv, windowsHide: true });
      let out = '', err = '', timedOut = false;
      const cap = (s, d) => (s.length < config.maxOutput * 2 ? s + d : s);
      child.stdout.on('data', (d) => { out = cap(out, d); });
      child.stderr.on('data', (d) => { err = cap(err, d); });
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, (timeoutSec ?? config.timeoutSec) * 1000);
      child.on('close', (code) => {
        clearTimeout(timer);
        for (const [k] of entries) delete childEnv[k];
        const clip = (s) => { const t = vault.scrub(s); return t.length > config.maxOutput ? `${t.slice(0, config.maxOutput)}\n…（截断）` : t; };
        resolve({ exitCode: code, timedOut, stdout: clip(out), stderr: clip(err) });
      });
      child.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: null, timedOut: false, stdout: '', stderr: vault.scrub(e.message) }); });
    });
  };
  return run(0);
}
