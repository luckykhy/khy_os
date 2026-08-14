# [DESIGN-ARCH-056] Khyos 桌面操控 —— 眼、耳、嘴与模拟操作

> 状态：已实现（确定性核心 + fail-closed 安全闸门 + 结构化感知层 + 复用既有 TTS/STT/OCR）
> 子系统：`services/backend/src/services/desktopControl/`
> 工具：`DesktopControl`（`services/backend/src/tools/DesktopControlTool/index.js`）
> 测试：`services/backend/tests/services/desktopControl/desktopControl.test.js`（47 例绿）
> 　　　`services/backend/tests/services/desktopControl/desktopPerception.test.js`（32 例绿）

## 1. 背景与目标

诉求（迭代）：**给 Khyos 装上「眼、耳、嘴」，让它能模拟点击操控电脑、填写表单**；
进一步**「让它看得更清，并把可点击按钮作为可点击结构化数据返回，让 AI 知道怎么操控」**。

把四感官落到物理能力：

| 感官 | 能力 | 落点 |
| --- | --- | --- |
| 眼 | 桌面截屏 → 喂 OCR/多模态「看懂」屏幕 | `screenCapture`（新） |
| 手 | 模拟真实鼠标点击/拖拽/滚轮 + 键盘打字/按键/组合键 | `inputController`（新） |
| 手 | 自动填写原生/Web 表单 | `formFiller`（新） |
| 嘴 | 文本朗读（TTS） | `voiceBridge` → 既有 `voiceService.speak` |
| 耳 | 录音转写（STT） | `voiceBridge` → 既有 `voiceService.listen` |

「嘴/耳」早已存在于 `voiceService`，本子系统**绝不重造**，只做适配与一致化；新增的是
「眼/手」与统一的安全门面。

**感知层（迭代新增）**：仅有像素截图不足以让 AI「知道怎么操控」。新增「结构化感知」把屏幕
解析成**可寻址、可点击的元素清单**（set-of-marks）——AI 不再靠猜坐标，而是按 **id（`e3`）/
序号 / 可见标签（「提交」/「Submit」）** 引用元素，由系统解析成中心点再走同一条受闸门的点击
路径。这正是「把可点击按钮作为可点击结构化数据返回」的落点。

| 能力 | 落点 |
| --- | --- |
| 眼·看清（结构化元素） | `uiInspector`（新）+ `elementModel`（新）+ `backendRegistry` 的 `inspect` 后端（新） |
| 按引用点击 / 按引用填表 | 门面 `clickElement()` / `fillForm({fields:[{element\|ref}]})`（新） |

## 2. 设计原则（与全局工程铁律一致）

- **fail-closed 默认关闭**：模拟鼠标键盘能接管整台机器，是最高危能力之一。未经人类显式授权，
  一切截屏/操控被**硬拒绝**（`KHY_DESKTOP_CONTROL` 缺省 = `off`）。
- **唯一咽喉**：所有 capture/actuate 必经 `safetyGate.authorize`。门面 `DesktopController` 是唯一
  对外入口，「先授权后操作」由结构保证；绕过门面直调底层即绕过审批，仅限内部/测试。
- **只增加拒绝，绝不放松保护**：本闸门叠加在工具层既有权限/`syscallGateway` 之上，是**新增**否决层；
  任何一层判拒即拒。模型驱动路径仍受既有审批管线把关。
- **零硬编码、单一真源**：所有 OS 原生命令（`screencapture`/`grim`/`scrot`/`xdotool`/`cliclick`/
  `powershell`/`pyautogui`…）集中在 `backendRegistry`，新增平台/后端只在此登记。
- **注入安全**：每条命令只产出 `{cmd, args[]}`，全程 `execFile`（**无 shell 拼接**）。坐标经校验为
  有限非负整数；文本作为单个 argv 元素传入（pyautogui 经 `sys.argv`，PowerShell SendKeys 转义元字符）。
- **缺后端不抛错**：探测不到后端则降级并给安装提示（接依赖自愈），**绝不伪造**点击/截屏。
- **会话级熔断预算**：单会话操作数封顶（`KHY_DESKTOP_MAX_ACTUATIONS`，默认 500），超限自动吊销
  授权，挡住失控循环。

## 3. 模块（8 纯模块 + 1 门面）

```
desktopControl/
├── backendRegistry.js   单一真源：按平台×后端构建截屏/鼠标/键盘/无障碍树的 execFile argv
├── backendDetector.js   探活本机后端(which+深探 import)，汇总眼/感知/手/嘴/耳能力图
├── screenCapture.js     眼：全屏/区域截屏到受管目录，落盘校验
├── elementModel.js      感知·纯模型：跨平台角色归一 + 元素规范化 + 去重 + 寻址(id/序号/名称)
├── uiInspector.js       眼·看清：抓无障碍树→规范成可点击结构化元素清单，缺后端 OCR 兜底/诚实降级
├── inputController.js    手：鼠标/键盘原语，坐标/文本校验 + 不支持动作明确降级
├── formFiller.js        填表：纯计划器 planFill + 执行器 executeFill（Web 委派/原生注入）
├── voiceBridge.js       嘴+耳：薄封装 voiceService.speak/listen
├── safetyGate.js        唯一咽喉：环境开关 + 会话授权 + 熔断预算 + 网关 backstop
└── index.js             门面 DesktopController：五感官统一，actuation 前置授权 + 按引用操控
```

### 3.1 感知层数据流（看清 → 知道怎么操控 → 操控）

