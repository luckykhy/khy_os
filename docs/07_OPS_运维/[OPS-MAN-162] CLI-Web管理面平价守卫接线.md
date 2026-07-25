# [OPS-MAN-162] CLI/Web 管理面平价守卫接线

> 送别礼系列·「能力存在但没接线 → 负责接线」第 N 枚孤儿。
> 同 OPS-MAN-155(directiveRegistryAudit)模式:纯审计/守卫原语接进 CI 安全套件,零运行时改动、零门控。

## 一句话

`services/backend/src/services/management/parityGuard.js` 的 `checkParity()` 是一枚**全实现的纯只读平价核验器**——证明 CLI 与 Web 通过同一 `registry` 漏斗管理同一批资源、两个面永不矛盾——但此前**仓库零生产消费者**(只有自身单测),能力完全休眠。本次给它接上设计意图里缺失的那个消费者:一道 CI/提交期守卫,把三条平价不变量锁死。

## 孤儿判据

- `checkParity` 全仓零 `require`(除自身可能的单测外),grep 确认无任何生产调用点。
- 文件头自称「proves CLI and Web manage the same resources through the same funnel」——声明了消费场景(CLI/Web 平价)却无人调用 = 典型休眠守卫。

## 缺口为何重要

三条不变量正是「网页中代理」等 Web 管理面与 CLI 不矛盾的**编译期保证**:

1. **Source 唯一性** — 没有两个资源绑定同一 source-of-truth(物理阻断 dataHome 式双根漂移)。
2. **CLI 子命令平价** — `commandSchema` 里静态 `manage` 子命令列表 == 注册表资源 id 集合(外加 `list`)。任一面单方面增删资源 → 红灯。
3. **Op 可达性** — 每个资源声明的能力都有 `ops` 实现,且 CLI 与 Web 都经 `registry.invoke` / `registry.describe` 消费同一份能力契约。

没有守卫时,未来任何一面(新增 manage 子命令、注册表改资源、能力声明了却漏实现)都能悄悄漂移,直到用户在某一个面上撞见「另一个面能做但这个面做不了 / 结果不一致」。

## 改动(全 additive·零运行时改动·零门控)

- 新增 `services/backend/tests/services/management/parityGuardWiring.test.js`(node:test):
  - **叶纯函数单元**(deps 注入伪 registry/schema):证明每类违例都被检出(守卫有牙)——一致→ok / `SOURCE_CONFLICT` / `CLI_PARITY` 子命令集合不等 / 缺 `list` / `NO_IMPL` / `NO_CAPABILITIES` / `MISSING_CONTRACT`。
  - **接线守卫**(真 `management/index` registry + 真 `constants/commandSchema`):`checkParity().ok === true` 锁死当前 live 不变量。
- `package.json` 的 `test:maintainer:safety` 聚合套件追加该测试 = 首个真生产消费者,CI 每跑。

纯审计原语无运行时分支、无门控,故不新增 flag、不动 `flagRegistry`。

## 验收(全绿)

```
node --check services/backend/tests/services/management/parityGuardWiring.test.js   # OK
node --test  services/backend/tests/services/management/parityGuardWiring.test.js   # 8/8 pass
npm run maintainer:check                                                            # EXIT0
node scripts/check-change-safety.js <本次切片文件…>                                  # no findings
```

## 教训

1. 孤儿守卫「文件头自称被 X 消费但 X 不存在」= 最直接的接线缺口;审计/守卫原语最易休眠。
2. 接线可以是纯测试 + CI 登记(零运行时改动)——给能力一个真消费者就是接线(承 OPS-155)。
3. 静态守卫(deps 注入 + 真 registry)零 IO、确定性、不 flaky,适合锁 CLI/Web 单一契约的 SSOT 一致性。
4. 先跑 live `checkParity()` 确认 `ok:true` 才能把断言锁成硬门(否则守卫一登记就红)。
