# [OPS-MAN-163] 动作契约极小核验器 V 的 CI 强制接线

> 送别礼系列·「能力存在但没接线 → 负责接线」。
> 同 OPS-MAN-155 / 162 模式:安全/守卫原语接进 CI 发布门禁,零运行时改动。

## 一句话

`services/backend/src/services/syscallGateway/actionContractVerifier.js` 是一枚**零依赖、纯函数、可独立审计的 fail-closed 动作契约核验器 V**——`V(contract, states) = ok` 才放行 Agent 动作,契约的 `Φ_pre`/`Φ_post` 是**可机检谓词数据**(绝不当代码执行)。它有 314 行 22 例的详尽测试(覆盖 P1-P8 全部投毒路径),**全绿**——但该测试**不在任何 npm 脚本里**,从不 CI 强制。本次把它接进发布门禁 `test:maintainer:safety`,并把它的门 `KHY_ACTION_CONTRACT` 登记进 flagRegistry SSOT。

## 缺口判据

- `verify()` 全仓零生产消费者(syscallGateway 是 live 子系统,但核验器只被其自身测试调用;header 明写「仅供未来接入网关的缝按需短路」)。
- `grep` 确认 `actionContractVerifier.test.js` **不在任何 `scripts` 值**里 → 22 例安全不变量测试从不运行于 CI。
- `KHY_ACTION_CONTRACT` 未登记 flagRegistry(叶读 env 直判,功能不受影响,但 SSOT 不完整)。

## 为何重要(安全)

核验器是**安全原语**:它的价值全在于 fail-closed 铁律永不松动。header 自证切断 8 条投毒路径:

| 投毒 | 攻击 | 切断 |
|---|---|---|
| P1 谓词即代码 | 契约携 `{op:'js',src}` 妄图让 V 执行 | 只在冻结 AXIOMS 封闭集 switch;绝不 eval/反射 |
| P2 原型污染 | 路径 `__proto__.x` 越权 | `_get` 只走自有属性,原型段判缺失 |
| P3 fail-open 兜底 | 故意抛异常赌「出错=放行」 | 每个 catch 返 `ok:false`,永不返 true |
| P4 ReDoS | 正则炸弹卡死 V | 正则刻意不在公理集,整个 ReDoS 面消灭 |
| P5 资源耗尽 | 万层嵌套爆栈 | 节点/深度/args 硬上限,超限 fail-closed |
| P6 量词绑定走私 | `as:'__proto__'` 污染作用域 | as 非法名 fail-closed,`_bindScope` 浅拷自有属性 |
| P7 量词 DoS | 超长数组施量词 | `MAX_QUANT_ELEMS` 上限 + 元素计入预算 |
| P8 ref 路径逃逸 | `ref:'__proto__.polluted'` 读原型 | ref 走 `_get`,缺失路径 fail-closed |

不 CI 强制时,任何一次重构都能把某条切断悄悄改回 fail-open,而无门亮红。接进发布门 = 这份 fail-closed 契约从 1.0.0 起被每次提交/发布锁死。

## 改动(全 additive·零运行时改动)

1. `package.json` 的 `test:maintainer:safety`(= 发布门禁前提)追加 `services/backend/tests/actionContractVerifier.test.js` = 首个 CI 消费者。
2. flagRegistry 登记 `KHY_ACTION_CONTRACT: { mode:'default-on', off:'CANON', default:true }`——**净零行数**(凝练本人 OPS-160 的 `KHY_FPF_CHARACTERIZATION` 注释由上方独立行改行内尾注,腾出一行),god-file 维持 2499 未触 2500。

★**刻意不动核验器叶**:header 契约明写「零依赖:全文件无任何 require;纯计算」——这是它可独立审计的一部分。故叶的 `isEnabled` 保持读 `env.KHY_ACTION_CONTRACT` 直判(CANON off-words `{0,false,off,no}`),**绝不**引入 `require('flagRegistry')`。registry 登记项 `{default-on, off:'CANON'}` 精确文档化叶的实际 env 行为(两者一致),仅作 SSOT 文档,无功能耦合。

## 验收(全绿)

```
node --check services/backend/src/services/flagRegistry.js                     # OK,2499 行未超
node --test  services/backend/tests/actionContractVerifier.test.js             # 22/22 pass
node --test  scripts/tests/flag-registry.test.js                               # 12/12(注册表自净)
npm run test:maintainer:safety                                                 # 聚合含新测,fail0
npm run maintainer:check                                                       # EXIT0
node scripts/check-change-safety.js <本次切片…>                                 # no findings
```

## 教训

1. 「测试存在但不在任何 npm 脚本」= 一种隐形孤儿:能力+测试都在,却从不 CI 强制,不变量可静默回退——安全原语尤其危险。
2. 接线可以是把已有详尽测试接进发布门(零运行时改动);给安全不变量一个 CI 消费者就是接线。
3. 叶的「零依赖」契约必须尊重:核验器是可独立审计原语,绝不为了「统一走 flagRegistry」而给它加 require;flagRegistry 只作 SSOT 文档登记,叶读 env 直判保持自洽。
4. god-file 边缘(2499)加 flag 必净零:凝练本人先前注释,绝不动他人行,`wc -l` 复核 ≤2499。
5. 先跑 live 测确认 22/22 全绿,才能把它锁进发布门(否则一登记发布门就红)。
