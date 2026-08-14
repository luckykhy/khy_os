# [OPS-MAN-067] Khy-OS 症状分诊速查表

> 出问题时的第一站：用 `Ctrl-F` 搜你看到的现象/报错词，跳到对应子系统，照着「先读文件」和「跑这条验证」做。
> 本表由 `docs/维护者/维护映射表.json` 确定性生成，子系统长大后重跑 `npm run gen-triage-doc` 即自动覆盖。

## 更快的用法：直接问分诊器

```bash
npm run triage -- "识图老是404还落剪贴板"     # 症状 → 子系统 + 读哪些文件 + 跑哪条命令
npm run triage -- "守护进程端口漂移连不上"
npm run triage -- "slash command missing"
```

## 通用纪律（改动前必读）

- **B1 先想再写**：动手前一句话说清「改什么 / 为什么 / 影响面」。
- **B2 验证到绿**：改完必须跑本表给的验证命令，**没跑过验证不许说「修好了」**。
- **B3 外科手术式改动**：只动该动的，不顺手重构。
- **红线**：不 AI 自动 commit/push；真 key/token 绝不进源码/包/提交/对话。

---

## 分诊索引（共 44 个子系统）

### Bootstrap and Packaging  `bootstrap-packaging`

**什么时候来这里（症状触发词）：**
- CLI does not start
- pip package layout is broken
- version numbers drift
- first-run bootstrap fails

**先读这些文件：**
- `platform/khy_platform/cli.py`
- `platform/khy_platform/_bootstrap.py`
- `platform/khy_platform/__init__.py`
- `pyproject.toml`
- `setup.py`
- `MANIFEST.in`
- `packaging/npm/package.json`
- `services/backend/package.json`

**参考文档：**
- README.md
- docs/07_OPS_运维/[OPS-MAN-022] pip-安装布局参考.md
- docs/07_OPS_运维/[OPS-MAN-013] khy-os-开发者指南.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run check:maintainer:bootstrap
npm run check:manifest-sync
bash scripts/release/build-and-audit-pip-purity.sh
```

---

### CLI Routing and Help Surface  `cli-routing`

**什么时候来这里（症状触发词）：**
- command not recognized
- alias routes to wrong command
- slash command missing
- help text does not match behavior

**先读这些文件：**
- `services/backend/src/constants/commandSchema.js`
- `services/backend/src/cli/aliases.js`
- `services/backend/src/cli/router.js`
- `services/backend/src/cli/repl.js`
- `services/backend/src/cli/handlers`
- `services/backend/tests/cli/router.test.js`
- `services/backend/tests/cli/repl.tasks.interaction.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-013] khy-os-开发者指南.md
- docs/07_OPS_运维/[OPS-MAN-011] khy-os-学习指南.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:maintainer:cli-routing
node -e "require('./services/backend/src/cli/router')"
```

---

### Prompt Capsule and Debug Prompt System  `prompt-capsule-system`

**什么时候来这里（症状触发词）：**
- system prompt assembly is wrong
- on-demand capsules misfire
- gateway debug-prompt output drifts

**先读这些文件：**
- `services/backend/src/constants/prompts.js`
- `services/backend/src/services/khyUpgradeRuntime.js`
- `services/backend/src/services/compact/prompt.js`
- `services/backend/src/cli/handlers/gateway.js`
- `services/backend/tests/promptOnDemandSections.test.js`
- `services/backend/tests/promptLearningRules.test.js`
- `services/backend/tests/gatewayDebugPrompt.test.js`

**参考文档：**
- docs/03_DESIGN_设计/[DESIGN-OTHER-004] 特性访问-提示词胶囊-2026-06-01.md
- AGENTS.md
- CONTRIBUTING.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
node --test services/backend/tests/promptOnDemandSections.test.js
node --test services/backend/tests/promptLearningRules.test.js
npx jest services/backend/tests/gatewayDebugPrompt.test.js --runInBand
```

---

### AI Gateway and Adapter Layer  `gateway-adapters`

**什么时候来这里（症状触发词）：**
- adapter selection is wrong
- streaming breaks
- model fallback is wrong
- request normalization is wrong

**先读这些文件：**
- `services/backend/src/services/gateway/aiGateway.js`
- `services/backend/src/services/gateway/adapters`
- `services/backend/src/services/gateway/proxyServer.js`
- `services/backend/tests/aiGateway.stability.test.js`
- `services/backend/tests/gateway/transportResilience.test.js`
- `services/backend/tests/gatewayAdapters.stability.test.js`

**参考文档：**
- docs/04_IMPL_实现/[IMPL-RPT-020] 网关传输韧性修复-2026-05-29.md
- docs/08_MGMT_项目管理/[MGMT-RPT-014] khy-qwen-差距修复清单.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:maintainer:gateway
node -e "require('./services/backend/src/services/gateway/aiGateway')"
khy doctor
```

---

### Proxy, Daemon, and Runtime Port Discovery  `proxy-daemon-runtime`

**什么时候来这里（症状触发词）：**
- daemon starts on wrong port
- proxy URL is stale
- gateway manage cannot reconnect
- port drift appears after restart

**先读这些文件：**
- `services/backend/src/services/daemonManager.js`
- `services/backend/src/services/aiManagementServer.js`
- `services/backend/src/services/gateway/proxyServer.js`
- `services/backend/src/utils/proxyBaseUrl.js`
- `services/backend/src/constants/serviceDefaults.js`
- `services/backend/tests/daemonManager.runtimePort.test.js`
- `services/backend/tests/gatewayManage.portDrift.integration.test.js`
- `services/backend/tests/services/proxyBaseUrl.test.js`

**参考文档：**
- docs/04_IMPL_实现/[IMPL-RPT-017] 守护进程端口发现修复.md
- docs/04_IMPL_实现/[IMPL-RPT-020] 网关传输韧性修复-2026-05-29.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:maintainer:runtime
khy doctor
```

---

