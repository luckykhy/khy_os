'use strict';

/**
 * desktopControl/backendRegistry.js — 桌面操控原生命令的【单一真源】（DESIGN-ARCH-056）。
 *
 * 「装上眼、手」意味着 Khyos 要调用宿主操作系统的截屏与输入注入工具。这些命令是
 * 整个子系统里唯一允许出现具体 OS 可执行名/参数模板的地方——任何新增平台/后端只在
 * 此文件登记，绝不散落到 detector/capture/input 各处（工程红线：零硬编码散落）。
 *
 * 设计约束：
 *   1) 每个 builder 只产出 { cmd, args[] }，永远经 execFile 调用——**绝不拼 shell 字符串**，
 *      天然免命令注入。坐标等数值由上游 inputController 校验为有限非负整数后才进来。
 *   2) builder 不支持某操作时返回 null（上游据此降级/报「该后端不支持此动作」）。
 *   3) 每个后端声明 optionalDep（包管理器 + 包名 + 安装提示），供依赖自愈循环按需提示安装。
 *
 * 两类后端：
 *   - capture（眼）：截屏到指定 PNG 路径。
 *   - input（手）：鼠标移动/点击/拖拽/滚轮 + 键盘打字/按键。
 *
 * 嘴（TTS）/耳（STT）不在此处——它们复用既有 voiceService，由 voiceBridge 适配。
 */

const PLATFORM = process.platform;

