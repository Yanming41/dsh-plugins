// secret_fill：把引用名对应的值填到别处，值不经过模型。三种方式（mode）：
//   web       —— CDP Input.insertText 往标签页里「当前聚焦的元素」插入，任意组件都行（不限密码框）。
//                先由 tars 视觉定位并点一下聚焦，或者传 selector 让这里 focus()。
//   clipboard —— 受保护剪贴板：打上 ExcludeClipboardContentFromMonitorProcessing / 不进剪贴板历史 / 不上云剪贴板，
//                paste=true 时发 Ctrl+V 到前台窗口后立刻清空；paste=false 时留给人手动粘贴，clearSec 秒后清空。
//   autotype  —— KeePass 式自动打字：SendInput 发 Unicode 键盘事件到前台窗口，不碰剪贴板。
// clipboard / autotype 目前只支持 Windows。window 参数（窗口标题片段）会先把那个窗口切到前台。
// 值经 PowerShell 的标准输入传进去，不进命令行参数。
import { execFile } from 'node:child_process';
import path from 'node:path';

const PS = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function powershell(script, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = execFile(PS, ['-NoProfile', '-NonInteractive', '-Sta', '-Command', script], { windowsHide: true, timeout: timeoutMs }, (error, stdout) => {
      if (error) reject(new Error(`PowerShell 执行失败${error.killed ? '（超时）' : ''}`));
      else resolve(String(stdout).trim());
    });
    child.stdin.end(input);
  });
}

const psString = (s) => `'${String(s).replace(/'/g, "''")}'`;

// 锁屏时 SendInput / 粘贴都送不到任何窗口（KeePass 也一样），先查出来给明确的错误，别假装成功
const LOCK_CHECK = `if (Get-Process LogonUI -ErrorAction SilentlyContinue) { [Console]::Out.Write('LOCKED'); exit 0 }`;

// 切前台：后台进程直接 SetForegroundWindow 会被前台锁挡掉，先按一下 Alt 解锁，再确认真的到前台了
const WINDOW_HELPER = `
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class SvWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static bool Activate(string part) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.ToString().IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return false;
    if (IsIconic(found)) ShowWindow(found, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(found);
    System.Threading.Thread.Sleep(300);
    return GetForegroundWindow() == found;
  }
}
'@`;
const activate = (win) => (win ? `${WINDOW_HELPER}
if (-not [SvWin]::Activate(${psString(win)})) { [Console]::Out.Write('NOWINDOW'); exit 0 }
Start-Sleep -Milliseconds 200` : '');

function checkResult(r) {
  if (r === 'LOCKED') throw new Error('Windows 锁屏中，桌面填写（clipboard / autotype）送不到任何窗口；解锁后再试，或改用 web 模式');
  if (r === 'NOWINDOW') throw new Error('找不到这个窗口，或没能切到前台');
  return r;
}

function clipboardScript({ paste, clearSec, window }) {
  return `${LOCK_CHECK}
Add-Type -AssemblyName System.Windows.Forms
$v = [Console]::In.ReadToEnd()
$d = New-Object System.Windows.Forms.DataObject
$d.SetText($v, [System.Windows.Forms.TextDataFormat]::UnicodeText)
$d.SetData('ExcludeClipboardContentFromMonitorProcessing', (New-Object IO.MemoryStream(,[byte[]](0,0,0,0))))
$d.SetData('CanIncludeInClipboardHistory', (New-Object IO.MemoryStream(,[BitConverter]::GetBytes([int]0))))
$d.SetData('CanUploadToCloudClipboard', (New-Object IO.MemoryStream(,[BitConverter]::GetBytes([int]0))))
${activate(window)}
[System.Windows.Forms.Clipboard]::SetDataObject($d, $false)
${paste ? `Start-Sleep -Milliseconds 150; [System.Windows.Forms.SendKeys]::SendWait('^v'); Start-Sleep -Milliseconds 500` : `Start-Sleep -Seconds ${Math.max(1, clearSec)}`}
if ([System.Windows.Forms.Clipboard]::GetText() -ceq $v) { [System.Windows.Forms.Clipboard]::Clear(); 'cleared' } else { 'changed' }
$v = $null`;
}