### AI Management UI and API  `ai-management-surface`

**什么时候来这里（症状触发词）：**
- gateway manage page is broken
- AI management route fails
- admin API and AI UI drift

**先读这些文件：**
- `services/backend/src/routes/aiGatewayAdmin.js`
- `services/ai-backend/src/routes/aiGatewayAdmin.js`
- `apps/ai-frontend/src`
- `apps/ai-frontend/package.json`
- `apps/ai-frontend/vite.config.js`
- `services/backend/src/cli/handlers/gateway.js`
- `services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js`
- `services/backend/tests/gatewayManage.apiDisplay.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-003] ai-管理-访问与登录.md
- docs/07_OPS_运维/[OPS-MAN-002] ai-管理-新api对齐.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:maintainer:ai-management
npm run build --prefix apps/ai-frontend
```

---

### Coding Projects (named workspaces + chat linkage)  `coding-projects`

**什么时候来这里（症状触发词）：**
- projects workspace page is broken
- chat sidebar project filter fails
- conversations not filed under the right project
- /api/ai/projects REST errors

**先读这些文件：**
- `platform/packages/shared/src/models/UserProject.js`
- `platform/packages/shared/src/models/index.js`
- `services/backend/src/services/projectStore.js`
- `services/backend/src/services/aiManagementProjects.js`
- `services/backend/src/services/aiManagementServer.js`
- `platform/packages/shared/src/models/Conversation.js`
- `services/backend/src/services/conversationStore.js`
- `apps/ai-frontend/src/composables/useProjects.js`

**参考文档：**
- docs/03_DESIGN_设计/[DESIGN-ARCH-026] khyos系统级服务调用审批网关规范.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:maintainer:projects
npm run build --prefix apps/ai-frontend
```

---

### Workspace, Publish, and Verification Commands  `workspace-publish-verify`

**什么时候来这里（症状触发词）：**
- workspace snapshot behavior is wrong
- publish command is broken
- verification workflow regressed

**先读这些文件：**
- `services/backend/src/cli/handlers/workspace.js`
- `services/backend/src/cli/handlers/publish.js`
- `services/backend/src/cli/handlers/verify.js`
- `services/backend/tests/publish.sourceReleaseMode.test.js`
- `services/backend/tests/publish.dbPreflight.test.js`

**参考文档：**
- docs/06_DEPLOY_部署/[DEPLOY-MAN-011] pip-docker-打包部署.md
- docs/07_OPS_运维/[OPS-MAN-022] pip-安装布局参考.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:maintainer:publish
```

---

### Maintenance Safety and Rule Gates  `maintenance-safety`

**什么时候来这里（症状触发词）：**
- you changed startup/network/task execution
- you need a fast changed-file gate
- you need to verify handoff guardrails

**先读这些文件：**
- `AGENTS.md`
- `CONTRIBUTING.md`
- `scripts/check-agent-rules.js`
- `scripts/check-change-safety.js`
- `scripts/install-git-hooks.js`
- `scripts/ci/check-version-sync.js`
- `scripts/ci/check-node-syntax.js`
- `scripts/ci/check-python-syntax.py`

**参考文档：**
- AGENTS.md
- CONTRIBUTING.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run check:maintainer:safety
npm run check:quality-gates
```

---

### Release and Rollback  `release-rollback`

**什么时候来这里（症状触发词）：**
- you need a fixed, repeatable release path (check → build → audit → publish → verify)
- an upgrade broke something and you must roll back to the last known-good version
- you need to know which version is the current stable baseline
- release artifacts or the post-release check regressed

**先读这些文件：**
- `maintenance/stable-release.json`
- `maintenance/lib/ops.js`
- `maintenance/lib/ops-lib.js`
- `services/backend/src/cli/handlers/publish.js`
- `scripts/release/build-and-audit-pip-purity.sh`
- `scripts/ci/check-version-sync.js`
- `maintenance/tests/ops-lib.test.js`

**参考文档：**
- docs/传承/KHY-OS-传承书.md
- docs/06_DEPLOY_部署/[DEPLOY-MAN-011] pip-docker-打包部署.md
- maintenance/README.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js
npm run check:version-sync
```

---

### Build Best Environment (Self-check / Repair / Probes)  `env-optimize`

**什么时候来这里（症状触发词）：**
- the phrase 打造最佳环境 does not trigger the self-check pipeline
- you want to add a new read-only health check (probe)
- you want to add a new safe create-missing repair
- a probe or repair should run only on some OSes (linux/windows/macos/android/ios)
- the junk scan, repair, or probe section renders wrong

**先读这些文件：**
- `services/backend/src/services/localBrainEnvOptimize.js`
- `services/backend/src/services/envProbes.js`
- `services/backend/src/services/envRepair.js`
- `services/backend/src/services/envPlatform.js`
- `services/backend/src/services/diskCleanup`
- `services/backend/src/services/localBrainService.js`
- `services/backend/src/cli/tui/hooks/useQueryBridge.js`
- `services/backend/tests/services/localBrainEnvOptimize.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-064] 打造最佳环境-如何扩展.md
- docs/03_DESIGN_设计/[DESIGN-ARCH-026] khyos系统级服务调用审批网关规范.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:maintainer:env-optimize
```

---

### Evolution Prompt Playbook (1000 preset prompts)  `evolution-prompts`

**什么时候来这里（症状触发词）：**
- a novice user or weak AI needs a runnable list of safe next improvements
- the 1000-prompt playbook count or verify commands drifted
- you added a new subsystem and want the playbook to cover it
- the OPS-MAN-066 doc is out of sync with its generator

