# DESIGN-ARCH-030 · 源端构建 + 目标机自愈运行（跨平台 pip 依赖带进度自愈）

> 状态：已实现（packaging/self-heal）
> 关联代码：`packaging/self-heal/templates/{entry.js,self_healer.js}`、`packaging/self-heal/build.sh`
> 关联测试：`packaging/self-heal/test/self-heal.test.js`（16 用例绿，零网络/零真实安装）
> 区分参照：`packaging/npm/scripts/devenv.js`（源端/开发期静默工具链自愈，**非**本规范范畴）
> 安全门禁参照：`setup.py` EXCLUDE_PATTERNS、`scripts/release/build-and-audit-pip-purity.sh`

## 1. 问题陈述（自调查痛点）

在当前 Linux 环境打包、分发到任意目标机（Windows/Linux/macOS）运行时的三个真实痛点：

1. **`ModuleNotFoundError` 直接崩溃**：目标机缺 pip 依赖，主程序启动即栈崩，终端用户无从下手。
2. **静默 `pip install`（误判卡死）**：自动装依赖若无视觉反馈，用户以为程序假死 → 强杀进程 →
   半装状态更糟。
3. **源端 Linux 包污染**：把 `.so` / `.dylib` / `__pycache__` / Linux 绝对路径打入分发包，
   目标 Windows/macOS 直接失效。

自调查结论：现有 `packaging/npm/scripts/devenv.js` 是**源端/开发期**跨语言工具链自愈，用
`pip install -q`（**静默**，只装 build/twine/pytest），既不解析 app 的 `requirements.txt`，
也无进度反馈、无 `--no-cache-dir`。本规范是**目标机/运行期**终端用户自愈，是新机制。

## 2. 两阶段生命周期（与目标 OS 解耦）

```
入口(entry.js) → 定位包根 → 读 requirements.txt
  → 依赖完整?(stamp 命中 = requirements 指纹一致)
      ├─ 是 → 【极速启动】直接拉起主程序（不探测、不安装，零打扰）
      └─ 否 → 【挂起主程序】→ 启动 self_healer
                 → 跨平台探测 Python/pip
                     ├─ 无 → 打印「需安装 Python」+ 官网链接 → 非零退出（不卡死）
                     └─ 有 → 探测/创建 venv → 解析 requirements
                              → pip install --no-cache-dir 逐包安装（实时进度条）
                                  ├─ 成功 → 写 stamp → 启动主程序
                                  └─ 失败 → 精确报错 + 手动修复指南 → 非零退出
```

「极速启动」由 `.khy_deps_stamp` 实现：内容 = `requirements.txt` 的零依赖指纹（FNV-ish 32 位 +
长度，无时间戳、可复现）。命中即跳过一切探测——这是「不影响主程序启动体验」的关键。

## 3. 源端打包约束（build.sh）

- **强制** `requirements.txt` 位于包根（缺失即拒绝打包）。
- **剥离** OS 专属产物：`__pycache__` / `*.pyc` / `*.pyo` / `*.pyd` / `*.so` / `*.so.*` /
  `*.dylib` / `.git` / `node_modules` / `.venv|venv|.khy_venv` / `*.egg-info` / `build` / `dist`。
- **扫描** Linux 绝对路径硬编码（`/home/*` `/usr/lib` `/usr/local` `/opt/` `/var/lib`）→ 告警列出
  （不阻断，交人工确认）。
- **注入** 引导器：`entry.js` + `self_healer.js` + 最小 `khy-dist.json`（记录 mainEntry）。
- **打包后审计**（防呆①硬门禁）：分发包内若仍含 `*.so`/`*.dylib`/`*.pyd`/`*.pyc`/`__pycache__`
  → 立即非零退出（剥离阶段删 + 审计阶段二次把关，双保险）。

## 4. 目标机自愈逻辑（self_healer.js，跨平台 + 带进度）

- **跨平台探测**：Windows 优先 `py -3`（官方启动器，覆盖未入 PATH 的常见情形），再退
  `python`/`python3`；POSIX 优先 `python3`。每候选校验 `--version` 与 `-m pip --version`。
- **隔离 venv**：复用已激活/既有 venv，否则建 `.khy_venv`；建失败退回系统解释器并补 `--user`
  规避权限。
- **进度渲染**（防呆②，绝不静默）：`ProgressRenderer` 旋转符 + 进度条 + 百分比；TTY 用 `\r`
  原地单行刷新，非 TTY（CI/重定向）降级逐行追加——两条路径都有视觉反馈。