function autotypeScript({ window, enterForNewline }) {
  return `${LOCK_CHECK}
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class SvType {
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public long pad0; [FieldOffset(8)] public long pad1; [FieldOffset(16)] public long pad2; [FieldOffset(24)] public long pad3; }  // 联合体按 MOUSEINPUT 撑到 32 字节，SendInput 才认 sizeof(INPUT)=40
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  static void Key(ushort vk, ushort scan, uint flags) {
    var i = new INPUT { type = 1 }; i.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
    SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Type(string s, bool enter) {
    foreach (char c in s) {
      if (c == '\\r') continue;
      if (c == '\\n' && enter) { Key(0x0D, 0, 0); Key(0x0D, 0, 2); }
      else { Key(0, c, 4); Key(0, c, 4 | 2); }  // KEYEVENTF_UNICODE (| KEYUP)
      System.Threading.Thread.Sleep(8);
    }
  }
}
'@
$v = [Console]::In.ReadToEnd()
${activate(window)}
[SvType]::Type($v, $${enterForNewline ? 'true' : 'false'})
$v = $null
'typed'`;
}

async function cdpFill(value, { cdpUrl, tab, selector }) {
  const targets = await (await fetch(`${cdpUrl}/json`)).json();
  const pages = targets.filter((t) => t.type === 'page' && (!tab || t.url.includes(tab) || t.title.includes(tab)));
  if (pages.length !== 1) throw new Error(pages.length ? `有 ${pages.length} 个标签页匹配「${tab}」，请写得更具体` : `找不到匹配「${tab}」的标签页`);
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('CDP 连不上')); });
  let id = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const my = ++id;
    const onMsg = (m) => {
      const d = JSON.parse(m.data);
      if (d.id !== my) return;
      ws.removeEventListener('message', onMsg);
      d.error ? reject(new Error(d.error.message)) : resolve(d.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  try {
    if (selector) {
      const r = await call('Runtime.evaluate', { expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true; })()`, returnByValue: true });
      if (!r.result.value) throw new Error(`找不到元素 ${selector}`);
    }
    const focused = await call('Runtime.evaluate', { expression: '(() => { const a = document.activeElement; return a && a !== document.body ? a.tagName : null })()', returnByValue: true });
    if (!focused.result.value) throw new Error('页面上没有聚焦的输入元素：先点一下要填的框，或者传 selector');
    await call('Input.insertText', { text: value });
    return { filled: true, into: focused.result.value };
  } finally {
    ws.close();
  }
}

/**
 * @param vault  Vault 实例
 * @param opts   { ref, mode, tab, selector, window, paste, clearSec, enterForNewline }
 * @param config { cdpUrl, desktopFill, clipboardClearSec }
 */
export async function fillSecret(vault, opts, config) {
  const mode = opts.mode ?? (opts.tab || opts.selector ? 'web' : config.desktopFill);
  if (mode === 'web') return { mode, ...(await vault.use(opts.ref, (v) => cdpFill(v, { cdpUrl: config.cdpUrl, tab: opts.tab, selector: opts.selector }))) };
  if (process.platform !== 'win32') throw new Error(`${mode} 目前只支持 Windows`);
  if (mode === 'clipboard') {
    const paste = opts.paste ?? true;
    const clearSec = opts.clearSec ?? config.clipboardClearSec;
    const r = checkResult(await vault.use(opts.ref, (v) => powershell(clipboardScript({ paste, clearSec, window: opts.window }), v, (paste ? 20 : clearSec + 20) * 1000)));
    return { mode, pasted: paste, clipboard: r === 'cleared' ? '已清空' : '已被别的内容覆盖，未动' };
  }
  if (mode === 'autotype') {
    checkResult(await vault.use(opts.ref, (v) => powershell(autotypeScript({ window: opts.window, enterForNewline: opts.enterForNewline ?? false }), v, 60_000)));
    return { mode, typed: true };
  }
  throw new Error(`未知的 mode：${mode}（web / clipboard / autotype）`);
}