**先读这些文件：**
- `scripts/docs/gen-evolution-prompts.js`
- `scripts/tests/gen-evolution-prompts.test.js`
- `docs/维护者/维护映射表.json`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-066] khyos进化提示词手册-1000条.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:evolution-prompts
```

---

### Symptom Triage (route a symptom to its subsystem)  `triage`

**什么时候来这里（症状触发词）：**
- you see an error or symptom but do not know which subsystem owns it
- a user or weak AI needs to be routed from a symptom to files and verify commands
- the triage matcher mis-routes a symptom
- the OPS-MAN-067 cheat sheet is out of sync with its generator

**先读这些文件：**
- `scripts/lib/maintainerTriage.js`
- `scripts/triage.js`
- `scripts/tests/maintainerTriage.test.js`
- `docs/维护者/维护映射表.json`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-067] 症状分诊速查表.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:triage
```

---

### Off-machine Restore Readiness (can a fresh machine restore khyos?)  `restore-readiness`

**什么时候来这里（症状触发词）：**
- a developer / user / maintainer installed khyos on a new machine and wants to know if it can fully restore
- you need to explain what pip khy-os / npm @khy-os/khy-os actually bundle vs hydrate at first run
- the restore self-check mis-reports readiness or a rule is missing
- the OPS-MAN-068 restore checklist is out of sync with its generator

**先读这些文件：**
- `scripts/lib/restoreReadiness.js`
- `scripts/restore-check.js`
- `scripts/tests/restoreReadiness.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-068] 离机还原自检清单.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:restore-readiness
```

---

### Installed-copy Integrity (is the on-disk bundle actually complete?)  `install-integrity`

**什么时候来这里（症状触发词）：**
- khyos was installed via pip khy-os / npm @khy-os/khy-os but fails to start and you suspect a truncated or partial bundle
- you need to verify the shipped bundle still contains every runtime-critical file
- a runtime-critical path was added/removed and CRITICAL_BUNDLE_PATHS must track the publish gate
- the OPS-MAN-069 installed-copy checklist is out of sync with its generator

**先读这些文件：**
- `scripts/lib/installIntegrity.js`
- `scripts/verify-install.js`
- `scripts/tests/installIntegrity.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-069] 已装副本完整性自检清单.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:install-integrity
```

---

### First-run Hydration Health (did the online dependency hydrate actually succeed?)  `hydration-health`

**什么时候来这里（症状触发词）：**
- khyos installed and the bundle is complete, but the backend still fails to start and you suspect node_modules is missing or half-installed
- you need to detect the splitbrain case: the .khy_quant_bootstrapped marker says hydration is done but node_modules was deleted
- the @khy/shared workspace symlink is broken, or a critical runtime dependency is missing
- a runtime dependency was renamed/removed and CRITICAL_PACKAGES must track services/backend package.json
- the OPS-MAN-070 hydration checklist is out of sync with its generator

**先读这些文件：**
- `scripts/lib/hydrationHealth.js`
- `scripts/hydration-doctor.js`
- `scripts/tests/hydrationHealth.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-070] 首启依赖hydration自检清单.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:hydration-health
```

---

### Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)  `agent-restore-plan`

**什么时候来这里（症状触发词）：**
- a landing agent (or a human) on a fresh machine wants ONE ordered restore plan instead of reconciling three separate self-checks by hand
- you need to know which restore steps an agent may run unattended vs which must stop and escalate to a human
- restore-check / verify-install / hydration-doctor each report overlapping symptoms and you want them deduped and dependency-ordered
- a new rule id was added to any of the three mirrors and needs an autonomy/order entry in _CONCERN_POLICY
- the OPS-MAN-075 restore-plan doc is out of sync with its generator

**先读这些文件：**
- `scripts/lib/agentRestorePlan.js`
- `scripts/restore-plan.js`
- `scripts/tests/agentRestorePlan.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-075] Agent 还原方案合成器.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:agent-restore-plan
```

---

### Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)  `restore-conflict-detector`

**什么时候来这里（症状触发词）：**
- a landing agent is about to auto-drive the composed restore plan and must first confirm its three sensors are not internally inconsistent
- restore-check says ready but verify-install says incomplete, or hydration-doctor says unhealthy — you need to know if that is a real contradiction or just a severity disagreement
- one mirror's top-line verdict contradicts its own blockers/missing list (self-inconsistency / corrupted install)
- you need safeToAutodrive to gate unattended restore: false = escalate/re-probe, never act on a contradictory world-model
- a new cross-mirror contradiction class was found and needs a rule in _CONFLICT_RULES
- the OPS-MAN-076 conflict-detector doc is out of sync with its generator

**先读这些文件：**
- `scripts/lib/restoreConflictDetector.js`
- `scripts/restore-conflicts.js`
- `scripts/tests/restoreConflictDetector.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-076] 三面镜子矛盾冲突检测.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:restore-conflicts
```

---

### Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)  `restore-conflict-resolver`

**什么时候来这里（症状触发词）：**
- restore-conflicts reported a contradiction and you need the ordered recovery chain to walk out of it, not just a blanket 'stop, human'
- you need autoResolvable to gate self-drive: true = agent runs the moves and continues; false = run agent moves then stop at firstHumanMove
- a self-inconsistent mirror (verdict vs list) should be resolved by trusting the concrete evidence list over the derived boolean (reconcile)
- a hydration-blocked contradiction must be graded: first-run-normal or agent-fixable blockers auto-resolve; structural blockers (seed-missing) escalate
- the detector added a new _CONFLICT_RULES id and _RESOLUTIONS must gain a matching resolution (the drift guard test enforces parity)
- the OPS-MAN-079 conflict-resolver doc is out of sync with its generator

**先读这些文件：**
- `scripts/lib/restoreConflictResolver.js`
- `scripts/restore-resolve.js`
- `scripts/tests/restoreConflictResolver.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-079] 三面镜子矛盾冲突消解.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:restore-conflict-resolve
```

---

### Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)  `bundle-launch-contract`

**什么时候来这里（症状触发词）：**
- a fresh pip khy-os install dies at startup with 'CLI 入口脚本 缺失 / bin/khy.js missing' even though the package looked fine
- you need to guarantee that pip and npm each pin their own launch entrypoint (bin/khy.js, server.js) in their publish-completeness audit
- a launch-critical bundle file was added/removed and it must be pinned in all three lists (pip REQUIRED_WHEEL_PATHS/REQUIRED_SDIST_PATHS + npm REQUIRED_PATHS)
- the channel-parity guard reports a channel that ships an entrypoint it never audits