- **安装命令恒带 `--no-cache-dir`**（防呆④，防跨平台缓存污染）+ `--disable-pip-version-check` +
  `--progress-bar on`。逐包安装，便于精确定位失败包。
- **失败降级**（绝不崩溃）：逐包失败 → 透出 req + 退出码 + pip stderr 尾部 + 可复制的手动修复命令
  （同样带 `--no-cache-dir`）。

## 5. 防呆（硬约束，已逐条测试）

- **①绝不打入 Linux 专用二进制**：build.sh 剥离阶段删 `.so/.dylib/.pyd`，**且**打包后审计二次扫描，
  发现即非零退出。（测试：注入 `native.so` + `__pycache__` → 包内确认被剥离）
- **②绝不静默 pip install**：任何安装期持续渲染进度条/旋转符；TTY `\r` 原地、非 TTY 逐行。
  （测试：非 TTY 逐包进度行可见；TTY 输出含 `\r`）
- **③无 Python/pip → 提示官网链接，禁止卡死**：返回 `needs-python` + `https://www.python.org/downloads/`，
  entry.js 据此非零退出（code 2），不启动主程序、不挂事件循环。（测试：win32 无解释器 → needs-python）
- **④pip 命令恒带 `--no-cache-dir`**：`pipBaseArgs` 与失败指南命令均含。（测试：每条 install 调用断言含之）

## 6. 交付物

```
packaging/self-heal/templates/self_healer.js  跨平台探测+venv+解析+带进度安装+失败指南（零依赖，可注入）
packaging/self-heal/templates/entry.js        目标机入口：stamp 极速启动 / 挂起自愈 / 非零退出不卡死
packaging/self-heal/build.sh                  源端打包：强制 requirements + 剥离 + 扫描 + 注入 + 审计
packaging/self-heal/test/self-heal.test.js    16 用例（含 build.sh 真实 shell smoke）
```

## 7. 验收（16 用例绿，零网络/零真实安装/零真实 pip）

- self_healer：跨平台候选顺序；requirements 解析（去注释/保留 marker）；`--no-cache-dir` 恒在；
  无 Python→官网链接不卡死；非 TTY 逐行 + TTY `\r` 进度；逐包失败→精确报错+手动指南；
  macOS venv 内安装无 `--user`。
- entry：指纹随内容变化；stamp 命中极速启动（不探测/不安装）；未命中→自愈→写 stamp→启动；
  无 Python→非零退出不启动主程序；安装失败→code 1；无 requirements→极速启动。
- build.sh（真实执行）：剥离 `*.so`/`__pycache__`、强制 requirements 在根、注入引导器、审计通过；
  缺 requirements→拒绝打包非零退出。

全部依赖注入（spawn/fs/平台/输出/自愈器），测试用纯内存桩，不触真实网络/pip/FS（除 build.sh 的隔离 tmp）。

## 8. 配套铁律规范 DEPLOY_PIP_SPEC.md（GOAL 5）

本设计的行为约束已固化为可跨会话、跨协作者持久的铁律规范，杜绝下次打包按默认逻辑推倒重来：

- **`packaging/self-heal/DEPLOY_PIP_SPEC.md`** — 《跨平台自愈部署规范：pip 依赖管理分册》。
  行 1 为 `<!-- AI-INSTRUCTION -->` 块（任何 AI 处理 pip/打包/部署任务必先解析）；
  五章各带【强制校验点 §1-§5】；§6 含可粘进 System Prompt 的 `AI_SYSTEM_PROMPT_APPENDIX`（≤100 字）。
  用词纪律：只用「必须/严禁/强制」，不用「建议/最好」。
- **`packaging/self-heal/check_pip_deploy.sh`** — 发包前只读静态扫描器（违规 `exit 2`）：
  §1 requirements 在根 + `==` 锁定 + 非 pip 声明混入 + OS 二进制；§4 hard/soft 分区混排；
  §5 宪法红线（`sudo pip` / 全局覆盖路径 / 跨语言混装）正则拦截。

为使规范不自相矛盾，§2-§5 落规范前已先把本设计的参考实现对齐到规范铁律：探测优先级统一为
`python3 -m pip > python -m pip > pip3 > pip`（新增 pip3/pip 直连降级档）；venv 目标由 `.khy_venv`
改为项目级 `./.venv`（宪法红线：绝不复用/覆盖全局 venv）；新增 hard-dep/soft-dep 分组语义
（`# [hard-dep]`/`# [soft-dep]`，soft 失败跳过不阻断，hard 失败立即中止）。测试由 16 增至 **29 用例绿**。