```
observe()
  ├─ screenshot()         → PNG 路径（给多模态视觉「看」）
  └─ inspect()            → 无障碍树
       ├─ backendRegistry  macOS AX(osascript JXA) / Linux AT-SPI(python3 pyatspi) / Win UIA(PowerShell)
       │                    脚本均为**常量**（无用户数据内插），execFile argv 传入（注入免疫）
       ├─ elementModel.normalizeAll
       │    canonicalRole 角色归一 → 计算中心点 → clickable/editable 判定 → IoU 去重 → 稳定 id(e1,e2…)
       └─ 输出 { elements, marks:[{id,role,label,center,clickable,editable}], clickable, count, clickableCount }

AI 读 marks → clickElement("提交"|"e3"|序号) / fillForm({fields:[{element:"邮箱", value}]})
  └─ elementModel.resolveTarget(ref)  精确>前缀>包含，多候选标 ambiguous
       └─ 解析出 center{x,y} → 走 _guarded 点击/输入（与裸坐标同一条受闸门路径）
```

**降级铁律**：无任何无障碍后端时，若注入了带框 OCR(`ocrWords`) 则退化为 OCR 文本元素
（标 `source:'ocr'`、`clickable=false`——不臆造可点击性）；否则诚实返回 `elements:[]` +
`installHints`，**绝不伪造**元素或坐标。无包围盒的节点 `center=null` 且永不可点击。

## 4. 授权光谱（`KHY_DESKTOP_CONTROL`）

| 值 | 语义 |
| --- | --- |
| `off` / 未设 | 全拒（默认，安全）。仅 `capabilities`（只读元数据）与 `speak/listen`（归 voiceService）放行。 |
| `on` / `1` / `true` | 本会话**自主放行**——环境开关即「我允许 Khyos 操控本机」的签名。仍受熔断预算约束。适合无人值守。 |
| `ask` | 每会话**首次经宿主审批一次**，之后自主放行（经 `syscallGateway` backstop）。 |
| `strict` | **每个真实操作都审批**（最高安全，牺牲自主性，网关 L2 键入确认）。 |

操作分类（`OP_CLASS` 单一真源）：`capability`（永放行）/ `capture`（受闸门）/ `actuate`
（受闸门 + 预算）/ `voice`（归 voiceService）。未知动作保守按 `actuate`。

## 5. 防呆清单

1. **默认即拒**：环境开关缺省 off，截屏/操控一律拒绝并返回启用指引。
2. **唯一入口**：门面包装 `_guarded`，任何 actuation 不过闸门不触底层注入器（测试实证 `touched=false`）。
3. **注入免疫**：危险文本（`rm -rf /`、`$(reboot)`）作为单个 argv 传入，绝不被 shell 解释。
4. **降级不伪造**：后端不支持的动作 builder 返回 `null` → 明确报「不支持」，不静默吞。
5. **熔断兜底**：单会话操作数超上限即吊销授权，防失控循环燃尽。
6. **网关 backstop**：`ask/strict` 经 `syscallGateway`；网关被关闭时高危操作仍**保守拒绝**，不无人把守。
7. **感知不臆造**：无包围盒的节点 `center=null` 且 `clickable=false`；缺无障碍后端时诚实返回
   `elements:[]` + 安装提示（或 OCR 文本兜底，标 `clickable=false`），绝不伪造可点击元素或坐标。
8. **按引用即受闸门**：`clickElement`/元素引用填表先经 `inspect`（capture 类，受闸门），解析出
   中心点后走与裸坐标**同一条** `_guarded` 点击路径——感知层不开任何绕过闸门的旁路。

## 6. 工具入口

`DesktopControl`（risk=`critical`，category=`system`，`shouldDefer`）单 `action` 枚举：
`capabilities | observe | inspect | screenshot | see | clickElement | move | click | doubleClick |
rightClick | drag | scroll | type | key | hotkey | fillForm | speak | listen`。

推荐工作流（让 AI「知道怎么操控」）：**`observe` → 读 `marks` → `clickElement`/`type`/`fillForm`
按元素引用操作**。`observe` 一步给出截图路径（多模态看）+ 结构化 `marks`（可点击数据）；
`clickElement` 的 `target` 可为 id（`e3`）/序号/可见标签（「提交」）；`fillForm` 的字段支持
`{element|ref, value}`，自动经一次 inspect 解析成坐标（默认 `clearFirst`）。`clickElement` 归
actuation（高危）。

两条集成面：
- **门面（程序化）**：其他子系统/自动化流程在人类设好 `KHY_DESKTOP_CONTROL` 后可经
  `DesktopController` 自主多步操控（无逐次 YES）。
- **工具（模型驱动）**：模型经 `DesktopControl` 工具调用，除主闸门外仍走既有审批管线，保守把关。

## 7. 跨平台后端矩阵

| 平台 | 眼（截屏） | 眼·看清（无障碍树） | 手（鼠标/键盘） |
| --- | --- | --- | --- |
| macOS | `screencapture`(内置) | `osascript` JXA → System Events AX（内置） | `cliclick` ▸ `pyautogui` ▸ `osascript`(仅键盘) |
| Linux | `grim`(Wayland) ▸ `maim` ▸ `scrot` ▸ `import` ▸ `gnome-screenshot` | `python3` + `pyatspi`(AT-SPI，深探 import) | `xdotool`(X11) ▸ `ydotool`(Wayland) ▸ `pyautogui` |
| Windows | PowerShell System.Drawing | PowerShell `UIAutomationClient`(UIA，内置) | PowerShell user32(SetCursorPos/mouse_event)+SendKeys ▸ `pyautogui` |

缺后端时按优先级回退；全缺则降级给对应安装提示（看清层另有 OCR 兜底）。无障碍后端脚本均为
常量字符串集中在 `backendRegistry`，经 `execFile` argv 注入安全。