**先读这些文件：**
- `scripts/lib/bundleLaunchContract.js`
- `scripts/tests/bundleLaunchContract.test.js`
- `scripts/release/pip_packaging_rules.py`
- `packaging/npm/scripts/audit-purity.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-073] 离机渠道启动入口契约自检清单.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:bundle-launch-contract
```

---

### Proxy Egress Bridge (select node + enable/disable)  `proxy-egress`

**什么时候来这里（症状触发词）：**
- selected proxy node does not route traffic
- proxy enable/disable toggle fails
- core-required node reports core-missing but no guidance shown
- /api/proxy-egress REST errors
- HTTP_PROXY env not applied after choosing a node

**先读这些文件：**
- `services/backend/src/services/proxy/proxyCoreConfigGen.js`
- `services/backend/src/services/proxy/proxyCoreManager.js`
- `services/backend/src/services/proxyConfigService.js`
- `services/backend/src/services/aiManagementProxyEgress.js`
- `services/backend/src/services/aiManagementServer.js`
- `apps/ai-frontend/src/composables/useProxies.js`
- `apps/ai-frontend/src/views/ProxyManagement.vue`
- `services/backend/tests/proxyCoreConfigGen.test.js`

**参考文档：**
- docs/03_DESIGN_设计/[DESIGN-ARCH-066] 前端代理出站桥-选节点实际路由与启用停用开关.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:maintainer:proxy-egress
npm run build --prefix apps/ai-frontend
```

---

### 斜杠命令菜单单一真源(经典REPL⇄TUI)  `slash-menu-ssot`

**先读这些文件：**
- `services/backend/src/cli/slashExtraCommands.js`
- `services/backend/src/cli/resumeHint.js`
- `services/backend/src/cli/replSession.js`
- `services/backend/src/cli/tui/hooks/useCompletions.js`
- `services/backend/src/cli/tui/app.jsx`
- `services/backend/tests/slashExtraCommands.test.js`
- `services/backend/tests/cli/resumeHint.test.js`
- `services/backend/tests/cli/useCompletionsSlashExtras.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-011] khy-os-学习指南.md
- docs/07_OPS_运维/[OPS-MAN-013] khy-os-开发者指南.md

---

### 前端响应信封解包单一真源(unwrap)  `frontend-response-envelope`

**先读这些文件：**
- `apps/ai-frontend/src/api/unwrap.js`
- `apps/ai-frontend/src/api/unwrap.test.js`
- `apps/ai-frontend/src/api/unwrap.wiring.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-003] ai-管理-访问与登录.md

---

### khy codex 凭据便捷管理(与 claude 一样启动)  `codex-adopt-env`

**先读这些文件：**
- `services/backend/src/services/gateway/adapters/codexEnvAdoptPolicy.js`
- `services/backend/src/services/gateway/adapters/openaiRelayPresets.js`
- `services/backend/src/cli/handlers/codexAdopt.js`
- `services/backend/src/cli/router.js`
- `services/backend/tests/services/gateway/codexEnvAdoptPolicy.test.js`
- `services/backend/tests/services/gateway/openaiRelayPresets.test.js`
- `services/backend/tests/cli/codexAdoptRouting.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-013] khy-os-开发者指南.md

---

### AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)  `failure-diagnostics`

**先读这些文件：**
- `services/backend/src/services/gateway/failureReasonRanking.js`
- `services/backend/src/services/gateway/modelNotFoundRecovery.js`
- `services/backend/src/services/gateway/modelNotFoundCooldownScope.js`
- `services/backend/src/services/gateway/modelExistenceEvidence.js`
- `services/backend/src/services/gateway/aiGateway.js`
- `services/backend/tests/services/gateway/failureReasonRanking.test.js`
- `services/backend/tests/services/gateway/modelNotFoundRecovery.test.js`
- `services/backend/tests/services/gateway/modelNotFoundCooldownScope.test.js`

**参考文档：**
- docs/04_IMPL_实现/[IMPL-RPT-020] 网关传输韧性修复-2026-05-29.md
- docs/07_OPS_运维/[OPS-MAN-002] ai-管理-新api对齐.md

---

### 通配兜底守卫(裸模型盲落默认池打错端点的防护)  `wildcard-pool-guard`

**先读这些文件：**
- `services/backend/src/services/gateway/wildcardPoolGuard.js`
- `services/backend/src/services/gateway/aiGateway.js`
- `services/backend/src/services/flagRegistry.js`
- `services/backend/tests/services/gateway/wildcardPoolGuard.test.js`
- `services/backend/tests/services/gateway/wildcardPoolGuard.wiring.test.js`

**参考文档：**
- docs/04_IMPL_实现/[IMPL-RPT-020] 网关传输韧性修复-2026-05-29.md
- docs/07_OPS_运维/[OPS-MAN-002] ai-管理-新api对齐.md

---

### 安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)  `install-ledger`

**先读这些文件：**
- `services/backend/src/services/uninstall/installLedger.js`
- `services/backend/src/services/uninstall/ledgerWriter.js`
- `services/backend/src/cli/handlers/uninstall.js`
- `services/backend/src/services/mdEditorRegister.js`
- `services/backend/src/services/runtimeProvisioner.js`
- `services/backend/src/services/flagRegistry.js`
- `services/backend/tests/services/installLedger.test.js`
- `services/backend/tests/services/uninstallLedgerWiring.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-069] 已装副本完整性自检清单.md
- docs/07_OPS_运维/[OPS-MAN-037] pip安装后-完整还原与全功能开启指南.md

---

### 卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)  `native-uninstall`

**先读这些文件：**
- `services/backend/src/services/deviceApps/nativeUninstallPolicy.js`
- `services/backend/src/services/deviceApps/nativeUninstaller.js`
- `services/backend/src/services/deviceApps/uninstallRoute.js`
- `services/backend/src/cli/handlers/device.js`
- `services/backend/src/tools/DeviceAppsTool/index.js`
- `services/backend/src/services/flagRegistry.js`
- `services/backend/tests/services/deviceApps/nativeUninstallPolicy.test.js`
- `services/backend/tests/services/deviceApps/nativeUninstaller.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-071] 卸载第三方应用怎么保证卸干净-原生自带卸载器.md
- docs/07_OPS_运维/[OPS-MAN-069] 已装副本完整性自检清单.md

