// 保险柜数据密钥的保护方式（keyProtector）：
//   dpapi —— Windows DPAPI（CurrentUser）：密钥绑定当前 Windows 账户，文件拷走也解不开，不用主密码。Windows 默认。
//   file  —— 原样存一个 0600 权限的密钥文件。只靠文件权限保护，给没有 DPAPI 的平台和测试用。
// 数据密钥是随机的 32 字节；明文只在本进程内存里。经 PowerShell 调 DPAPI 时走标准输入，不进命令行参数（进程列表看得到参数）。
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

const PS = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function powershell(script, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000, maxBuffer: 1 << 20 }, (error, stdout) => {
      // 输出里可能有密钥材料，出错时不把它拼进错误信息
      if (error) reject(new Error('DPAPI 调用失败'));
      else resolve(String(stdout).trim());
    });
    child.stdin.end(input);
  });
}

const DPAPI = (op) => `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser'))`;
export const dpapiProtect = async (buf) => Buffer.from(await powershell(DPAPI('Protect'), buf.toString('base64')), 'base64');
export const dpapiUnprotect = async (buf) => Buffer.from(await powershell(DPAPI('Unprotect'), buf.toString('base64')), 'base64');

const writeAtomic = (file, data) => {
  writeFileSync(`${file}.tmp`, data, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};

/** 读出（没有就新建）数据密钥。返回 32 字节 Buffer。 */
export async function loadDataKey(dir, protector) {
  mkdirSync(dir, { recursive: true });
  if (protector === 'dpapi') {
    if (process.platform !== 'win32') throw new Error('keyProtector=dpapi 只能在 Windows 上用，其它平台请用 file');
    const file = path.join(dir, 'key.dpapi');
    if (existsSync(file)) return dpapiUnprotect(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'));
    const key = randomBytes(32);
    writeAtomic(file, (await dpapiProtect(key)).toString('base64'));
    return key;
  }
  if (protector === 'file') {
    const file = path.join(dir, 'key.raw');
    if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    const key = randomBytes(32);
    writeAtomic(file, key.toString('base64'));
    return key;
  }
  throw new Error(`未知的 keyProtector：${protector}`);
}
