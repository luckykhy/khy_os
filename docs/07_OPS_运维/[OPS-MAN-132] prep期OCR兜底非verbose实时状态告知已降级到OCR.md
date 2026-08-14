# [OPS-MAN-132] prep 期 OCR 兜底非-verbose 实时状态告知已降级到 OCR

> 承 OPS-124(模型 prompt 指令)/ OPS-126(finishResult 确定性脚注)/ OPS-127(救援网 Site3 实时状态)。
> 本轮补齐**实时进度层的 prep 期非-verbose 缺口**。
> 直击 /goal「Khy 无法正确读图降级到 OCR,要能无感明显告知用户用了 OCR 但能正确识别图片」。

## 一、断桥(与 OPS-127 正交:同一实时进度层的 prep 期非-verbose 缺口)

OPS-127 补齐了 Site3(post-failure 救援网)OCR-成功分支的实时状态,但 prep 期 Site1/Site2 的既有
OCR-成功 emitStatus **一直嵌在 `if (_isVerbose)` 里**:

| 站点 | 位置 | prep 期既有 OCR-成功实时状态 |
| --- | --- | --- |
| Site1(describe 级联全失败) | `aiGatewayGenerateMethod.js` ~1618 | `if (_isVerbose) emitStatus('…OCR 兜底…')` |
| Site2(prep ocr-fallback) | `aiGatewayGenerateMethod.js` ~1692 | `if (_isVerbose) emitStatus('…已用 OCR 提取 N 张图片文本兜底')` |

于是**非 verbose 会话**(默认 `KHY_STATUS_VERBOSITY=auto`)在 prep 期发生 OCR 降级时,实时进度层
依旧一片沉默——答复层由 OPS-124/126 兜住,但当场不可见,与 OPS-127 已补齐为**无条件**的 Site3 形成
不对称。

**判据(方法论签名)**:OPS-127 把 Site3 成功状态做成**无条件**(不受 verbose 约束,理由是「明显告知」
要求交互当下也可见);而 prep 期 Site1/Site2 的等价告知**仍受 `_isVerbose` 门控** → 非 verbose 用户
在 prep 期 OCR 降级时缺一条实时告知。同一层内 Site3(无条件)vs Site1/Site2(仅 verbose)的不对称。

## 二、修复(全 additive · 独立 default-on 门 KHY_OCR_RESCUE_STATUS_PREP · 门关逐字节回退)

复用 OPS-127 的纯叶 `ocrRescueStatusNotice.js`,新增与 `buildOcrRescueStatus` **正交**的 prep 变体:

- `isRescuePrepStatusEnabled(env)` — 读门 `KHY_OCR_RESCUE_STATUS_PREP`(异常保守 false,绝不抛)。
- `buildOcrRescuePrepStatus({ count, modelName, env })` — 门开且 `count>0` 时返回实时状态串
  `检测到图片输入：{modelName} 不支持图像识别，已降级用本地 OCR 成功提取 {N 张图片}文本并据此作答`;
  门关 / count 非正 / 畸形 → `null`;零 IO,绝不抛。与 Site3 变体唯一差异:主语用「模型」而非
  「适配器」(prep 期尚未落到具体适配器),且**独立门** `KHY_OCR_RESCUE_STATUS_PREP`(与 Site3 的
  `KHY_OCR_RESCUE_STATUS` 分开,单独字节回退)。
- 接线 `aiGatewayGenerateMethod.js` Site1(~1591)/ Site2(~1704)OCR-成功分支,**仅 `!_isVerbose`**
  时补一条(verbose 用户已有既有状态,`!_isVerbose` 守卫避免重复):
  ```js
  if (!_isVerbose) {
    try {
      const _prep = require('./ocrRescueStatusNotice').buildOcrRescuePrepStatus({
        count: ocrTexts.length, modelName: _primaryModel, env: process.env,
      });
      if (_prep) emitStatus(_prep);
    } catch { /* fail-soft:叶不可用则按历史静默 */ }
  }
  ```
  门关 → 叶返 null → 不 emitStatus → 逐字节回退「非 verbose prep 期静默」。
- `flagRegistry.js` 登记 `KHY_OCR_RESCUE_STATUS_PREP: { mode: 'default-on', off: 'CANON', default: true }`。

### 四层正交(全服务「无感明显告知用户用了 OCR」)

- OPS-124 = 面向**模型**的 prompt **指令**(答复层,advisory)。
- OPS-126 = finishResult 确定性**脚注**(答复层,guaranteed)。
- OPS-127 = 救援网 Site3 确定性**实时状态**(实时进度层,guaranteed,无条件)。
- **OPS-132 = prep 期 Site1/Site2 确定性**实时状态**(实时进度层,专补非 verbose 缺口,`!_isVerbose` 守卫不重复)。

## 三、验证门(全绿才回报)

- `npm run test:ocr-rescue-status-prep`:纯叶 9 + wiring 3 + 真图 2 = **14/14**。
  - 纯叶(`ocrRescueStatusPrep.test.js`):PREP_FLAG 名固定且与 Site3 门分开、门 default-on/off-words、
    单复数、modelName 缺省/裁剪、count 畸形→null、独立门互不影响、fail-soft。
  - wiring(`ocrRescueStatusPrepWiring.test.js`,纯文本模型带图→ocr-fallback→Site2,onChunk 收
    `{type:'status'}`):A 非 verbose+门开+OCR 有文本→prep 状态出现且 OCR 文本仍注入(修复点);
    B verbose→新 prep 状态被 `!_isVerbose` 守卫挡下、既有 verbose 状态承担(不重复);
    C 门关→prep 状态不出现(逐字节回退),OCR 文本照旧注入。
  - 真图(`ocrRescueStatusPrepRealImage.test.js`,PIL 渲 `INVOICE 1234` → 真 tesseract 读出 → prep
    Site2):非 verbose+门开→实时状态出现「已降级用本地 OCR 成功提取」且 prompt 含 `/INVOICE/`;
    门关→prep 状态不出现,OCR 文本照旧注入。缺 tesseract/eng/Pillow 或未读出目标词 → skip。
- `node --check` × 改动文件全绿。
- `npm run arch:god`:改动文件不得新增超限(`aiGatewayGenerateMethod.js` additive,4 超限为 pre-existing)。
- 三守卫 `--changed`(显式文件列表)/ `npm run maintainer:check` / metadata refresh 2-pass 幂等。

## HOW-TO-EXTEND

- prep 状态措辞:改 `ocrRescueStatusNotice.js` 的 `buildOcrRescuePrepStatus`(与 Site3 的
  `buildOcrRescueStatus` 分开维护,避免误改另一处)。
- 若要让 verbose 用户也走新 prep 状态:去掉调用点的 `!_isVerbose` 守卫(注意会与既有 verbose
  状态重复,需同时删既有那条)。
- 门开关:`KHY_OCR_RESCUE_STATUS_PREP`(default-on,显式 `0/false/off/no` 关)。
