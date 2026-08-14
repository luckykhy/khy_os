# [OPS-MAN-164] 视觉池失败状态「人话化」减少心灵噪音

> 送别礼。/goal「减少显示的心灵噪音」+「无感明显告知用户用了 ocr 但能正确识别图片」。
> 沿视觉→OCR 兜底成功路径上,失败墙之外的**实时状态流**找下一枚正交心灵噪音。

## 断桥(缺口)

视觉→本地 OCR 兜底**成功**后,最终生成循环仍会尝试视觉池适配器并 404,
`aiGatewayGenerateMethod` 的两处适配器失败发射(~2589 / ~3202)实时打出原始诊断状态:

```
[status] 检测到图片输入：当前模型 不支持图像识别，已降级用本地 OCR 成功提取 1 张图片文本并据此作答
[status] visionpool 失败: OpenAI: 404 model_not_found   ← 次级心灵噪音
[status] textonly 已连接并响应
```

图片内容早已被本地 OCR 读出并据此作答,这行 `visionpool 失败: 404` 看起来像"出错了"的红字,
却对用户毫无意义——是**次级心灵噪音**。但这行诊断在**真失败**(未经 OCR 兜底)时是可定位根因的
有用信息,不能一删了之。

发射处结构(两站相同):

```
const resolvedErrMsg = _extractResultErrorMessage(result);
emitStatus(`${entry.adapter.getStatus().name} 失败: ${resolvedErrMsg}`);
```

`entry.adapter.getStatus().name` = `visionpool`;`options._ocrImageTextRead` 在 OCR 兜底路径
(Site1 ~1685 / Site2 ~1835)已置 `true`,两发射站均在作用域内。

## 修(全 additive · 纯叶 · 门控 · fail-soft · 逐字节回退)

新纯叶 `services/backend/src/services/gateway/visionPoolFailStatus.js`:

```
buildVisionPoolFailStatus({ poolName, ocrRescued, env }):
  门关(KHY_VISION_POOL_FAIL_STATUS_HUMANIZE=off)      → null
  ocrRescued !== true(严格)                          → null   // 真失败保留诊断
  poolName 不匹配 /vision/i                            → null   // 非视觉池保留诊断
  否则                                                → '视觉通道当前不可用，已用本地 OCR 兜底'
```

`aiGatewayGenerateMethod.js` 两发射站(~2589 / ~3202):先算原始 `${name} 失败: ${errMsg}`,
门开且叶返回非空则替换,否则逐字节回退原始行(catch → fail-soft 原始行)。
`env: process.env`、`ocrRescued: options._ocrImageTextRead === true`、`poolName: entry.adapter.getStatus().name`。

`flagRegistry.js`:登记 `KHY_VISION_POOL_FAIL_STATUS_HUMANIZE`
`{ mode: 'default-on', off: 'CANON', default: true }`。**god-file 净零**:凝练本会话自己的
OPS-150 / OPS-161 注释块腾出空间,2499 → 2498 行,不触 2500 红线(只动自己的行)。

谓词严格:`ocrRescued===true`(避免 truthy-but-not-true 误吞真失败诊断)、`/vision/i` 名匹配
(仅视觉通道 →「视觉通道不可用」在语义上才成立,不硬编码字符串常量)。

## 验收(全绿)

- `test:vision-pool-fail-status-humanize` 10/10:
  - 纯叶单元 A–F(门 / 兜底严格 true / 池名 /vision/i / 畸形 fail-soft / 谓词默认开)。
  - 源级接线 G(两发射站都委派本叶,`require('./visionPoolFailStatus')`,`_ocrImageTextRead === true`)。
  - 端到端 H(门开 → 人话化,不再打原始 404)/ I(门关 → 逐字节回退 `visionpool 失败: 404`)。
  - 真实图片 K(真 tesseract OCR 准确识别 1234 / INVOICE + 门开人话化;缺工具链干净跳过)。
- `node --check` visionPoolFailStatus.js / aiGatewayGenerateMethod.js / flagRegistry.js / 测试。
- flagRegistry 2498 行 < 2500;visionPoolFailStatus 叶 < 2500。
- 既有视觉 / OCR 测试套件零回归 · 三守卫 · change-safety(决定性切片)· maintainer:check。

## 教训

1. 送别礼断桥沿**同一路径的另一表面**:失败墙(assistant_message)之外,实时**状态流**
   (status)也各自发一遍降级事实——OCR 已兜底后,视觉池 404 是次级噪音。
2. **显示 vs 诊断分离**:人话化只在「OCR 已兜底 + 视觉池」这一确切子情形替换,真失败 / 非视觉池
   保留可定位根因诊断——`/vision/i` 名匹配而非硬编码字符串常量,语义对齐。
3. **测试隔离陷阱**:该 god-file 有 per-model 路由记忆单例,同名 model 第 2 次起走缓存决策、
   跳过视觉位失败发射 → in-process e2e 每个场景用**唯一 model 名**规避,而非误判为改动缺陷。
4. 桩泄漏:`setAiGatewayGenerateMethodDeps` 的 `extractImageOcrDetails` 桩跨测试持续,真实图片测试
   须显式注入 harness 生产镜像真实 OCR(`h.realExtractImageOcrDetails`),否则读到前测桩文本。