// ── 工具：Windows PowerShell 截屏脚本（System.Drawing），数值已校验，路径单引号转义。 ──
function _psSingleQuote(s) {
  return String(s).replace(/'/g, "''");
}

function _winCaptureScript(outPath, region) {
  const p = _psSingleQuote(outPath);
  if (region) {
    const { x, y, w, h } = region;
    return [
      'Add-Type -AssemblyName System.Drawing,System.Windows.Forms;',
      `$bmp = New-Object System.Drawing.Bitmap ${w}, ${h};`,
      '$g = [System.Drawing.Graphics]::FromImage($bmp);',
      `$g.CopyFromScreen(${x}, ${y}, 0, 0, (New-Object System.Drawing.Size(${w}, ${h})));`,
      `$bmp.Save('${p}'); $g.Dispose(); $bmp.Dispose();`,
    ].join(' ');
  }
  return [
    'Add-Type -AssemblyName System.Drawing,System.Windows.Forms;',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;',
    '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;',
    '$g = [System.Drawing.Graphics]::FromImage($bmp);',
    '$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size);',
    `$bmp.Save('${p}'); $g.Dispose(); $bmp.Dispose();`,
  ].join(' ');
}

// ── 工具：Windows SendKeys 文本转义（保护 SendKeys 元字符）。 ──
function _sendKeysEscape(text) {
  return String(text).replace(/[+^%~(){}[\]]/g, '{$&}');
}

function _ps(cmd) {
  return { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', cmd] };
}

// ── 工具：pyautogui 跨平台后备。文本/坐标全部经 argv 传入，python 侧读 sys.argv，零注入。 ──
function _py(body, argv = []) {
  return { cmd: 'python3', args: ['-c', body, '--', ...argv.map(String)] };
}

const PY_BACKEND = {
  id: 'pyautogui',
  kind: 'input',
  probe: 'python3',
  // 运行期还需 `python3 -c "import pyautogui"` 才算真可用——detector 负责深探。
  importProbe: 'import pyautogui',
  optionalDep: { manager: 'pip', package: 'pyautogui', hint: 'pip install pyautogui' },
  ops: {
    move: (x, y) => _py('import pyautogui,sys; pyautogui.moveTo(int(sys.argv[1]),int(sys.argv[2]))', [x, y]),
    click: (x, y, button = 'left') => _py('import pyautogui,sys; pyautogui.click(int(sys.argv[1]),int(sys.argv[2]),button=sys.argv[3])', [x, y, button]),
    doubleClick: (x, y) => _py('import pyautogui,sys; pyautogui.doubleClick(int(sys.argv[1]),int(sys.argv[2]))', [x, y]),
    rightClick: (x, y) => _py('import pyautogui,sys; pyautogui.click(int(sys.argv[1]),int(sys.argv[2]),button="right")', [x, y]),
    drag: (x1, y1, x2, y2) => _py('import pyautogui,sys; pyautogui.moveTo(int(sys.argv[1]),int(sys.argv[2])); pyautogui.dragTo(int(sys.argv[3]),int(sys.argv[4]),duration=0.2)', [x1, y1, x2, y2]),
    scroll: (dx, dy) => _py('import pyautogui,sys; pyautogui.scroll(int(sys.argv[1]))', [dy]),
    type: (text) => _py('import pyautogui,sys; pyautogui.typewrite(sys.argv[1],interval=0.01)', [text]),
    // 逐键模式：interval 即人手节奏（秒），每个字符发独立按键事件，给应用/输入法留处理时间。
    typeKeystrokes: (text, delayMs) => _py('import pyautogui,sys; pyautogui.typewrite(sys.argv[1],interval=float(sys.argv[2]))', [text, (Number(delayMs) || 0) / 1000]),
    key: (keyName) => _py('import pyautogui,sys; pyautogui.press(sys.argv[1])', [keyName]),
    hotkey: (keys) => _py('import pyautogui,sys; pyautogui.hotkey(*sys.argv[1:])', keys),
  },
};

// ── 工具：解析无障碍后端的 JSON 输出为原始节点数组（容错单元素/空/对象）。 ──
function _parseJsonElements(stdout) {
  const s = String(stdout == null ? '' : stdout).trim();
  if (!s) return [];
  let data;
  try { data = JSON.parse(s); } catch { return []; }
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return [data]; // PowerShell ConvertTo-Json 单元素退化为对象
  return [];
}

// ── inspect（眼·结构化）：抓宿主无障碍树 → 输出可点击/可填写元素清单。 ──
//
// 三平台各用系统自带（或常见）的无障碍 API，统一 emit 一个 JSON 数组，元素字段：
//   { role, name, value, x, y, w, h, enabled }
// 坐标为屏幕绝对像素，可直接换算中心点供模拟点击。脚本均为**常量字符串**（无用户数据内插），
// 经 execFile 以 argv 传入，零注入。

// macOS：JXA（osascript -l JavaScript）遍历最前台进程的 UI 元素树，JSON.stringify 输出。
const _MAC_AX_JXA = [
  'function run(){',
  ' var se=Application("System Events"); se.includeStandardAdditions=true;',
  ' var out=[];',
  ' function num(v){return (typeof v==="number"&&isFinite(v))?v:0;}',
  ' function walk(el,d){',
  '  if(d>6||out.length>1500)return;',
  '  var kids; try{kids=el.uiElements();}catch(e){return;}',
  '  for(var i=0;i<kids.length;i++){',
  '   var e=kids[i],role="",name="",val="",pos=null,size=null,en=true;',
  '   try{role=e.role();}catch(_){}'
  + 'try{name=e.name()||e.description()||e.title()||"";}catch(_){}'
  + 'try{val=String(e.value()||"");}catch(_){}'
  + 'try{pos=e.position();}catch(_){}'
  + 'try{size=e.size();}catch(_){}'
  + 'try{en=e.enabled();}catch(_){}',
  '   if(pos&&size){out.push({role:role,name:name,value:val,x:num(pos[0]),y:num(pos[1]),w:num(size[0]),h:num(size[1]),enabled:en});}',
  '   walk(e,d+1);',
  '  }',
  ' }',
  ' try{var p=se.applicationProcesses.whose({frontmost:true})[0]; walk(p,0);}catch(e){}',
  ' return JSON.stringify(out);',
  '}',
].join('');

const MAC_INSPECT = {
  id: 'macos-ax', kind: 'inspect', probe: 'osascript', optionalDep: null,
  ops: { tree: () => ({ cmd: 'osascript', args: ['-l', 'JavaScript', '-e', _MAC_AX_JXA] }) },
  parse: _parseJsonElements,
};

// Linux：AT-SPI（python3 + pyatspi）遍历活动应用，queryComponent 取屏幕坐标，json.dumps 输出。
const _LINUX_ATSPI = [
  'import json,sys',
  'out=[]',
  'try:',
  ' import pyatspi',
  'except Exception:',
  ' print("[]"); sys.exit(0)',
  'def walk(o,d):',
  ' if d>10 or len(out)>1500: return',
  ' try: n=o.childCount',
  ' except Exception: n=0',
  ' for i in range(n):',
  '  try: c=o.getChildAt(i)',
  '  except Exception: continue',
  '  if c is None: continue',
  '  x=y=w=h=None; en=True; name=""; val=""; role=""',
  '  try: role=c.getRoleName()',
  '  except Exception: pass',
  '  try: name=c.name or ""',
  '  except Exception: pass',
  '  try:',
  '   ss=c.getState(); showing=ss.contains(pyatspi.STATE_SHOWING); en=ss.contains(pyatspi.STATE_ENABLED)',
  '  except Exception: showing=False',
  '  try:',
  '   ext=c.queryComponent().getExtents(pyatspi.DESKTOP_COORDS); x,y,w,h=ext.x,ext.y,ext.width,ext.height',
  '  except Exception: pass',
  '  try: val=str(c.queryValue().currentValue)',
  '  except Exception:',
  '   try:',
  '    ti=c.queryText(); val=ti.getText(0,ti.characterCount)',
  '   except Exception: val=""',
  '  if showing and x is not None and w and h: out.append({"role":role,"name":name,"value":val,"x":x,"y":y,"w":w,"h":h,"enabled":en})',
  '  walk(c,d+1)',
  'try:',
  ' dsk=pyatspi.Registry.getDesktop(0)',
  ' for i in range(dsk.childCount):',
  '  app=dsk.getChildAt(i)',
  '  if app is None: continue',
  '  try: walk(app,0)',
  '  except Exception: continue',
  'except Exception: pass',
  'print(json.dumps(out))',
].join('\n');

const LINUX_INSPECT = {
  id: 'linux-atspi', kind: 'inspect', probe: 'python3', importProbe: 'import pyatspi',
  optionalDep: { manager: 'apt', package: 'python3-pyatspi', hint: 'apt install python3-pyatspi gir1.2-atspi-2.0（并开启辅助功能总线）' },
  ops: { tree: () => ({ cmd: 'python3', args: ['-c', _LINUX_ATSPI] }) },
  parse: _parseJsonElements,
};

// Windows：UI Automation（PowerShell）遍历前台窗口可见元素，ConvertTo-Json 输出。
const _WIN_UIA = [
  'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes;',
  '$root=[System.Windows.Automation.AutomationElement]::RootElement;',
  '$scope=$root;',
  'try{',
  ' $fe=[System.Windows.Automation.AutomationElement]::FocusedElement;',
  ' if($fe){ $w=[System.Windows.Automation.TreeWalker]::ControlViewWalker; $cur=$fe;',
  '  while($cur -ne $null -and $cur.Current.ControlType -ne [System.Windows.Automation.ControlType]::Window){ $cur=$w.GetParent($cur) }',
  '  if($cur -ne $null){ $scope=$cur } }',
  '}catch{}',
  '$cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsOffscreenProperty,$false);',
  '$els=$scope.FindAll([System.Windows.Automation.TreeScope]::Descendants,$cond);',
  '$out=@();',
  'foreach($e in $els){ try{',
  ' $r=$e.Current.BoundingRectangle;',
  ' if($r.Width -le 0 -or $r.Height -le 0){continue}',
  ' $out+=[pscustomobject]@{role=$e.Current.ControlType.ProgrammaticName;name=$e.Current.Name;value="";x=[int]$r.X;y=[int]$r.Y;w=[int]$r.Width;h=[int]$r.Height;enabled=$e.Current.IsEnabled}',
  '}catch{} }',
  '$out|ConvertTo-Json -Compress',
].join(' ');

const WIN_INSPECT = {
  id: 'windows-uia', kind: 'inspect', probe: 'powershell', optionalDep: null,
  ops: { tree: () => _ps(_WIN_UIA) },
  parse: _parseJsonElements,
};

// ── 窗口管理（window）：按应用/窗口名激活/关闭/最小化。 ───────────────────────
// 与 input（坐标驱动）解耦：mac 主输入后端 cliclick 不会窗口操作，窗口需各自专属后端。
// 名字仅作 argv 单元（wmctrl/xdotool）或经脚本字符串转义（osascript/PowerShell），零 shell 拼接。

/** AppleScript 字符串字面量转义（保护反斜杠与双引号）。 */
function _osaEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// macOS：osascript。activate 经应用名(可拉起)，close/minimize 经 System Events 作用于前台窗口。
// close 优先按下原生关闭按钮（AXCloseButton）——正是「移到 X 上关闭」的语义；失败回退点击按钮 1。
function _macActivate(name) {
  return { cmd: 'osascript', args: ['-e', `tell application "${_osaEscape(name)}" to activate`] };
}
function _macCloseWindow(name) {
  const target = name
    ? `first application process whose name contains "${_osaEscape(name)}"`
    : 'first application process whose frontmost is true';
  const script = [
    'tell application "System Events"',
    `set p to ${target}`,
    'tell p',
    'set frontmost to true',
    'try',
    'perform action "AXPress" of (first button of window 1 whose subrole is "AXCloseButton")',
    'on error',
    'click button 1 of window 1',
    'end try',
    'end tell',
    'end tell',
  ].join('\n');
  return { cmd: 'osascript', args: ['-e', script] };
}
function _macMinimizeWindow(name) {
  const target = name
    ? `first application process whose name contains "${_osaEscape(name)}"`
    : 'first application process whose frontmost is true';
  const script = [
    'tell application "System Events"',
    `set p to ${target}`,
    'set value of attribute "AXMinimized" of window 1 of p to true',
    'end tell',
  ].join('\n');
  return { cmd: 'osascript', args: ['-e', script] };
}
const MAC_WINDOW = {
  id: 'macos-osascript', kind: 'window', probe: 'osascript', optionalDep: null,
  ops: {
    activate: (name) => _macActivate(name),
    closeWindow: (name) => _macCloseWindow(name || ''),
    minimizeWindow: (name) => _macMinimizeWindow(name || ''),
    listWindows: () => ({ cmd: 'osascript', args: ['-e',
      'tell application "System Events" to get name of every application process whose visible is true'] }),
  },
};

// Linux：wmctrl（优先，按标题匹配激活/关闭）；xdotool 兜底并补最小化（wmctrl 无原生最小化）。
const LINUX_WINDOW_WMCTRL = {
  id: 'wmctrl', kind: 'window', probe: 'wmctrl',
  optionalDep: { manager: 'apt', package: 'wmctrl', hint: 'apt install wmctrl (X11)' },
  ops: {
    activate: (name) => ({ cmd: 'wmctrl', args: ['-a', name] }),
    closeWindow: (name) => ({ cmd: 'wmctrl', args: ['-c', name] }),
    // wmctrl 无原生最小化 → 返回 null 触发降级到 xdotool。
    minimizeWindow: () => null,
    listWindows: () => ({ cmd: 'wmctrl', args: ['-l'] }),
  },
};
const LINUX_WINDOW_XDOTOOL = {
  id: 'xdotool-window', kind: 'window', probe: 'xdotool',
  optionalDep: { manager: 'apt', package: 'xdotool', hint: 'apt install xdotool (X11)' },
  ops: {
    activate: (name) => ({ cmd: 'xdotool', args: ['search', '--name', name, 'windowactivate'] }),
    closeWindow: (name) => ({ cmd: 'xdotool', args: ['search', '--name', name, 'windowclose'] }),
    minimizeWindow: (name) => ({ cmd: 'xdotool', args: ['search', '--name', name, 'windowminimize'] }),
    listWindows: () => ({ cmd: 'xdotool', args: ['search', '--name', '.'] }),
  },
};

// Windows：PowerShell。activate 经 WScript.Shell.AppActivate；close 经 CloseMainWindow；
// minimize 经 user32 ShowWindowAsync(SW_MINIMIZE=6)。
function _winActivate(name) {
  return _ps(`$w=New-Object -ComObject WScript.Shell;$w.AppActivate('${_psSingleQuote(name)}')|Out-Null`);
}
function _winCloseWindow(name) {
  const n = _psSingleQuote(name);
  return _ps(`Get-Process|Where-Object{$_.MainWindowTitle -like '*${n}*' -or $_.ProcessName -like '*${n}*'}|ForEach-Object{$_.CloseMainWindow()|Out-Null}`);
}
const _WIN_SHOWWINDOW =
  'Add-Type \'using System;using System.Runtime.InteropServices;public class KhyW{[DllImport("user32.dll")]public static extern bool ShowWindowAsync(IntPtr h,int n);}\'';
function _winMinimizeWindow(name) {
  const n = _psSingleQuote(name);
  return _ps(`${_WIN_SHOWWINDOW};Get-Process|Where-Object{$_.MainWindowTitle -like '*${n}*'}|ForEach-Object{[KhyW]::ShowWindowAsync($_.MainWindowHandle,6)|Out-Null}`);
}
const WIN_WINDOW = {
  id: 'powershell-window', kind: 'window', probe: 'powershell', optionalDep: null,
  ops: {
    activate: (name) => _winActivate(name),
    closeWindow: (name) => _winCloseWindow(name),
    minimizeWindow: (name) => _winMinimizeWindow(name),
    listWindows: () => _ps('Get-Process|Where-Object{$_.MainWindowTitle}|Select-Object ProcessName,MainWindowTitle|ConvertTo-Json -Compress'),
  },
};

// ── 平台后端登记表（单一真源）。每平台一组 capture/input/inspect/window 后端，按优先级排列。 ──
const REGISTRY = {
  darwin: {
    capture: [
      {
        id: 'screencapture',
        kind: 'capture',
        probe: 'screencapture', // macOS 内置，几乎恒在
        optionalDep: null,
        ops: {
          full: (out) => ({ cmd: 'screencapture', args: ['-x', out] }),
          region: (x, y, w, h, out) => ({ cmd: 'screencapture', args: ['-x', '-R', `${x},${y},${w},${h}`, out] }),
        },
      },
    ],
    input: [
      {
        id: 'cliclick',
        kind: 'input',
        probe: 'cliclick',
        optionalDep: { manager: 'brew', package: 'cliclick', hint: 'brew install cliclick' },
        ops: {
          move: (x, y) => ({ cmd: 'cliclick', args: [`m:${x},${y}`] }),
          click: (x, y) => ({ cmd: 'cliclick', args: [`c:${x},${y}`] }),
          doubleClick: (x, y) => ({ cmd: 'cliclick', args: [`dc:${x},${y}`] }),
          rightClick: (x, y) => ({ cmd: 'cliclick', args: [`rc:${x},${y}`] }),
          drag: (x1, y1, x2, y2) => ({ cmd: 'cliclick', args: [`dd:${x1},${y1}`, `du:${x2},${y2}`] }),
          type: (text) => ({ cmd: 'cliclick', args: [`t:${text}`] }),
          // 逐键模式：把整串拆成逐字符 t: 命令，字符间插入 w:延迟（cliclick 的等待命令），模拟人手节奏。
          typeKeystrokes: (text, delayMs) => {
            const d = Math.max(0, Math.trunc(Number(delayMs) || 0));
            const chars = Array.from(String(text)); // 按 Unicode 码点拆分（中文/emoji 安全）
            const args = [];
            chars.forEach((ch, i) => {
              args.push(`t:${ch}`);
              if (d > 0 && i < chars.length - 1) args.push(`w:${d}`);
            });
            return args.length ? { cmd: 'cliclick', args } : null;
          },
          key: (keyName) => ({ cmd: 'cliclick', args: [`kp:${keyName}`] }),
          // cliclick 无原生滚轮 → 返回 null 触发降级。
          scroll: () => null,
          hotkey: (keys) => ({ cmd: 'cliclick', args: keys.map((k, i) => (i < keys.length - 1 ? `kd:${k}` : `kp:${k}`)) }),
        },
      },
      PY_BACKEND,
      {
        // 仅键盘：osascript 可在无 cliclick 时兜底打字（不支持鼠标 → 返回 null）。
        id: 'osascript',
        kind: 'input',
        probe: 'osascript',
        optionalDep: null,
        ops: {
          move: () => null,
          click: () => null,
          doubleClick: () => null,
          rightClick: () => null,
          drag: () => null,
          scroll: () => null,
          type: (text) => ({ cmd: 'osascript', args: ['-e', `tell application "System Events" to keystroke ${JSON.stringify(text)}`] }),
          key: (keyName) => ({ cmd: 'osascript', args: ['-e', `tell application "System Events" to key code ${_macKeyCode(keyName)}`] }),
          hotkey: () => null,
        },
      },
    ],
    inspect: [MAC_INSPECT],
    window: [MAC_WINDOW],
  },

  linux: {
    capture: [
      { id: 'grim', kind: 'capture', probe: 'grim', optionalDep: { manager: 'apt', package: 'grim', hint: 'apt install grim (Wayland)' },
        ops: {
          full: (out) => ({ cmd: 'grim', args: [out] }),
          region: (x, y, w, h, out) => ({ cmd: 'grim', args: ['-g', `${x},${y} ${w}x${h}`, out] }),
        } },
      { id: 'maim', kind: 'capture', probe: 'maim', optionalDep: { manager: 'apt', package: 'maim', hint: 'apt install maim' },
        ops: {
          full: (out) => ({ cmd: 'maim', args: [out] }),
          region: (x, y, w, h, out) => ({ cmd: 'maim', args: ['-g', `${w}x${h}+${x}+${y}`, out] }),
        } },
      { id: 'scrot', kind: 'capture', probe: 'scrot', optionalDep: { manager: 'apt', package: 'scrot', hint: 'apt install scrot' },
        ops: {
          full: (out) => ({ cmd: 'scrot', args: ['-o', out] }),
          region: (x, y, w, h, out) => ({ cmd: 'scrot', args: ['-o', '-a', `${x},${y},${w},${h}`, out] }),
        } },
      { id: 'imagemagick-import', kind: 'capture', probe: 'import', optionalDep: { manager: 'apt', package: 'imagemagick', hint: 'apt install imagemagick' },
        ops: {
          full: (out) => ({ cmd: 'import', args: ['-window', 'root', out] }),
          region: (x, y, w, h, out) => ({ cmd: 'import', args: ['-window', 'root', '-crop', `${w}x${h}+${x}+${y}`, out] }),
        } },
      { id: 'gnome-screenshot', kind: 'capture', probe: 'gnome-screenshot', optionalDep: { manager: 'apt', package: 'gnome-screenshot', hint: 'apt install gnome-screenshot' },
        ops: {
          full: (out) => ({ cmd: 'gnome-screenshot', args: ['-f', out] }),
          region: () => null, // gnome-screenshot 区域为交互式 → 不支持脚本化坐标。
        } },
    ],
    input: [
      {
        id: 'xdotool',
        kind: 'input',
        probe: 'xdotool',
        optionalDep: { manager: 'apt', package: 'xdotool', hint: 'apt install xdotool (X11)' },
        ops: {
          move: (x, y) => ({ cmd: 'xdotool', args: ['mousemove', String(x), String(y)] }),
          click: (x, y) => ({ cmd: 'xdotool', args: ['mousemove', String(x), String(y), 'click', '1'] }),
          doubleClick: (x, y) => ({ cmd: 'xdotool', args: ['mousemove', String(x), String(y), 'click', '--repeat', '2', '1'] }),
          rightClick: (x, y) => ({ cmd: 'xdotool', args: ['mousemove', String(x), String(y), 'click', '3'] }),
          drag: (x1, y1, x2, y2) => ({ cmd: 'xdotool', args: ['mousemove', String(x1), String(y1), 'mousedown', '1', 'mousemove', String(x2), String(y2), 'mouseup', '1'] }),
          scroll: (dx, dy) => ({ cmd: 'xdotool', args: ['click', dy < 0 ? '4' : '5'] }),
          type: (text) => ({ cmd: 'xdotool', args: ['type', '--clearmodifiers', '--', text] }),
          // 逐键模式：--delay 毫秒在按键之间插入人手节奏，逐字符走真实键事件（应用/输入法可介入）。
          typeKeystrokes: (text, delayMs) => ({ cmd: 'xdotool', args: ['type', '--clearmodifiers', '--delay', String(Math.max(0, Math.trunc(Number(delayMs) || 0))), '--', text] }),
          key: (keyName) => ({ cmd: 'xdotool', args: ['key', '--clearmodifiers', keyName] }),
          hotkey: (keys) => ({ cmd: 'xdotool', args: ['key', '--clearmodifiers', keys.join('+')] }),
        },
      },
      {
        id: 'ydotool',
        kind: 'input',
        probe: 'ydotool',
        optionalDep: { manager: 'apt', package: 'ydotool', hint: 'apt install ydotool (Wayland)' },
        ops: {
          move: (x, y) => ({ cmd: 'ydotool', args: ['mousemove', '--absolute', '-x', String(x), '-y', String(y)] }),
          click: () => ({ cmd: 'ydotool', args: ['click', '0xC0'] }),
          doubleClick: () => ({ cmd: 'ydotool', args: ['click', '--repeat', '2', '0xC0'] }),
          rightClick: () => ({ cmd: 'ydotool', args: ['click', '0xC1'] }),
          drag: () => null,
          scroll: () => null,
          type: (text) => ({ cmd: 'ydotool', args: ['type', '--', text] }),
          typeKeystrokes: (text, delayMs) => ({ cmd: 'ydotool', args: ['type', '--key-delay', String(Math.max(0, Math.trunc(Number(delayMs) || 0))), '--', text] }),
          key: (keyName) => ({ cmd: 'ydotool', args: ['key', keyName] }),
          hotkey: (keys) => ({ cmd: 'ydotool', args: ['key', ...keys] }),
        },
      },
      PY_BACKEND,
    ],
    inspect: [LINUX_INSPECT],
    window: [LINUX_WINDOW_WMCTRL, LINUX_WINDOW_XDOTOOL],
  },

  win32: {
    capture: [
      {
        id: 'powershell-gdi',
        kind: 'capture',
        probe: 'powershell',
        optionalDep: null,
        ops: {
          full: (out) => _ps(_winCaptureScript(out, null)),
          region: (x, y, w, h, out) => _ps(_winCaptureScript(out, { x, y, w, h })),
        },
      },
    ],
    input: [
      {
        id: 'powershell-user32',
        kind: 'input',
        probe: 'powershell',
        optionalDep: null,
        ops: {
          move: (x, y) => _ps(`${_WIN_USER32};[KhyU]::SetCursorPos(${x},${y})|Out-Null`),
          click: (x, y) => _ps(`${_WIN_USER32};[KhyU]::SetCursorPos(${x},${y})|Out-Null;[KhyU]::mouse_event(2,0,0,0,0);[KhyU]::mouse_event(4,0,0,0,0)`),
          doubleClick: (x, y) => _ps(`${_WIN_USER32};[KhyU]::SetCursorPos(${x},${y})|Out-Null;[KhyU]::mouse_event(2,0,0,0,0);[KhyU]::mouse_event(4,0,0,0,0);[KhyU]::mouse_event(2,0,0,0,0);[KhyU]::mouse_event(4,0,0,0,0)`),
          rightClick: (x, y) => _ps(`${_WIN_USER32};[KhyU]::SetCursorPos(${x},${y})|Out-Null;[KhyU]::mouse_event(8,0,0,0,0);[KhyU]::mouse_event(16,0,0,0,0)`),
          drag: (x1, y1, x2, y2) => _ps(`${_WIN_USER32};[KhyU]::SetCursorPos(${x1},${y1})|Out-Null;[KhyU]::mouse_event(2,0,0,0,0);[KhyU]::SetCursorPos(${x2},${y2})|Out-Null;[KhyU]::mouse_event(4,0,0,0,0)`),
          scroll: (dx, dy) => _ps(`${_WIN_USER32};[KhyU]::mouse_event(2048,0,0,${-dy * 120},0)`),
          type: (text) => _ps(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${_psSingleQuote(_sendKeysEscape(text))}')`),
          typeKeystrokes: (text, delayMs) => _winTypeKeystrokes(text, delayMs),
          key: (keyName) => _ps(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${_psSingleQuote(_winSendKey(keyName))}')`),
          hotkey: (keys) => _ps(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${_psSingleQuote(_winHotkey(keys))}')`),
        },
      },
      PY_BACKEND,
    ],
    inspect: [WIN_INSPECT],
    window: [WIN_WINDOW],
  },
};

// ── Windows user32 P/Invoke 片段（SetCursorPos + mouse_event）。 ──
const _WIN_USER32 =
  'Add-Type \'using System;using System.Runtime.InteropServices;public class KhyU{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,int d,int e);}\'';

// SendKeys 特殊键名映射（单一真源）。
const _WIN_SENDKEY_MAP = {
  enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
  backspace: '{BACKSPACE}', delete: '{DELETE}', up: '{UP}', down: '{DOWN}',
  left: '{LEFT}', right: '{RIGHT}', home: '{HOME}', end: '{END}', space: ' ',
};
function _winSendKey(keyName) {
  return _WIN_SENDKEY_MAP[String(keyName).toLowerCase()] || _sendKeysEscape(keyName);
}
const _WIN_MODIFIER = { ctrl: '^', control: '^', alt: '%', shift: '+', cmd: '^', win: '^' };
function _winHotkey(keys) {
  const mods = keys.slice(0, -1).map((k) => _WIN_MODIFIER[String(k).toLowerCase()] || '').join('');
  return mods + _winSendKey(keys[keys.length - 1]);
}

// 逐键键入（Windows）：把整串拆成逐字符 SendWait，字符间 Start-Sleep 插入人手节奏，
// 让前台应用键盘消息队列与活动输入法（IME）逐键处理——而非一次性灌入。
// 每个字符各自经 _sendKeysEscape + _psSingleQuote 转义（单引号 PS 串，零注入）。
function _winTypeKeystrokes(text, delayMs) {
  const d = Math.max(0, Math.trunc(Number(delayMs) || 0));
  const chars = Array.from(String(text)); // 按码点拆分（中文/emoji 安全）
  if (chars.length === 0) return null;
  const stmts = chars.map((ch, i) => {
    const send = `[System.Windows.Forms.SendKeys]::SendWait('${_psSingleQuote(_sendKeysEscape(ch))}')`;
    const sleep = d > 0 && i < chars.length - 1 ? `;Start-Sleep -Milliseconds ${d}` : '';
    return send + sleep;
  });
  return _ps(`Add-Type -AssemblyName System.Windows.Forms;${stmts.join(';')}`);
}

// macOS key code 映射（osascript 兜底用；仅常见键）。
const _MAC_KEYCODE = {
  enter: 36, return: 36, tab: 48, space: 49, delete: 51, backspace: 51,
  escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126,
};
function _macKeyCode(keyName) {
  const c = _MAC_KEYCODE[String(keyName).toLowerCase()];
  return c == null ? 36 : c; // 未知键安全回退到 return
}

/** 返回某平台某类后端的有序列表（深拷贝引用安全：仅读不改）。 */
function backendsFor(platform, kind) {
  const plat = REGISTRY[platform || PLATFORM];
  if (!plat) return [];
  return plat[kind] ? plat[kind].slice() : [];
}

/** 列出已登记的平台。 */
function platforms() {
  return Object.keys(REGISTRY);
}

module.exports = {
  PLATFORM,
  REGISTRY,
  PY_BACKEND,
  backendsFor,
  platforms,
  // 暴露纯函数供测试断言（注入安全/转义正确）。
  _internals: {
    _sendKeysEscape, _psSingleQuote, _winCaptureScript,
    _winSendKey, _winHotkey, _macKeyCode, _WIN_USER32,
    _parseJsonElements, _osaEscape,
  },
};
