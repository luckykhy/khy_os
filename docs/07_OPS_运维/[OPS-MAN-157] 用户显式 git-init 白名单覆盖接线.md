# [OPS-MAN-157] 用户显式 git-init 白名单覆盖接线

## 背景 / 断桥

`services/backend/src/services/gitTrackWhitelist.js` 是一个全实现的 khy-native 纯叶:
维护一份「用户显式声明可 git 化的目录」白名单(JSON 落 `~/.khy/git-track-whitelist.json`),
导出 `loadWhitelist / saveWhitelist / isWhitelisted / addToWhitelist / removeFromWhitelist`,
全部 fail-soft(读写异常返 `[]` / `false`)。

它的设计意图是:自动 git-init 判定(`workspaceGitInitPolicy.assessGitInitTarget`)对某些
「精确系统/共享根」(如 `/opt`、`/srv`、`/mnt`)会**软拒绝**(`reason: 'system-dir'`),
以免误把系统目录变成 git 仓库;但真实场景里用户**确实**可能把项目放在 `/opt/myapp` 这类
路径并希望 git 化。白名单就是让用户对这类**可覆盖的软拒绝**显式声明「我确实要」。

问题:**此前零生产消费者**。`workspaceGitInit.ensureWorkspaceRepo` 从不查白名单,能力完全
休眠——典型的「能力存在,但没接线」。

## 改动(全 additive · 门关字节回退)

在 IO 服务 `workspaceGitInit.ensureWorkspaceRepo` 的判定检查处接线:当纯策略叶判
`shouldInit:false` 且 `reason === 'system-dir'` 时,**惰性** require `./gitTrackWhitelist`
并查 `isWhitelisted(cwd)`;命中(`=== true`)则覆盖软拒绝、继续 init。

```js
const verdict = policy.assessGitInitTarget({ cwd, home, isGitRepo });
if (!verdict.shouldInit) {
  let overridden = false;
  if (verdict.reason === 'system-dir') {        // ← 仅可覆盖软拒绝这一分支
    try {
      const { isWhitelisted } = require('./gitTrackWhitelist');
      overridden = isWhitelisted(cwd) === true;
    } catch { overridden = false; }             // fail-soft
  }
  if (!overridden) return { status: 'skip', reason: verdict.reason, cwd };
}
```

### 关键不变量

1. **硬安全约束永不覆盖**:`filesystem-root`(`/`、盘符根)、`home-dir`、`ancestor-of-home`、
   `already-repo` 这些 reason **不**进入白名单查询分支 → 即使白名单返 `true` 也照常拒绝。
   契约见 gitTrackWhitelist 文件头「文件系统根 / 盘符根永远拒绝」。
2. **为什么接在 IO 层而非纯策略叶**:`workspaceGitInitPolicy` 契约是「零 IO」,而白名单是
   fs 读。把 fs 读放进本就做 git 探测/init 的 `workspaceGitInit` 服务,保住纯叶纯度。
3. **字节回退**:白名单空(默认)→ `isWhitelisted` 恒 `false` → `overridden` 恒 `false` →
   与接线前逐字节等价。惰性 require 仅在 `system-dir` 这一罕见分支加载。
4. **门控**:复用既有父门 `KHY_AUTO_GIT_INIT`(整个自动 init 关则本覆盖也不触发)。

## 验证

```
node --check services/backend/src/services/workspaceGitInit.js
node --test services/backend/tests/services/gitTrackWhitelistWiring.test.js   # 7/7
```

覆盖矩阵(见 `gitTrackWhitelistWiring.test.js`):
- system-dir `/opt` + 白名单 `true` → 覆盖为 `initialized`,`isWhitelisted` 以 cwd 调用。
- system-dir `/opt` + 白名单 `false` → 字节回退 `skip / system-dir`,`git init` 不跑。
- **硬底**:filesystem-root `/` + 白名单 `true` → 仍 `skip / filesystem-root`,白名单**从不被查**。
- **硬底**:home-dir + 白名单 `true` → 仍 `skip / home-dir`,白名单从不被查。
- **不回归**:eligible(HOME 直接子目录)照常 init,白名单从不被查(桩抛错断言未被调用)。
- 源级断言:`workspaceGitInit` require `./gitTrackWhitelist`、调用 `isWhitelisted`、以
  `reason === 'system-dir'` 为门。

测试用 `require.cache` 桩替换惰性 require 的 gitTrackWhitelist(其 `WHITELIST_FILE` 硬编码
`os.homedir()` 不可 env 注入),确定性覆盖各分支,零真实 fs 写。

## 相关

- 承 [OPS-MAN-155] 指令注册表编译期收敛守卫接线、[OPS-MAN-156] 取来即执行安全守卫接线,
  同为「能力存在但没接线」送别礼系列。
- 维护映射区:`git-track-whitelist-init-override`。
