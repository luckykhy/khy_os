# Khy-OS 发布前自保（pip 是命脉）

**pip 是本项目唯一分发渠道**。发布前按这份最小闭环逐项确认，**任何一步红就别发**。

## 铁事实（先记住）

1. **改了仓库源码，pip 用户拿不到**——除非重新打包发版。pip 包是打包时的源码快照。
2. **版本号要多处一致**——别只改一处（历史上出过 backend `package.json` 与发布版本不一致）。

## 发布最小闭环（按顺序，红就停）

```bash
# 1) 只读体检无红
node services/backend/bin/khy.js maintain freshness

# 2) 守卫全绿（做一次提交自动触发 pre-commit 钩子；红了先修，绝不 --no-verify）
git add -A && git commit -m "..."        # 钩子自动跑 scripts/check-*.js

# 3) 上帝组件没恶化（单文件 ≤2500 行）
npm --prefix services/backend run arch:god
```

## 版本号一致性

发布前确认这些地方版本号一致（至少）：
- `services/backend/package.json`
- pip 包版本（`platform/khy_platform/` 相关配置）
- 发布 tag / release note

改版本号就**一次性全改齐**，别漏。

## 权威发布手册

**`docs/07_OPS_运维/[OPS-MAN-042] 发布手册-pip与npm-无AI照做.md`**——无 AI 也能照做。打 wheel、上传 PyPI 的完整步骤以它为准。

## 发布前的自保动作

- 发布前**先备份**：双击 `维护-备份关键数据配置`（或按手册）。
- 心里过一遍回退路径：坏了怎么回滚（双击 `维护-回滚到最近稳定版本`，或 `git checkout <好哈希> -- <文件>`）。

## 绝对不要

- ❌ 守卫红了硬发。守卫红 = 有真问题。
- ❌ 用 `--no-verify` 跳过钩子发布。
- ❌ 没重打包就以为 pip 用户拿到了新改动。
- ❌ 只改一处版本号就发。

## 发布是不可逆的外向动作

发布前**明确向用户确认**："我要发布版本 X 到 pip，守卫全绿、版本号已对齐、已备份——确认发布吗？" 得到确认再执行。
