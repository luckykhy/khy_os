'use strict';

/**
 * dependency/registry.js — 依赖缺失场景的**单一真源**（零硬编码散落）。
 *
 * 每一条目把一个「逻辑依赖」收敛为四件事：
 *   1) 如何探测它是否已安装（probe，结构化声明，不在各工具里散写 which/require）；
 *   2) 如何安装它（install，**argv 数组**形式——绝不拼 shell 字符串、绝不取自模型输入）；
 *   3) 如何从既有工具的报错文本里把它**回溯辨认**出来（matchers，使现存的硬抛/软失败
 *      无需逐个改造即可被自愈层接管）；
 *   4) 给人看的标签 / 文档链接 / 风险与作用域。
 *
 * 设计红线：
 *   - 安装命令只能来自本表（curated），永不由报错文本或模型参数拼装 → 杜绝命令注入。
 *   - 全局/系统级安装（-g / apt / brew）标 scope:'global'，由上层提高审批强度，
 *     且默认**不**自动 sudo（需要提权只提示，不替用户提权）。
 *   - 平台差异收敛在 install.platform 覆盖里；缺省走 install.command。
 *
 * 条目来自 services/backend 依赖硬中断点审计（浏览器 / Python / 系统命令 / Node 模块四类）。
 */

// 探测类型常量（resolver 据此选择探针实现）。
const PROBE = {
  NODE_MODULE: 'node-module',
  COMMAND: 'system-command',
  PYTHON_PACKAGE: 'python-package',
};

/**
 * 依赖定义表。键为稳定的 depId（供会话级去重 / 审计引用）。
 * @type {Record<string, object>}
 */
