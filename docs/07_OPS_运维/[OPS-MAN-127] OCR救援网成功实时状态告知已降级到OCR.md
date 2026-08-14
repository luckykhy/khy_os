# [OPS-MAN-127] OCR 救援网成功实时状态告知已降级到 OCR

> 承 OPS-124(模型 prompt 指令)/ OPS-126(finishResult 确定性脚注)。本轮补齐**实时进度层**。
> 直击 /goal「Khy 无法正确读图降级到 OCR,要能无感明显告知用户用了 OCR 但能正确识别图片」。

## 一、断桥(与 OPS-124/126 正交的第三层:实时进度层)

vision→OCR 兜底有三处 OCR-成功注入点(`aiGatewayGenerateMethod.js`)。prep 期两处成功时**都发一条实时状态**当场告诉用户已降级到 OCR:

| 站点 | 位置 | OCR 成功实时状态 |
| --- | --- | --- |
| Site1(describe 级联全失败) | ~1619 | `emitStatus('…已诚实说明并剥图/OCR 兜底…')` ✓ |
| Site2(prep ocr-fallback) | ~1693 | `emitStatus('…已用 OCR 提取 N 张图片文本兜底')` ✓ |
| **Site3(post-failure 救援网)** | ~2857 | **历史上无 emitStatus** ✗ |

Site3 的 emitStatus 仅覆盖 OCR **失败/无文本**(切视觉适配器,2859/2862/2865),其 **OCR-成功**分支从不发状态。而 Site3 正是用户实测复现的那条路径:

```
gpt-4o → keep(图保留到主级联) → 运行时某适配器 404 model_not_found 拒图
  → shouldOcrRescue 提升 _visionFallback → 救援网退回本地 OCR
```

于是恰在复现路径上,OCR 成功降级发生时**实时进度层一片沉默**:用户只看到一墙视觉失败状态,看不到「已降级到本地 OCR 并成功识别」的当场告知。答复层由 OPS-124/126 兜住,但「明显告知」要求在**交互当下**也可见。

**判据(方法论签名)**:同一救援网内,「prep 期 Site1/Site2 的 OCR-成功都发实时状态」vs「Site3(救援网)的 OCR-成功分支从不 emitStatus」的不对称——恰在用户复现路径上缺一条实时告知。

## 二、修复(全 additive · 独立 default-on 门 KHY_OCR_RESCUE_STATUS · 门关逐字节回退)

- 纯叶 `services/backend/src/services/gateway/ocrRescueStatusNotice.js`:
  - `isRescueStatusEnabled(env)` — 读门 `KHY_OCR_RESCUE_STATUS`(异常保守 false,绝不抛)。
  - `buildOcrRescueStatus({ count, adapterName, env })` — 门开且 `count>0` 时返回实时状态串
    `检测到图片输入：{adapterName} 不支持图像识别，已降级用本地 OCR 成功提取 {N 张图片}文本并据此作答`;
    门关 / count 非正 / 畸形 → `null`(调用方据此决定是否 emitStatus);零 IO,绝不抛。
- 接线 `aiGatewayGenerateMethod.js` Site3 OCR-成功分支(options 重建后):
  ```js
  try {
    const _msg = require('./ocrRescueStatusNotice').buildOcrRescueStatus({
      count: ocrTexts.length, adapterName: adapterDisplayName, env: process.env,
    });
    if (_msg) emitStatus(_msg);
  } catch { /* fail-soft:叶不可用则按历史静默 */ }
  ```
  门关 → 叶返 null → 不 emitStatus → 逐字节回退「Site3 成功分支静默」。
- `flagRegistry.js` 登记 `KHY_OCR_RESCUE_STATUS: { mode: 'default-on', off: 'CANON', default: true }`。

### 三层正交(全服务「无感明显告知用户用了 OCR」)

- OPS-124 = 面向**模型**的 prompt **指令**(答复层,advisory,模型合规时无感)。
- OPS-126 = finishResult 确定性**脚注**(答复层,guaranteed,模型忽略指令时兜底明显)。
- **OPS-127 = 救援网确定性**实时状态**(实时进度层,guaranteed,降级发生当场明显)。

## 三、验证门(全绿才回报)

- `npm run test:ocr-rescue-status`:纯叶 8 + wiring 3 + 真图 2 = **13/13**。
  - 纯叶:门 default-on/off-words、单复数、count 畸形→null、adapterName 缺省/裁剪、fail-soft。
  - wiring(双适配器 gpt-4o→404→Site3,onChunk 收 `{type:'status'}`):A 门开+OCR 有文本→救援网状态出现且 OCR 文本仍注入(修复点);B 门关→救援网状态不出现(逐字节回退)且 OCR 文本照旧注入;C OCR 无文本→成功分支未进入→救援网状态不出现,答复仍成功。
  - 真图(PIL 渲 `INVOICE 1234` → 真 tesseract 读出 → Site3):门开→实时状态出现「已降级用本地 OCR 成功提取」且 prompt 含 `/INVOICE/`;门关→救援网状态不出现,OCR 文本照旧注入。缺 tesseract/eng/Pillow 或未读出目标词 → skip。
- `node --check` × 改动文件全绿。
- `npm run arch:god`:改动文件不得新增超限(aiGatewayGenerateMethod.js additive,4 超限为 pre-existing)。
- 三守卫 `--changed`(显式文件列表)/ `npm run maintainer:check` / metadata refresh 2-pass 幂等。

## 四、红线遵守

- 不自动 commit/push。
- 只碰实时状态串,不触密钥。
- 全 additive,门关逐字节回退历史行为。