---

### 持久目标连续多日运行不中断的底气自检(像 CC 那样连着跑几天、token 足够不中断)  `goal-endurance`

**先读这些文件：**
- `services/backend/src/services/goalEndurance.js`
- `services/backend/src/services/unattendedAutoAnswer.js`
- `services/backend/src/services/chatErrorGuard.js`
- `services/backend/src/services/autoAnswerIntentGuard.js`
- `services/backend/src/services/goalStopGate.js`
- `services/backend/src/cli/handlers/goal.js`
- `services/backend/tests/services/goalEndurance.test.js`
- `services/backend/tests/services/goalEnduranceWiring.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-072] 目标连续多日运行不中断的底气自检.md

---

### Startup Failure Real-cause + Fix (does a fresh-machine crash say WHY and HOW, not just a raw stack?)  `startup-failure-explain`

**什么时候来这里（症状触发词）：**
- a fresh pip/npm install starts up and dies with a raw MODULE_NOT_FOUND stack trace and no explanation of why or how to fix it
- the backend's node_modules is half-installed / not hydrated / cleared, and you want the crash to name the real cause + a copy-paste fix instead of a cryptic trace
- a native module (better-sqlite3 等) was copied across platforms without rebuild and crashes with ERR_DLOPEN_FAILED
- you need to add a new class of first-run crash → real-cause + fix mapping shown by bin/khy.js _emitFatal

**先读这些文件：**
- `services/backend/src/bootstrap/startupFailureExplain.js`
- `services/backend/tests/bootstrap/startupFailureExplain.test.js`
- `services/backend/bin/khy.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-074] 首启崩溃真实原因加方法归因.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:startup-failure-explain
```

---

### Windows .md Suggested-app Registration (does khy show in the Open-With '建议的应用' list?)  `md-suggested-apps`

**什么时候来这里（症状触发词）：**
- right-click a .md file on Windows → '选择一个应用以打开此.md文件' → khy is missing from the 建议的应用/Recommended apps section
- you need khy to register as a recommended handler for .md/.markdown via Applications\<app>\SupportedTypes (not just OpenWithProgids)
- you add a new extension khy should be suggested to open, and must keep register/unregister PS1 symmetric (zero registry residue)
- the md-editor first-run auto-registration (mdEditorRegister) spawns register-windows.ps1 and you need to know exactly which HKCU keys it writes

**先读这些文件：**
- `services/backend/src/services/mdSuggestedAppsPlan.js`
- `services/backend/tests/services/mdSuggestedAppsPlan.test.js`
- `tools/khyos-markdown/register-windows.ps1`
- `tools/khyos-markdown/unregister-windows.ps1`
- `services/backend/src/services/mdEditorRegister.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-077] Windows md 文件建议的应用注册.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:md-suggested-apps
```

---

### Fresh-machine Off-machine-restore Self-check in `khy doctor` (真实原因+解决方法 for a fresh pip/npm install)  `fresh-install-doctor`

**什么时候来这里（症状触发词）：**
- a user on a fresh machine installed via pip/npm and `khy` fails to start or behaves oddly — they need one command telling them the root cause and exact fix
- you want `khy doctor` to surface the shipped, human-facing off-machine-restore concerns: launch entry (bin/khy.js), server entry (server.js), dependency hydration (node_modules), khy-command reachability (PATH vs `python -m khy_platform`)
- you add a new fresh-install concern and must keep the pure assessor / IO gatherer split (assessFreshInstall never does IO, gatherFreshInstallFacts is injectable)
- this is the human-facing complement to the agent-facing restore-plan (agentRestorePlan) and the build-time mirrors (scripts/lib/restoreReadiness/installIntegrity/hydrationHealth)

**先读这些文件：**
- `services/backend/src/services/freshInstallDoctor.js`
- `services/backend/tests/services/freshInstallDoctor.test.js`
- `services/backend/src/cli/handlers/init.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-078] khy doctor 离机还原自检.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:fresh-install-doctor
```

---

### CJK-ize /recap so session recap produces content on Chinese sessions  `session-recap-cjk`

**什么时候来这里（症状触发词）：**
- a user runs /recap on a Chinese conversation and decisions/insights/open-questions come back empty, or file names get truncated at full-width punctuation (。，；！？) — the recap extractors were English-only
- you add a new Chinese decision/insight trigger stem or a new CJK terminator — extend the frozen arrays in sessionRecapCjk.js (_CJK_DECISION_MARKERS/_CJK_INSIGHT_MARKERS/_CJK_TERMINATORS)
- the CJK extraction is additive (union with the English extractors) and gated KHY_RECAP_CJK default-on; gate off byte-reverts generateRecap to the original English behavior
- this is the extraction complement to the /recap command shell (handlers/recap.js, gate KHY_RECAP) and the deterministic base service sessionRecapService.js

**先读这些文件：**
- `services/backend/src/services/sessionRecapCjk.js`
- `services/backend/tests/services/sessionRecapCjk.test.js`
- `services/backend/tests/services/sessionRecapService.cjk.test.js`
- `services/backend/src/services/sessionRecapService.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-080] recap 的 CJK 化.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:recap-cjk
```

---

### npm-channel Node version preflight (parity with pip check_node; kills the cross-channel off-machine-restore contradiction)  `npm-node-preflight`

**什么时候来这里（症状触发词）：**
- a user installs @khy-os/khy-os on a machine with Node < 20 and khy crashes cryptically deep in the backend instead of saying "need Node >= 20" — the pip channel already guards this via check_node, the npm launcher did not
- you raise the minimum Node major: keep MIN_MAJOR in nodeVersionPreflight.js in sync with pip cli.py check_node (major>=20), backend package.json engines, and devenv.js TOOLCHAINS
- you add a platform install hint or a China-mirror branch — extend _platformHint / _isChina, mirroring pip _print_node_install_hint
- the preflight is additive and gated KHY_NPM_NODE_PREFLIGHT default-on; gate off / any error / unparseable version byte-reverts bin/khy.js to the original unconditional spawnSync handoff (preflight must never be more fragile than the launch it protects)

**先读这些文件：**
- `packaging/npm/scripts/nodeVersionPreflight.js`
- `packaging/npm/test/nodeVersionPreflight.test.js`
- `packaging/npm/bin/khy.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-081] npm 渠道 Node 版本预检.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:node-preflight
```

---

### Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)  `restore-convergence-verifier`

**什么时候来这里（症状触发词）：**
- an agent is executing the restore-resolve recovery chain and needs, after each move + re-probe, a verdict on whether restore state actually advanced
- you must close the restore family execution feedback loop: plan/conflicts/resolve are open-loop planners; this layer judges executed moves
- guard against the self-drive failure modes at the restore layer: no-progress infinite loop, undetected regression, not-stopping-after-converged
- you need the stop condition: converged-stop (all three mirrors green) / continue (advancing) / escalate-human (regressed or stalled to the limit)
- tune the loop-guard sensitivity via STALL_LIMIT (consecutive no-progress rounds before forced human escalation)
- adding a new mirror/concern source: extend _unresolvedKeys(snapshot) only; set-diff verdict logic then applies automatically
- the OPS-MAN-082 convergence doc is out of sync with its generator

**先读这些文件：**
- `scripts/lib/restoreConvergenceVerifier.js`
- `scripts/restore-converge.js`
- `scripts/tests/restoreConvergenceVerifier.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-082] 三面镜子还原收敛与防循环.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:restore-converge
```

---

### Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具)  `dependency-wave-scheduler`

**什么时候来这里（症状触发词）：**
- khy auto-decomposes a goal into subtasks and you want the ones with declared dependencies (explore → implement → verify) to run in ORDER, not all fanned out at once
- a subtask carries a `dependencies` field (from _llmDecomposer or a future strategy) that must be honored as execution order instead of being dropped
- you add a new dependency-reference syntax and must keep the pure leaf (planWaves never does IO/throws) + the conservative flat/cycle/dangling fallbacks
- this is the missing consumer bridging _llmDecomposer's dependencies output to the existing parallel primitive AgentTool._runOrchestrated via ordered waves
- a subtask in a later wave declares a dependency on an EARLIER subtask that FAILED — fault-aware execution (gate KHY_DEP_WAVE_FAULT_STOP) short-circuits it to skipped-failure (依赖失败，已跳过) instead of running it on a broken premise (partitionWaveBySurvivors, skip propagates transitively)
- a downstream wave member should SEE its direct predecessors' output (implement seeing what explore produced) instead of running blind — predecessor-result CONTEXT INJECTION (gate KHY_DEP_WAVE_CONTEXT_INJECT) prepends [前驱结果 t<n>]: <text> (4000-char truncation, ascending, direct deps only) to its prompt via buildPredecessorContext/injectPredecessorContext
- the FINAL user-facing report must distinguish a dependency-SKIPPED subtask (依赖失败，已跳过) from one that genuinely ran and failed — mergeResults (taskDecomposer.js, gate KHY_MERGE_SKIP_DISTINCT) renders skips as a distinct 跳过（依赖失败） status and a separate 跳过 footer count instead of folding them into 失败 (fixes the last-mile consumer bridge for the 087 `skipped` flag)
- the whole wave arc is a silent no-op on the DEFAULT OFFLINE path (pip/npm install, no LLM key) because the four DETERMINISTIC decompose strategies emit NO `dependencies` — only the opt-in LLM strategy 5 does, and decompose is called without callModel. The deterministic sequential-chain producer _splitSequentialChain (taskDecomposer.js, gate KHY_SEQ_CHAIN_DECOMPOSE) recognizes 先…再…/然后/首先…其次…最后/then/finally and emits `dependencies: [priorIndex]` so planWaves compiles a serial chain offline (the producer side of the arc)
- the decompose `role` string (explore/verify/implement) drives model selection (subAgentModelSelect) but NOT tool scoping — a read-only explore/verify subtask still receives Write/Edit/NotebookEdit. roleToolScope(role) (orchestrator/roleToolScope.js, gate KHY_ROLE_TOOL_SCOPE) maps read-only roles (explore/verify/plan/research/audit/review) to a disallowedTools strip (Edit/Write/NotebookEdit, NOT Bash) and mergeRoleScopeInto unions it into a base denylist matching AgentTool.buildSubagentDenylist's shape (the missing tool-scoping consumer of role; consume seam = buildSubagentDenylist union point)

**先读这些文件：**
- `services/backend/src/services/orchestrator/dependencyWaveScheduler.js`
- `services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js`
- `services/backend/src/services/agenticHarnessService.js`
- `services/backend/src/services/taskDecomposer.js`
- `services/backend/tests/services/mergeResultsSkipDistinct.test.js`
- `services/backend/tests/services/sequentialChainDecompose.test.js`
- `services/backend/src/services/orchestrator/roleToolScope.js`
- `services/backend/tests/services/orchestrator/roleToolScope.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-083] 依赖感知波次调度.md
- docs/07_OPS_运维/[OPS-MAN-087] 波次执行故障感知.md
- docs/07_OPS_运维/[OPS-MAN-091] 波次前驱结果注入.md
- docs/07_OPS_运维/[OPS-MAN-092] 跳过与失败在最终报告分列.md
- docs/07_OPS_运维/[OPS-MAN-093] 确定性顺序链拆解.md
- docs/07_OPS_运维/[OPS-MAN-094] 角色工具作用域.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:dep-wave-schedule
npm run test:merge-skip-distinct
npm run test:seq-chain-decompose
npm run test:role-tool-scope
```

---

### Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)  `restore-autonomy-gate`

**什么时候来这里（症状触发词）：**
- a landing agent must decide, BEFORE running any restore move, whether self-driving on this machine is authorized at all (the should-I that precedes the how)
- guard against blast-radius: auto-restore could overwrite an existing usable install / config / proxy nodes / tasks under ~/.khy that the user never consented to touch
- the recovery chain from restore-resolve contains a dangerous shell action (rm/push/publish) that must never be auto-driven -> forbidden
- the chain requires a human (humanRequiredCount>0 or a move.autonomy===human): downgrade to ask-first if a human is reachable, forbidden if not
- there is overwrite risk but no interactive human (non-TTY): safe default is forbidden, never unattended-overwrite user data
- you need the closed loop head: authorize -> plan/conflicts/resolve/converge; converge judges the loop tail (did-it-work), this judges the loop head (should-I-start)
- the OPS-MAN-084 autonomy-gate doc is out of sync with its generator

**先读这些文件：**
- `scripts/lib/restoreAutonomyGate.js`
- `scripts/restore-authorize.js`
- `scripts/tests/restoreAutonomyGate.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-084] 还原自驱授权门.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:restore-authorize
```

---

### Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)  `restore-recourse-plan`

**什么时候来这里（症状触发词）：**
- restore-authorize returned forbidden or ask-first and the developer/user/maintainer needs an actionable unlock roadmap, not a dead-end no
- you need the inverse of the gate: authorize answers should-I, converge answers did-it-work, recourse answers if-no-what-is-the-minimal-path-to-yes
- an overwrite-risk denial should surface its cheapest downgrade (provide a TTY -> ask-first) and its full unlock (back up ~/.khy -> authorized)
- a dangerous-move denial must NOT promise any auto-unlock: it stays unresolved, human must review the chain (denial is actionable, not bypassable)
- you need aggregate signals: cheapest option, fullyAgentUnblockable (every blocker self-healable), bestReachable (weakest-link authorization tier)
- the authorization gate added a new blocker vocabulary term and _RECOURSE_RULES needs a matching recourse entry
- the OPS-MAN-085 recourse doc is out of sync with its generator

**先读这些文件：**
- `scripts/lib/restoreRecoursePlan.js`
- `scripts/restore-recourse.js`
- `scripts/tests/restoreRecoursePlan.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-085] 还原补救追索.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:restore-recourse
```

---

### Restore Trace Journal / Durable Agent Memory (append-only event stream that rebuilds the cross-process stallCount the convergence loop-guard needs; closes the real seam where converge resets stallCount to 0 on every independent CLI invocation)  `restore-trace-journal`

**什么时候来这里（症状触发词）：**
- an agent self-drives restore across many independent CLI invocations on a fresh machine and the converge loop-guard never escalates because stallCount resets to 0 each process
- you need the cross-process stallCount to feed back into restore-converge verifyConvergence({stallCount}) so the anti-deadloop actually fires across process boundaries
- a maintainer returns to a stuck machine and needs an audit trail of what the agent tried (reprobe x3 -> escalate) and where it stalled
- you add a new converge verdict and _STALL_RULE (reset/keep/inc) needs a matching replay contribution so stallCount stays correct
- the journal file lives at ~/.khy/.restore-trace/<session>.jsonl: a dot-prefixed dir deliberately excluded by the authorization gate user-data probe (operation trace is not user data)
- the OPS-MAN-086 trace-journal doc is out of sync with its generator

**先读这些文件：**
- `scripts/lib/restoreTraceJournal.js`
- `scripts/restore-trace.js`
- `scripts/tests/restoreTraceJournal.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-086] 还原轨迹日志.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:restore-trace
```

---

### Restore Strategy Ledger / Cross-Session Learning (learns across ALL sessions on this machine which resolution strategies have been repeatedly proven dead, so the next self-drive skips them instead of re-walking known dead-ends; the machine-level complement to the per-session trace journal)  `restore-strategy-ledger`

**什么时候来这里（症状触发词）：**
- an agent repeatedly lands on the same problem machine and keeps re-trying a strategy that prior sessions already proved is a dead-end (stalled->escalate every time)
- you need cross-session learning: the trace journal (086) is per-session memory; the ledger (088) aggregates ALL ~/.khy/.restore-trace/*.jsonl to learn machine-wide
- a strategy is only classified dead when it stalled across >= MIN_SAMPLES independent sessions and NEVER once advanced/converged (safety-first: one success clears all failures)
- you need recommendedSkips (strategies to skip next time) without ever reordering the resolver safety chain (learning subtracts, it does not reorder)
- single-session repeated failure must stay unproven (one unlucky session must never permanently blacklist a usable strategy)
- the OPS-MAN-088 strategy-ledger doc is out of sync with its generator

**先读这些文件：**
- `scripts/lib/restoreStrategyLedger.js`
- `scripts/restore-ledger.js`
- `scripts/tests/restoreStrategyLedger.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-088] 还原策略台账.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:restore-ledger
```

---

### Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)  `restore-skip-applier`

**什么时候来这里（症状触发词）：**
- the strategy ledger (088) produced recommendedSkips but grep shows zero consumers, so learned dead-ends were never actually avoided (dead field / broken bridge)
- you need to APPLY cross-session learning to the resolver moves: annotate each with learnedDead/safeToSkip/mustTryDespiteDead, order-preserving
- a learned-dead strategy must only be safeToSkip when every conflict it covers has a live (non-dead) alternative move; otherwise mustTryDespiteDead (never strand a conflict)
- escalate is the human safety net and must NEVER be safeToSkip even if learned dead (learning must not swallow the hand-off-to-human exit)
- honesty boundary: the applier only annotates, never deletes a move and never reorders the risk-ordered safety chain (reprobe->reconcile->trust-pessimistic->escalate)
- you want the full end-to-end loop: gatherAssessments -> detect -> resolve -> ledger -> applyLearnedSkips via scripts/restore-apply.js
- the OPS-MAN-089 skip-applier doc is out of sync with its generator

**先读这些文件：**
- `scripts/lib/restoreSkipApplier.js`
- `scripts/restore-apply.js`
- `scripts/tests/restoreSkipApplier.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-089] 还原学习应用器.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:restore-apply
```

---

### Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)  `restore-navigator`

**什么时候来这里（症状触发词）：**
- the restore family is complete (12 leaves / 10 CLIs) but NOT simple: a fresh machine faces 10 diagnostic commands with no unified verdict and no single next-action (directly serves the user goal of a complete AND simple restore)
- you need ONE answer to "which command do I run right now, who runs it (agent/human), and why" derived from the whole family
- safety-first decision order (most dangerous first): forbidden -> hard-conflict -> agent-drive -> DONE -> conservative unknown; the first matching tier decides the sole verdict
- it must RESPECT the skip-applier (010) learning: pick the first move NOT marked safeToSkip; mustTryDespiteDead steps still run (sole path / safety net)
- honesty boundary: the navigator only READS existing verdict fields, never reorders/deletes/fabricates authorized; malformed/missing fields -> conservative UNKNOWN + human
- a dangerous command in the chosen step is redacted and forces actor=human (inherits the whole-family _DANGER_TOKENS red line)
- you want the single front door: node scripts/restore-navigate.js --json (a fresh-machine self-driving agent reads it to decide the next step)
- the OPS-MAN-090 navigator doc is out of sync with its generator

**先读这些文件：**
- `scripts/lib/restoreNavigator.js`
- `scripts/restore-navigate.js`
- `scripts/tests/restoreNavigator.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-090] 还原导航器.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:restore-navigate
```

---

### Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)  `restore-completeness-verifier`

**什么时候来这里（症状触发词）：**
- khy restore only checks tar exit code and prints 完整还原; it NEVER reconciles the snapshot header fileCount (git ls-tree -r blob count) against the files actually on disk -> silent under-extraction reads as complete
- you need a post-restore completeness check a fresh-machine agent can run offline: node scripts/restore-verify-complete.js <dir> --json
- verdict tiers (conservative first): unverifiable (no reconcilable counts) -> corrupt (sha256/tar precheck failed) -> incomplete (actual<expected, the silent under-extraction) -> over-extracted (actual>expected, residue/drift) -> complete (counts match AND precheck passed)
- honesty boundary: ok===true ONLY when status===complete; evidence-insufficient never defaults to complete (unverifiable)
- count semantics: expected = snapshot fileCount; actual = recursive regular-file count of the restored dir (excludes .git and snapshot sidecars, no symlink follow) to match git archive layout
- --json exits 2 on any non-complete status so a self-driving agent does NOT treat the restore as finished
- the OPS-MAN-095 completeness doc is out of sync with its generator

**先读这些文件：**
- `scripts/lib/restoreCompletenessVerifier.js`
- `scripts/restore-verify-complete.js`
- `scripts/tests/restoreCompletenessVerifier.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-095] 还原解包完整性对账.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:restore-verify-complete
```

---

### Multi-Model-Type Provider Config Reconciler (the four user-facing model TYPES each resolve a provider through DISCONNECTED env namespaces: text via apiKeyPool/providerPresets/gateway, video via KHY_VIDEO_GEN_* outside the registry, vector via EMBED_URL/ollama/gateway embeddings, role via subAgentModelSelect reusing the text pool; the capability taxonomy names these buckets but NOTHING reconciles per-type whether a user supplied a working API and whether it is a relay(中转站)/direct(直连)/local endpoint; this pure leaf + read-only CLI answers "which types are ready and how is each wired" for a fresh-machine user configuring different APIs per type)  `model-type-provider-plan`

**什么时候来这里（症状触发词）：**
- a user wants to point different model TYPES at different APIs (relay 中转站 or direct 直连) and needs one coherent answer to which of text/video/vector/role are configured
- run: node scripts/model-type-providers.js (human table) or --json (exit 2 unless all four ready)
- channel is classified ONLY from the base URL host vs the providerPresets official-host SSOT: loopback -> local; host in official allowlist -> direct(直连); any other public host -> relay(中转站); key but no base url -> unknown(default host)
- configured requires a usable credential path: a key OR a local backend (local needs no key); base url with no key -> keyless, not ready
- video awareness: KHY_VIDEO_GEN_POOL_BRIDGE (default-on) lets a chat key back video generation; role awareness: KHY_SUBAGENT_MODEL_AUTOSELECT off -> role unconfigured
- secret hygiene (red-line): the CLI reads only credential PRESENCE (boolean), never key/token values; only non-secret base URLs and booleans leave the tool
- malformed/broken env -> all-unconfigured, never throws, never fabricates a ready verdict

**先读这些文件：**
- `scripts/lib/modelTypeProviderPlan.js`
- `scripts/model-type-providers.js`
- `scripts/tests/modelTypeProviderPlan.test.js`

**参考文档：**
- docs/07_OPS_运维/[OPS-MAN-096] 多模型类型 Provider 配置对账.md

**跑这些验证命令（绿灯＝这块没坏）：**

```bash
npm run test:model-type-providers
```

---

## 都不对？

- 把报错原文完整贴给分诊器：`npm run triage -- "<把报错粘这里>"`。
- 仍无匹配就查总入口 `docs/00_INDEX_文档索引.md`，或读 `.ai/MAP.md` 了解全局骨架。
- 新子系统请先登记进 `docs/维护者/维护映射表.json`，本表下次重生会自动收录它。