const DEPENDENCIES = {
  // ── 浏览器自动化 ───────────────────────────────────────────────
  puppeteer: {
    id: 'puppeteer',
    label: 'Puppeteer (无头 Chromium 驱动)',
    kind: 'browser',
    probe: { type: PROBE.NODE_MODULE, module: 'puppeteer' },
    // followUp pulls the Chromium binary. Without it, `npm install puppeteer` may
    // exit 0 (so require.resolve passes → probe falsely reports "present") while
    // the browser download silently failed — common on Windows / 国内网络 — and
    // any launch() then throws. Mirrors the playwright entry below.
    install: { manager: 'npm', command: ['npm', 'install', 'puppeteer'], scope: 'project', needsNetwork: true, risk: 'medium',
      followUp: ['npx', 'puppeteer', 'browsers', 'install', 'chrome'] },
    docsUrl: 'https://pptr.dev/',
    matchers: [/requires puppeteer/i, /npm i+\s+puppeteer/i, /npm install puppeteer/i, /\bpuppeteer\b.*not (installed|found)/i],
  },
  playwright: {
    id: 'playwright',
    label: 'Playwright (多浏览器自动化)',
    kind: 'browser',
    probe: { type: PROBE.NODE_MODULE, module: 'playwright' },
    install: { manager: 'npm', command: ['npm', 'install', 'playwright'], scope: 'project', needsNetwork: true, risk: 'medium',
      followUp: ['npx', 'playwright', 'install', 'chromium'] },
    docsUrl: 'https://playwright.dev/',
    matchers: [/requires .*playwright/i, /npm i+\s+playwright/i, /playwright (fetch failed|unavailable)/i, /\bplaywright\b.*not (installed|found)/i],
  },

  // ── 网页抓取 / HTML 解析 ───────────────────────────────────────
  cheerio: {
    id: 'cheerio',
    label: 'cheerio (搜索结果 HTML 解析)',
    kind: 'node-module',
    probe: { type: PROBE.NODE_MODULE, module: 'cheerio' },
    install: { manager: 'npm', command: ['npm', 'install', 'cheerio'], scope: 'project', needsNetwork: true, risk: 'low' },
    docsUrl: 'https://cheerio.js.org/',
    // 中英双语：覆盖 webSearchService 的中文降级提示「cheerio 未安装」与通用英文报错。
    matchers: [/\bcheerio\b[\s\S]{0,40}?(not installed|未安装|not found|unavailable|缺失)/i, /requires cheerio/i],
  },

  // ── 系统命令 ───────────────────────────────────────────────────
  ffmpeg: {
    id: 'ffmpeg',
    label: 'FFmpeg (音视频处理)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'ffmpeg' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'ffmpeg'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'ffmpeg'], win32: ['winget', 'install', '--id', 'Gyan.FFmpeg', '-e'] },
    },
    docsUrl: 'https://ffmpeg.org/download.html',
    matchers: [/ffmpeg not found/i, /install ffmpeg/i, /ffmpeg_unavailable/i],
  },
  tar: {
    id: 'tar',
    label: 'tar (归档解压)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'tar' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'tar'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'gnu-tar'], win32: ['winget', 'install', '--id', 'GnuWin32.Tar', '-e'] },
    },
    docsUrl: 'https://www.gnu.org/software/tar/',
    matchers: [/\btar not found\b/i, /cannot extract .*\.tar/i, /install tar or bsdtar/i],
  },
  '7zip': {
    id: '7zip',
    label: '7-Zip (压缩归档)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: '7z' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'p7zip-full'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'p7zip'], win32: ['winget', 'install', '--id', '7zip.7zip', '-e'] },
    },
    docsUrl: 'https://www.7-zip.org/',
    matchers: [/7z not found/i, /install 7-?zip/i],
  },
  poppler: {
    id: 'poppler',
    label: 'Poppler (pdftoppm — PDF 转图)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'pdftoppm' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'poppler-utils'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'poppler'], win32: ['winget', 'install', '--id', 'oschwartz10612.Poppler', '-e'] },
    },
    docsUrl: 'https://poppler.freedesktop.org/',
    matchers: [/pdftoppm (not installed|not found)/i, /\bpoppler\b.*not (installed|found)/i],
  },
  semgrep: {
    id: 'semgrep',
    label: 'Semgrep (静态安全扫描)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'semgrep' },
    install: { manager: 'pip', command: ['pip', 'install', 'semgrep'], scope: 'global', needsNetwork: true, risk: 'medium' },
    docsUrl: 'https://semgrep.dev/docs/getting-started/',
    matchers: [/semgrep (not available|not found|unavailable)/i, /install semgrep/i],
  },
  sox: {
    id: 'sox',
    label: 'SoX (音频录制/转换)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'sox' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'sox'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'sox'], win32: ['winget', 'install', '--id', 'ChrisBagwell.SoX', '-e'] },
    },
    docsUrl: 'https://sox.sourceforge.net/',
    matchers: [/install sox/i, /\bsox\b.*not (installed|found)/i],
  },
  whisper: {
    id: 'whisper',
    label: 'OpenAI Whisper (语音转写)',
    kind: 'python-package',
    probe: { type: PROBE.COMMAND, bin: 'whisper' },
    install: { manager: 'pip', command: ['pip', 'install', 'openai-whisper'], scope: 'global', needsNetwork: true, risk: 'medium' },
    docsUrl: 'https://github.com/openai/whisper',
    matchers: [/no transcription engine available/i, /install whisper(\.cpp)?/i, /no stt provider available/i],
  },

  // ── 语言服务器（LSP）─────────────────────────────────────────────
  'lsp-typescript': {
    id: 'lsp-typescript',
    label: 'TypeScript Language Server',
    kind: 'node-module',
    probe: { type: PROBE.COMMAND, bin: 'typescript-language-server' },
    install: { manager: 'npm', command: ['npm', 'install', '-g', 'typescript-language-server', 'typescript'], scope: 'global', needsNetwork: true, risk: 'medium' },
    docsUrl: 'https://github.com/typescript-language-server/typescript-language-server',
    matchers: [/typescript-language-server.*not found/i],
  },
  'lsp-python': {
    id: 'lsp-python',
    label: 'Python LSP Server (pylsp)',
    kind: 'python-package',
    probe: { type: PROBE.COMMAND, bin: 'pylsp' },
    install: { manager: 'pip', command: ['pip', 'install', 'python-lsp-server'], scope: 'global', needsNetwork: true, risk: 'medium' },
    docsUrl: 'https://github.com/python-lsp/python-lsp-server',
    matchers: [/pylsp.*not found/i, /python-lsp-server/i, /install python-lsp-server/i],
  },
  'lsp-rust': {
    id: 'lsp-rust',
    label: 'rust-analyzer',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'rust-analyzer' },
    install: { manager: 'rustup', command: ['rustup', 'component', 'add', 'rust-analyzer'], scope: 'global', needsNetwork: true, risk: 'medium' },
    docsUrl: 'https://rust-analyzer.github.io/',
    matchers: [/rust-analyzer.*not found/i],
  },

  // ── Python 生态 ─────────────────────────────────────────────────
  python3: {
    id: 'python3',
    label: 'Python 3.10+ 运行时',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'python3' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'python3', 'python3-pip'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'python@3.12'], win32: ['winget', 'install', '--id', 'Python.Python.3.12', '-e'] },
    },
    docsUrl: 'https://www.python.org/downloads/',
    matchers: [/python3? not found/i, /install python 3/i, /python 3\.\d+\+/i],
  },
  torch: {
    id: 'torch',
    label: 'PyTorch',
    kind: 'python-package',
    probe: { type: PROBE.PYTHON_PACKAGE, pkg: 'torch' },
    install: { manager: 'pip', command: ['pip', 'install', 'torch'], scope: 'global', needsNetwork: true, risk: 'high' },
    docsUrl: 'https://pytorch.org/get-started/locally/',
    matchers: [/pytorch not found/i, /pip install torch/i, /\btorch\b.*not (installed|found|available)/i],
  },
  huggingface_hub: {
    id: 'huggingface_hub',
    label: 'huggingface_hub',
    kind: 'python-package',
    probe: { type: PROBE.PYTHON_PACKAGE, pkg: 'huggingface_hub' },
    install: { manager: 'pip', command: ['pip', 'install', 'huggingface_hub'], scope: 'global', needsNetwork: true, risk: 'medium' },
    docsUrl: 'https://huggingface.co/docs/huggingface_hub',
    matchers: [/huggingface_hub not installed/i, /pip install huggingface_hub/i],
  },
  'khy-os-doc-ocr': {
    id: 'khy-os-doc-ocr',
    label: 'Khy-OS 本地 OCR 扩展 (khy-os[doc])',
    kind: 'python-package',
    probe: { type: PROBE.PYTHON_PACKAGE, pkg: 'pytesseract' },
    install: { manager: 'pip', command: ['pip', 'install', 'khy-os[doc]'], scope: 'global', needsNetwork: true, risk: 'medium' },
    docsUrl: 'https://pypi.org/project/khy-os/',
    matchers: [/pip install khy-os\[doc\]/i, /install local ocr/i],
  },

  // ── 构建工具链（编译器 / 汇编 / 构建系统）─────────────────────────
  // compile_file / build_project 在遇到 ENOENT / "command not found" 时抛
  // MissingDependencyError(depId) 接入自愈层。安装命令仅取自本表（curated），
  // 全局作用域不自动 sudo（仅提示提权）。Windows 多走 winget，darwin 走 brew。
  gcc: {
    id: 'gcc',
    label: 'GCC (C 编译器)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'gcc' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'gcc'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['xcode-select', '--install'], win32: ['winget', 'install', '--id', 'BrechtSanders.WinLibs.POSIX.UCRT', '-e'] },
    },
    docsUrl: 'https://gcc.gnu.org/',
    matchers: [/\bgcc\b.*(not found|not installed|command not found)/i, /install gcc/i],
  },
  gpp: {
    id: 'gpp',
    label: 'G++ (C++ 编译器)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'g++' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'g++'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['xcode-select', '--install'], win32: ['winget', 'install', '--id', 'BrechtSanders.WinLibs.POSIX.UCRT', '-e'] },
    },
    docsUrl: 'https://gcc.gnu.org/',
    matchers: [/\bg\+\+\b.*(not found|not installed|command not found)/i, /install g\+\+/i],
  },
  clang: {
    id: 'clang',
    label: 'Clang (LLVM C/C++ 编译器)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'clang' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'clang'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['xcode-select', '--install'], win32: ['winget', 'install', '--id', 'LLVM.LLVM', '-e'] },
    },
    docsUrl: 'https://clang.llvm.org/',
    matchers: [/\bclang\b.*(not found|not installed|command not found)/i, /install clang/i],
  },
  make: {
    id: 'make',
    label: 'GNU Make (构建系统)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'make' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'make'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['xcode-select', '--install'], win32: ['winget', 'install', '--id', 'GnuWin32.Make', '-e'] },
    },
    docsUrl: 'https://www.gnu.org/software/make/',
    matchers: [/\bmake\b.*(not found|not installed|command not found)/i, /install make/i],
  },
  nasm: {
    id: 'nasm',
    label: 'NASM (x86 汇编器)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'nasm' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'nasm'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'nasm'], win32: ['winget', 'install', '--id', 'NASM.NASM', '-e'] },
    },
    docsUrl: 'https://www.nasm.us/',
    matchers: [/\bnasm\b.*(not found|not installed|command not found)/i, /install nasm/i],
  },
  cmake: {
    id: 'cmake',
    label: 'CMake (跨平台构建生成器)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'cmake' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'cmake'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'cmake'], win32: ['winget', 'install', '--id', 'Kitware.CMake', '-e'] },
    },
    docsUrl: 'https://cmake.org/',
    matchers: [/\bcmake\b.*(not found|not installed|command not found)/i, /install cmake/i],
  },
  rust: {
    id: 'rust',
    label: 'Rust 工具链 (rustc / cargo)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'rustc' },
    install: {
      // rustup 官方安装脚本需交互/网络；这里走包管理器提供的 rustc/cargo，
      // 不自动执行远端脚本（红线：安装命令仅取自本表）。
      manager: 'os', command: ['apt-get', 'install', '-y', 'rustc', 'cargo'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'rust'], win32: ['winget', 'install', '--id', 'Rustlang.Rustup', '-e'] },
    },
    docsUrl: 'https://www.rust-lang.org/tools/install',
    matchers: [/\brustc\b.*(not found|not installed|command not found)/i, /\bcargo\b.*(not found|command not found)/i, /install rust/i],
  },
  go: {
    id: 'go',
    label: 'Go 工具链',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'go' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'golang-go'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'go'], win32: ['winget', 'install', '--id', 'GoLang.Go', '-e'] },
    },
    docsUrl: 'https://go.dev/dl/',
    matchers: [/\bgo\b.*(not found|not installed|command not found)/i, /install golang/i],
  },
  openjdk: {
    id: 'openjdk',
    label: 'OpenJDK (javac / java)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'javac' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'default-jdk'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'openjdk'], win32: ['winget', 'install', '--id', 'EclipseAdoptium.Temurin.21.JDK', '-e'] },
    },
    docsUrl: 'https://adoptium.net/',
    matchers: [/\bjavac\b.*(not found|not installed|command not found)/i, /install (jdk|openjdk)/i],
  },
  dotnet: {
    id: 'dotnet',
    label: '.NET SDK (dotnet / csc)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'dotnet' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'dotnet-sdk-8.0'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'dotnet-sdk'], win32: ['winget', 'install', '--id', 'Microsoft.DotNet.SDK.8', '-e'] },
    },
    docsUrl: 'https://dotnet.microsoft.com/download',
    matchers: [/\bdotnet\b.*(not found|not installed|command not found)/i, /install \.net/i],
  },
  moonbit: {
    id: 'moonbit',
    label: 'MoonBit 工具链 (moon)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'moon' },
    install: {
      // MoonBit 官方仅提供安装脚本、无系统包。命令为 curated 静态一行（非取自报错
      // 文本/模型输入），且 scope:'global'+risk:'high' → 永不自动安装，仅作手动提示
      // 展示（installHint），绝不由 installRunner 自动执行远端脚本。
      manager: 'script',
      command: ['sh', '-c', 'curl -fsSL https://cli.moonbitlang.com/install/unix.sh | bash'],
      scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: false,
      platform: { win32: ['powershell', '-Command', 'irm https://cli.moonbitlang.com/install/powershell.ps1 | iex'] },
    },
    docsUrl: 'https://www.moonbitlang.com/download/',
    matchers: [/\bmoon\b.*(not found|not installed|command not found)/i, /install moonbit/i],
  },
  typescript: {
    id: 'typescript',
    label: 'TypeScript 编译器 (tsc)',
    kind: 'node-module',
    probe: { type: PROBE.COMMAND, bin: 'tsc' },
    install: { manager: 'npm', command: ['npm', 'install', '-g', 'typescript'], scope: 'global', needsNetwork: true, risk: 'medium' },
    docsUrl: 'https://www.typescriptlang.org/download',
    matchers: [/\btsc\b.*(not found|not installed|command not found)/i, /install typescript/i],
  },

  // ── 逆向工程：反编译器 / 反汇编器（DESIGN-ARCH-054 §4 toolOrchestrator）─────────
  // reverse_engineer 在 runTools 模式下若所属 family 无任何可用工具，会抛
  // MissingDependencyError(depId) 接入自愈层 → khy 主动申请批准后安装、校验、重试一次。
  // 安装命令仅取自本表（curated）；无干净跨平台包的工具（pycdc/baksmali/ghidra 在部分平台）
  // 缺省回落到 docsUrl 手动指引（诚实降级，绝不静默伪造）。
  binutils: {
    id: 'binutils',
    label: 'GNU Binutils (objdump / nm / readelf — 原生反汇编)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'objdump' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'binutils'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'binutils'], win32: ['winget', 'install', '--id', 'MSYS2.MSYS2', '-e'] },
    },
    docsUrl: 'https://www.gnu.org/software/binutils/',
    matchers: [/\b(objdump|readelf)\b.*(not found|not installed|command not found)/i, /install binutils/i],
  },
  radare2: {
    id: 'radare2',
    label: 'radare2 (逆向 / 反汇编框架)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'radare2' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'radare2'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'radare2'], win32: ['winget', 'install', '--id', 'radareorg.radare2', '-e'] },
    },
    docsUrl: 'https://rada.re/n/',
    matchers: [/\bradare2\b.*(not found|not installed|command not found)/i, /install radare2/i],
  },
  ghidra: {
    id: 'ghidra',
    label: 'Ghidra (NSA 反编译器 — analyzeHeadless)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'analyzeHeadless' },
    // 仅 darwin 有干净的 brew 包；linux/win 无官方包 → 回落 docsUrl 手动安装并把
    // analyzeHeadless 加入 PATH（诚实降级，autoInstallable=false）。
    install: {
      manager: 'os', command: ['brew', 'install', 'ghidra'], scope: 'global', needsNetwork: true, risk: 'high',
      platform: { darwin: ['brew', 'install', 'ghidra'] },
    },
    docsUrl: 'https://ghidra-sre.org/',
    matchers: [/\b(ghidra|analyzeHeadless)\b.*(not found|not installed|command not found)/i, /install ghidra/i],
  },
  jadx: {
    id: 'jadx',
    label: 'jadx (Android DEX/APK → Java 源)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'jadx' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'jadx'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'jadx'], win32: ['winget', 'install', '--id', 'skylot.jadx', '-e'] },
    },
    docsUrl: 'https://github.com/skylot/jadx',
    matchers: [/\bjadx\b.*(not found|not installed|command not found)/i, /install jadx/i],
  },
  'dex2jar': {
    id: 'dex2jar',
    label: 'dex2jar (Android DEX → JAR)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'd2j-dex2jar' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'dex2jar'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'dex2jar'] },
    },
    docsUrl: 'https://github.com/pxb1988/dex2jar',
    matchers: [/\b(d2j-dex2jar|dex2jar)\b.*(not found|not installed|command not found)/i, /install dex2jar/i],
  },
  baksmali: {
    id: 'baksmali',
    label: 'baksmali (Android DEX → smali)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'baksmali' },
    // smali 套件提供 baksmali；linux 无统一包 → 回落 docsUrl。
    install: {
      manager: 'os', command: ['brew', 'install', 'smali'], scope: 'global', needsNetwork: true, risk: 'high',
      platform: { darwin: ['brew', 'install', 'smali'] },
    },
    docsUrl: 'https://github.com/baksmali/smali',
    matchers: [/\bbaksmali\b.*(not found|not installed|command not found)/i, /install baksmali/i],
  },
  wabt: {
    id: 'wabt',
    label: 'WABT (wasm2wat / wasm-decompile — WebAssembly 反编译)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'wasm2wat' },
    install: {
      manager: 'os', command: ['apt-get', 'install', '-y', 'wabt'], scope: 'global', needsNetwork: true, risk: 'high', requiresElevation: true,
      platform: { darwin: ['brew', 'install', 'wabt'], win32: ['winget', 'install', '--id', 'WebAssembly.wabt', '-e'] },
    },
    docsUrl: 'https://github.com/WebAssembly/wabt',
    matchers: [/\b(wasm2wat|wasm-decompile|wabt)\b.*(not found|not installed|command not found)/i, /install wabt/i],
  },
  ilspycmd: {
    id: 'ilspycmd',
    label: 'ILSpyCmd (.NET 反编译)',
    kind: 'system-command',
    probe: { type: PROBE.COMMAND, bin: 'ilspycmd' },
    // 经 dotnet 全局工具安装；前置依赖 .NET SDK（dotnet），缺失时 dotnet 自身会触发 [[dotnet]] 自愈。
    install: { manager: 'dotnet', command: ['dotnet', 'tool', 'install', '-g', 'ilspycmd'], scope: 'global', needsNetwork: true, risk: 'medium' },
    docsUrl: 'https://github.com/icsharpcode/ILSpy',
    matchers: [/\bilspycmd\b.*(not found|not installed|command not found)/i, /install ilspycmd/i],
  },
  decompyle3: {
    id: 'decompyle3',
    label: 'decompyle3 (Python 字节码反编译)',
    kind: 'python-package',
    probe: { type: PROBE.COMMAND, bin: 'decompyle3' },
    install: { manager: 'pip', command: ['pip', 'install', 'decompyle3'], scope: 'global', needsNetwork: true, risk: 'medium' },
    docsUrl: 'https://github.com/rocky/python-decompile3',
    matchers: [/\bdecompyle3\b.*(not found|not installed|command not found)/i, /install decompyle3/i],
  },
  uncompyle6: {
    id: 'uncompyle6',
    label: 'uncompyle6 (Python 2/3 字节码反编译)',
    kind: 'python-package',
    probe: { type: PROBE.COMMAND, bin: 'uncompyle6' },
    install: { manager: 'pip', command: ['pip', 'install', 'uncompyle6'], scope: 'global', needsNetwork: true, risk: 'medium' },
    docsUrl: 'https://github.com/rocky/python-uncompyle6',
    matchers: [/\buncompyle6\b.*(not found|not installed|command not found)/i, /install uncompyle6/i],
  },
};

/** 返回某 depId 的定义（冻结副本浅引用，调用方不应改写）。 */
function getDependency(depId) {
  return DEPENDENCIES[depId] || null;
}

/** 列出全部 depId。 */
function listDependencyIds() {
  return Object.keys(DEPENDENCIES);
}

/** 列出全部定义（数组）。 */
function listDependencies() {
  return Object.values(DEPENDENCIES);
}

module.exports = {
  PROBE,
  DEPENDENCIES,
  getDependency,
  listDependencyIds,
  listDependencies,
};
