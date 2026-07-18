'use strict';

/**
 * Router ops-cluster command dispatch (extracted from cli/router.js).
 *
 * Owns the verbatim case bodies for the operational / diagnostic command family that used to live
 * inline in the giant route() switch: log, cost, usage, history, update, compute, train, admin, growth,
 * agent, prompt, voice, knowledge, security, monitor, services, linux, shell. Extracted as a
 * same-directory sibling leaf so the in-body relative require() paths inside each case resolve
 * identically; the bodies are byte-identical.
 *
 * route() now pre-dispatches to dispatchOpsCommand(command, ctx) before its main switch: for these
 * commands the handler runs and returns its value; for every other command it returns the
 * ROUTER_NOT_HANDLED sentinel and route() falls through to the remaining switch — preserving the
 * original dispatch semantics exactly.
 *
 * This leaf runs command handlers that perform IO (spawning tools, filesystem, network), so it does
 * NOT self-declare as a pure zero-IO leaf. The only host-scope callbacks the moved bodies reference
 * (handleLogCommand from the routerHandlers factory, _handleResumeFlow, _ccFileSize) are injected via
 * setRouterDispatchOpsDeps to avoid a require cycle back into router.js. Every other symbol each case
 * uses is either lazily require()'d inside the case body or one of the 15 route()-scope locals passed
 * in via ctx.
 */

const ROUTER_NOT_HANDLED = Symbol('router_ops_not_handled');

// ── Host callbacks injected via DI (avoid a require cycle back into router.js) ──
let handleLogCommand = null;
let _handleResumeFlow = null;
let _ccFileSize = null;

function setRouterDispatchOpsDeps(deps = {}) {
  if (typeof deps.handleLogCommand === 'function') handleLogCommand = deps.handleLogCommand;
  if (typeof deps._handleResumeFlow === 'function') _handleResumeFlow = deps._handleResumeFlow;
  if (typeof deps._ccFileSize === 'function') _ccFileSize = deps._ccFileSize;
}

async function dispatchOpsCommand(command, _ctx) {
  const {
    subCommand, args, options, rawCommandToken, parsed, context,
    printError, printHelp, printInfo, printTable, printSuccess, printWarn, withSpinner, chalk,
  } = _ctx;
  switch (command) {
      case 'log': {
        await handleLogCommand(subCommand, args, options);
        return true;
      }

      case 'cost':
      case 'usage': {
        const tokenSvc = require('../services/tokenUsageService');
        if (subCommand === 'reset') {
          tokenSvc.resetUsage();
          printSuccess('Token 用量统计已重置');
        } else if (subCommand === 'today') {
          const today = tokenSvc.getTodayUsage();
          console.log(chalk.bold('\n  📊 今日用量'));
          console.log(chalk.dim(`  请求: ${today.requests} 次 · tokens: ${tokenSvc._fmtTokenCount(today.totalTokens, today.totalTokens.toLocaleString())}\n`));
        } else if (subCommand === 'history') {
          const history = tokenSvc.getUsageHistory(14);
          console.log(chalk.bold('\n  📊 近14天用量'));
          for (const day of history) {
            if (day.totalTokens === 0 && day.requests === 0) continue;
            const bar = '█'.repeat(Math.min(30, Math.ceil(day.totalTokens / 1000)));
            console.log(chalk.dim(`  ${day.date} `) + chalk.cyan(bar) + chalk.dim(` ${tokenSvc._fmtTokenCount(day.totalTokens, day.totalTokens.toLocaleString())}`));
          }
          console.log('');
        } else {
          // Default: show full cost report (like Claude's /cost)
          console.log(tokenSvc.formatCostReport());
        }
        return true;
      }

      case 'history': {
        const ai = require('./ai');
        if (subCommand === 'list' || !subCommand) {
          const convos = ai.listConversations();
          if (convos.length === 0) {
            printInfo('暂无保存的对话记录');
          } else {
            console.log(chalk.bold('\n  💬 对话历史\n'));
            convos.slice(0, 10).forEach((c, i) => {
              const date = c.timestamp ? new Date(c.timestamp).toLocaleString('zh-CN') : c.file;
              const sid = c.sessionId || String(c.file || '').replace(/\.json$/i, '');
              console.log(
                chalk.dim(`  ${i + 1}. `)
                + chalk.white(date)
                + chalk.dim(` (${c.messageCount} 条消息)`)
                + chalk.dim(` [ID: ${sid}]`)
              );
            });
            console.log(chalk.dim('\n  使用 resume <序号|会话ID> 恢复对话上下文\n'));
          }
        } else if (subCommand === 'resume') {
          // `resume` is aliased to `history resume`, so this is the primary
          // resume entry point. Delegate to the unified flow so the full-fidelity
          // JSONL transcript store (Store B) is checked before the legacy summary
          // store — the shutdown banner prints a Store B id that the legacy store
          // alone cannot resolve.
          return _handleResumeFlow({
            ai,
            arg0: args[0],
            printSuccess, printInfo, printError, printWarn,
            chalkApi: chalk,
          });
        } else if (subCommand === 'clear') {
          const fs = require('fs');
          const os = require('os');
          const convoDir = path.join(os.homedir(), '.khyquant', 'conversations');
          try {
            try { ai.clearHistory(); } catch { /* non-critical */ }
            if (fs.existsSync(convoDir)) {
              const files = fs.readdirSync(convoDir).filter(f => f.endsWith('.json'));
              files.forEach(f => fs.unlinkSync(path.join(convoDir, f)));
              printSuccess(`已清除 ${files.length} 条对话记录，并重置当前会话上下文`);
            } else {
              printInfo('无对话记录需要清除，当前会话上下文已重置');
            }
          } catch { printError('清除失败'); }
        }
        return true;
      }

      case 'update': {
        const { execSync } = require('child_process');
        const { PACKAGE_CANDIDATES: packageCandidates } = require('../services/versionService');
        const pipCmd = process.platform === 'win32' ? 'pip' : 'pip3';
        // 纯叶子:pip 失败分类 + 直连重试策略 + 确定性诊断(门控 KHY_PIP_FAILURE_POLICY 默认开)。
        // fail-soft 惰性 require:取不到则 policyOn=false,逐字节回退旧「直接 throw + 截断错误」行为。
        const pipPolicy = (() => { try { return require('../services/pipFailurePolicy'); } catch { return null; } })();
        const policyOn = !!(pipPolicy && pipPolicy.isEnabled());

        const readInstalledVersion = (pkgName) => {
          try {
            const info = execSync(`${pipCmd} show ${pkgName}`, { encoding: 'utf-8', timeout: 5000 });
            const match = info.match(/Version:\s*([\d.]+)/);
            return match ? match[1] : '';
          } catch {
            return '';
          }
        };

        // 读回版本 + 报告版本实际读自哪个包(供版本串包守卫检测「回退读了别的包」)。
        // 返回 { version, versionPkg }:versionPkg 为空表示所有候选都读不出。
        const readInstalledVersionTraced = (pkgName) => {
          const direct = readInstalledVersion(pkgName);
          if (direct) return { version: direct, versionPkg: pkgName };
          for (const candidate of packageCandidates) {
            if (candidate === pkgName) continue;
            const v = readInstalledVersion(candidate);
            if (v) return { version: v, versionPkg: candidate };
          }
          return { version: '', versionPkg: '' };
        };

        const detectInstalledPackage = () => {
          for (const pkgName of packageCandidates) {
            if (readInstalledVersion(pkgName)) return pkgName;
          }
          return packageCandidates[0];
        };

        // 修②:清理 pip 半装残骸(~ 前缀损坏目录)。纯叶子 pipResiduePolicy 出「删哪些」的确定性计划,
        // 这里只据计划做受限删除(仅 khy 家族 `~` 前缀目录),全程 fail-soft:任何一步失败都不影响升级。
        const purgePipResidue = (pipOutput) => {
          try {
            const residuePolicy = (() => {
              try { return require('../services/pipResiduePolicy'); } catch { return null; }
            })();
            if (!residuePolicy || !residuePolicy.isResiduePurgeEnabled(process.env)) return 0;
            const found = residuePolicy.parseInvalidDistResidue(pipOutput);
            if (!found.length) return 0;
            const fs = require('fs');
            const path = require('path');
            const locations = Array.from(new Set(found.map((r) => r.location).filter(Boolean)));
            const entries = [];
            for (const loc of locations) {
              let names = [];
              try { names = fs.readdirSync(loc); } catch { continue; }
              for (const name of names) entries.push({ location: loc, name });
            }
            const plan = residuePolicy.buildResiduePurgePlan({ entries, pathSep: path.sep, env: process.env });
            if (!plan.shouldPurge) return 0;
            let purged = 0;
            for (const target of plan.targets) {
              try { fs.rmSync(target, { recursive: true, force: true }); purged += 1; } catch { /* fail-soft */ }
            }
            if (purged > 0) {
              printInfo(`  已清理 ${purged} 个 pip 半装残骸(~ 前缀损坏目录),pip show 版本读取已恢复干净。`);
            }
            return purged;
          } catch {
            return 0;
          }
        };

        console.log(chalk.bold('\n  🔄 khy OS 自动更新\n'));
        printInfo('检查最新版本...');
        // 提升到 try 外,供 catch 构造确定性诊断时引用。
        let proxyRetried = false;
        let lockRetried = false; // 文件占用(WinError 32)一次性自动重试是否已用掉(全局仅一次)。
        let lastDetail = '';
        let updateChannelPkg = 'khy-os';
        try {
          const currentVersion = process.env.KHYQUANT_PKG_VERSION || require('../../package.json').version;
          printInfo(`当前版本: v${currentVersion}`);
          const installedPkg = detectInstalledPackage();
          updateChannelPkg = installedPkg || 'khy-os';
          printInfo(`更新通道: ${installedPkg} (兼容 khy-quant)`);

          // Windows 升级前预检:检测是否有其它 khy/node 进程(可能锁文件导致 WinError 32)。
          // 仅 Windows 且门控开时执行;fail-soft,绝不因预检失败而中断升级。
          if (process.platform === 'win32' && policyOn) {
            try {
              const tasklistOut = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV', {
                encoding: 'utf-8',
                timeout: 5000,
              });
              const risk = pipPolicy.detectWindowsUpgradeLockRisk({
                platform: process.platform,
                processListText: tasklistOut,
              });
              const stopPlan = pipPolicy.buildUpgradeStopPlan({
                platform: process.platform,
                risk,
                env: process.env,
              });
              if (stopPlan.shouldStop) {
                // 不再只警告并继续:实际停掉锁文件的常驻进程,再跑 pip(否则 WinError 32 → 装到一半损坏)。
                // 全程 fail-soft:任何一步失败都不中断升级(退回今日「继续尝试」行为)。
                printWarn(stopPlan.message);
                // ① 停管理守护进程(锁 bundle 的 node.exe,关键一步)。
                try {
                  require('../services/daemonManager').daemonStop();
                  printInfo('  已停止管理守护进程。');
                } catch { /* fail-soft:守护进程未运行或停机失败,继续。 */ }
                // ② best-effort 停托盘,防升级窗口内被重新拉起。
                try {
                  execSync('khy tray stop', { encoding: 'utf-8', timeout: 8000, stdio: 'ignore' });
                  printInfo('  已停止系统托盘。');
                } catch { /* fail-soft:khy 不在 PATH / 托盘未运行 / 超时,继续。 */ }
                printInfo('  升级后守护进程会在下次使用时自动重启。');
              } else if (risk.atRisk) {
                // 门控关等场景:逐字节回退今日「只警告并继续」行为。
                printWarn(
                  '提示:检测到还有其它 khy / node 进程在运行。Windows 升级前建议先关掉所有其它 khy\n' +
                  '      窗口,否则文件被占用可能导致本次升级失败(WinError 32)。正在继续尝试升级…'
                );
              }
            } catch {
              // Fail-soft:取不到进程列表就静默跳过,不阻断升级。
            }
          }

          printInfo('正在更新到最新版本...');
          let output = '';
          let upgradedPkg = null;
          let lastError = null;

          // 组装 pip 升级命令串(shell 形态,与旧 execSync 路径逐字节一致,保证 Windows 上
          // pip.exe/pip.cmd 的解析行为不变)。bypassProxy → --proxy "";forceReinstall →
          // --force-reinstall --no-cache-dir(文件占用重试时干净覆盖半装残骸)。
          const buildPipCmd = ({ pkgName, bypassProxy, forceReinstall }) => {
            let c = `${pipCmd} install`;
            if (bypassProxy) c += ' --proxy ""';
            if (forceReinstall) c += ' --force-reinstall --no-cache-dir';
            c += ` --upgrade ${pkgName}`;
            return c;
          };

          // 流式跑 pip 升级:把 pip 的 Collecting/Downloading(带 MB 计数)/Installing 输出**实时**
          // tee 到终端(修:「更新时不显示下载进度」——旧 execSync 整段捕获,跑完才出结果、全程静默),
          // 同时累积到 buffer 供后续残骸清理 / 成功判定 / 失败分类(output 语义保持不变)。
          // 门控 KHY_UPDATE_STREAM_PROGRESS 默认开;关 → 逐字节回退旧 execSync 捕获(无实时进度)。
          // 非零退出 → 抛出带 .stdout 的错误(与 execSync 抛错形态一致,供 classifyPipFailure 消费)。绝不吞错。
          const _streamFalsy = new Set(['0', 'false', 'off', 'no']);
          const streamEnabled = !_streamFalsy.has(String(process.env.KHY_UPDATE_STREAM_PROGRESS || '').trim().toLowerCase());
          const runPipUpgrade = ({ pkgName, bypassProxy, forceReinstall }) => new Promise((resolve, reject) => {
            const cmd = buildPipCmd({ pkgName, bypassProxy, forceReinstall });
            const spawnEnv = (bypassProxy && policyOn) ? pipPolicy.stripProxyEnv(process.env) : process.env;
            // 门控关:逐字节回退旧行为(execSync 捕获 + 2>&1,无实时进度)。
            if (!streamEnabled) {
              try {
                resolve(String(execSync(`${cmd} 2>&1`, { encoding: 'utf-8', timeout: 120000, env: spawnEnv }) || ''));
              } catch (e) { reject(e); }
              return;
            }
            const { spawn } = require('child_process');
            let buf = '';
            let child;
            try {
              child = spawn(cmd, { env: spawnEnv, shell: true });
            } catch (e) { e.stdout = buf; reject(e); return; }
            let timedOut = false;
            let idleTimer = null;
            // 活动续期的**空闲**超时(非硬超时):每收到一段 pip 输出就续期,只有真正卡死
            //(120s 无任何输出)才杀。正在下载/安装的 pip 会持续吐 Collecting/Downloading/Installing,
            // 不会被误杀——比旧 execSync 的固定总超时更贴合长时间下载。
            const armIdle = () => {
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* already gone */ } }, 120000);
            };
            const disarmIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
            const onData = (chunk) => {
              const s = chunk.toString('utf-8');
              buf += s;
              armIdle(); // 收到输出即续期(活动续期)。
              try { process.stdout.write(s); } catch { /* tee best-effort:写终端失败不影响捕获。 */ }
            };
            if (child.stdout) child.stdout.on('data', onData);
            if (child.stderr) child.stderr.on('data', onData);
            armIdle(); // 起始武装,防子进程从不吐字就永久挂起。
            child.on('error', (e) => { disarmIdle(); e.stdout = buf; reject(e); });
            child.on('close', (code) => {
              disarmIdle();
              if (timedOut) { const e = new Error('pip upgrade timed out'); e.stdout = buf; reject(e); return; }
              if (code === 0) { resolve(buf); return; }
              const e = new Error(`pip exited with code ${code}`);
              e.stdout = buf;
              e.status = code;
              reject(e);
            });
          });

          for (const pkgName of packageCandidates) {
            // 内层:先正常装;门控开且判为代理/网络失败时,绕过代理直连重试一次(全局只重试一次);
            // 判为文件占用(WinError 32)时,停占用进程 + 清残骸 + 短暂等待后,以 --force-reinstall 重试一次。
            let bypassProxy = false;
            let forceReinstall = false;
            for (;;) {
              try {
                output = await runPipUpgrade({ pkgName, bypassProxy, forceReinstall });
                upgradedPkg = pkgName;
                break;
              } catch (err) {
                const detail = `${err.stdout || ''}\n${err.stderr || ''}\n${err.message || ''}`;
                lastError = err;
                lastDetail = detail;
                if (policyOn) {
                  const cls = pipPolicy.classifyPipFailure(detail);
                  // 代理/网络失败:全局首次自动绕过代理直连重试同一个包。
                  if (cls.retryWithoutProxy && !bypassProxy && !proxyRetried) {
                    proxyRetried = true;
                    bypassProxy = true;
                    printWarn('检测到代理/网络连接失败,正在尝试绕过代理直连重试...');
                    continue;
                  }
                  // 文件占用(WinError 32):停占用进程 + 清残骸 + 等待句柄释放后,--force-reinstall 重试一次
                  //(修:「pip 装到一半失败,往往要装两次才成功」——把用户手动的「第二次」收进同一条命令内)。
                  const lockPlan = pipPolicy.buildLockRetryPlan({
                    kind: cls.kind,
                    alreadyRetried: lockRetried,
                    env: process.env,
                  });
                  if (lockPlan.shouldRetry) {
                    lockRetried = true;
                    printWarn('检测到安装目录被占用(WinError 32)。正在停占用进程 + 清理半装残骸后自动重试一次…');
                    // ① 再停一次管理守护进程(它最可能持有 bundle 文件句柄)。fail-soft。
                    try {
                      require('../services/daemonManager').daemonStop();
                      printInfo('  已停止管理守护进程(释放文件占用)。');
                    } catch { /* fail-soft:守护进程未运行或停机失败,继续。 */ }
                    // ② 清理 pip 半装残骸(~ 前缀损坏目录),否则重装仍会撞上它。fail-soft。
                    try { purgePipResidue(detail); } catch { /* fail-soft */ }
                    // ③ 等待 OS 释放文件句柄,再以 --force-reinstall --no-cache-dir 干净覆盖重试。
                    await new Promise((r) => setTimeout(r, lockPlan.waitMs));
                    forceReinstall = lockPlan.forceReinstall;
                    continue;
                  }
                  // 其余(not-found / 重试后仍失败 / 其它):放弃此包,外层换下一个候选。
                  break;
                }
                // 门控关:逐字节回退旧行为(找不到分布→换候选;其它→直接抛)。
                if (/No matching distribution found|Could not find a version|404|not found/i.test(detail)) {
                  break;
                }
                throw err;
              }
            }
            if (upgradedPkg) break;
          }
          if (!upgradedPkg) {
            throw lastError || new Error('No installable package found for upgrade');
          }

          if (output.includes('Successfully installed') || output.includes('already up-to-date') || output.includes('already satisfied')) {
            // 修②:先清理 pip 半装残骸(~ 前缀损坏目录)——它是 WinError 32 遗留,会让
            // `pip show khy-os` 读不出真身 → 回退读到无关包(串包 1.8.0)。清理后 pip show 恢复干净,
            // 下面的 readInstalledVersionTraced 就能读回 khy-os 真实版本。全程 fail-soft。
            purgePipResidue(output);
            const traced = readInstalledVersionTraced(upgradedPkg);
            const newVersion = traced.version || currentVersion;

            // 版本串包守卫(修①):防止把无关包(如 khy-quant)的版本冒充成 khy-os 的升级结果。
            // WinError 32 的 `~hy-os` 半装残骸会让 pip show khy-os 读不出 → 回退读到本地
            // khy-quant 的 1.8.0。守卫判为跨包泄漏/主版本反常跳变时,拒绝显示假版本并给出可执行指引。
            let versionTrust = { trusted: true };
            if (policyOn && traced.version) {
              versionTrust = pipPolicy.evaluateUpdatedVersion({
                targetPkg: 'khy-os',
                upgradedPkg,
                versionPkg: traced.versionPkg,
                currentVersion,
                newVersion,
                env: process.env,
              });
            }

            if (!versionTrust.trusted) {
              printWarn(versionTrust.message);
              printInfo('已完成 pip 升级动作,但读回的版本号不可信(见上)。请重启 CLI 后用 pip show khy-os 核对。');
            } else if (newVersion !== currentVersion) {
              printSuccess(`更新完成: v${currentVersion} → v${newVersion}`);
              printInfo('新版本已包含最新混淆保护。请重启 CLI 以应用更新。');
            } else {
              printSuccess('已是最新版本 ✓');
            }

            // 渠道共存:pip 升级后,若 npm 渠道也在,顺带把它同步到最新,避免另一渠道陈旧
            // (PATH 遮蔽下用户会误以为已升级)。全程 fail-soft,npm 失败绝不影响 pip 结果。
            try {
              const selfUpdate = require('../services/khySelfUpdateService');
              if (selfUpdate.coexistEnabled() && selfUpdate._npmGlobalHasKhy(execSync)) {
                printInfo('检测到 npm 渠道,正在同步 npm 渠道到最新...');
                const npmRes = selfUpdate._updateNpmChannel(execSync, process.env);
                if (npmRes.success) {
                  printSuccess(`npm 渠道已同步 (${selfUpdate.NPM_PACKAGE}${npmRes.to ? ' v' + npmRes.to : ''})`);
                } else {
                  printWarn(npmRes.error || 'npm 渠道同步失败');
                  if (npmRes.hint) printInfo(npmRes.hint);
                }
              }
            } catch { /* fail-soft:取不到自更新叶子或 npm 不可用,静默跳过,不影响 pip 结果。 */ }
          } else {
            printWarn('更新输出: ' + output.slice(0, 200));
          }
        } catch (err) {
          if (policyOn) {
            // 确定性诊断:代理拒连/网络/找不到/权限 → 可执行修复方案,而非截断的原始错误。
            const detail = lastDetail || `${err.stdout || ''}\n${err.stderr || ''}\n${err.message || ''}`;
            const cls = pipPolicy.classifyPipFailure(detail);
            const diagnosis = pipPolicy.buildPipFailureDiagnosis({
              kind: cls.kind,
              pkg: updateChannelPkg,
              autoRetried: proxyRetried,
            });
            printError(diagnosis);
          } else {
            printError('更新失败: ' + (err.message || '').slice(0, 200));
            printInfo('手动更新: pip install --upgrade khy-os (兼容: khy-quant)');
          }
        }
        console.log('');
        return true;
      }

      case 'compute': {
        const training = require('../services/modelTrainingService');
        const status = training.getComputeStatus();
        console.log(chalk.bold('\n  🖥️  本地算力状态\n'));
        console.log(chalk.dim('  平台: ') + chalk.white(`${status.platform} ${status.arch}`));
        console.log(chalk.dim('  CPU: ') + chalk.white(`${status.cpus} 核`));
        console.log(chalk.dim('  RAM: ') + chalk.white(`${status.freeRAM}GB / ${status.totalRAM}GB`));
        if (status.gpu) {
          console.log(chalk.dim('  GPU: ') + chalk.green(`${status.gpu.type} × ${status.gpu.count}`));
          if (status.gpu.devices) {
            status.gpu.devices.forEach(d => console.log(chalk.dim('       ') + chalk.white(`${d.name} (${d.memory})`)));
          }
        } else {
          console.log(chalk.dim('  GPU: ') + chalk.yellow('未检测到 (将使用 CPU 训练)'));
        }
        console.log(chalk.dim('  Python: ') + (status.pythonAvailable ? chalk.green('✓') : chalk.red('✗ 需安装')));
        console.log(chalk.dim('  PyTorch: ') + (status.torchAvailable ? chalk.green('✓') : chalk.red('✗ pip install torch')));
        console.log(chalk.dim('  CUDA: ') + (status.cuda ? chalk.green('✓') : chalk.dim('—')));
        console.log(chalk.dim('  MPS: ') + (status.mps ? chalk.green('✓ (Apple Metal)') : chalk.dim('—')));
        console.log('');
        return true;
      }

      case 'train': {
        const training = require('../services/modelTrainingService');

        if (!subCommand || subCommand === 'status') {
          // Show training data stats + registered models
          const stats = training.getDatasetStats();
          const models = training.listModels();
          const modelNames = Object.keys(models);
          console.log(chalk.bold('\n  🧠 模型训练系统\n'));
          console.log(chalk.dim('  训练数据: ') + chalk.white(`${stats.total} 条记录`));
          if (stats.byType && Object.keys(stats.byType).length > 0) {
            Object.entries(stats.byType).forEach(([type, count]) => {
              console.log(chalk.dim(`    ${type}: `) + chalk.white(count));
            });
          }
          console.log(chalk.dim('  已训练模型: ') + chalk.white(modelNames.length === 0 ? '无' : ''));
          modelNames.forEach(name => {
            const m = models[name];
            console.log(chalk.cyan(`    ${name}`) + chalk.dim(` (基于 ${m.basedOn}, ${m.method}, ${new Date(m.trainedAt).toLocaleDateString('zh-CN')})`));
          });
          console.log(chalk.dim('\n  命令:'));
          console.log(chalk.dim('    train start [--base qwen-3b] [--preset standard]  本地微调'));
          console.log(chalk.dim('    train cloud [--base qwen-7b]                      云端训练'));
          console.log(chalk.dim('    train distill                                     知识蒸馏'));
          console.log(chalk.dim('    train data                                        查看训练数据'));
          console.log(chalk.dim('    train export <model> [--format gguf|safetensors]   导出模型'));
          console.log(chalk.dim('    train list                                        列出已训练模型'));
          console.log(chalk.dim('    compute                                           查看算力状态'));
          console.log('');

        } else if (subCommand === 'data') {
          const stats = training.getDatasetStats();
          console.log(chalk.bold('\n  📊 训练数据统计\n'));
          console.log(chalk.dim('  总记录数: ') + chalk.white(stats.total));
          Object.entries(stats.byType || {}).forEach(([type, count]) => {
            console.log(chalk.dim(`  ${type}: `) + chalk.white(count));
          });
          if (stats.total > 0) {
            console.log(chalk.dim('\n  导出数据集: train export-data [--format alpaca|sharegpt|openai]'));
          } else {
            console.log(chalk.dim('\n  使用 AI 对话功能积累训练数据，系统自动记录高质量交互'));
          }
          console.log('');

        } else if (subCommand === 'list') {
          const models = training.listModels();
          const modelNames = Object.keys(models);
          if (modelNames.length === 0) {
            printInfo('暂无训练模型。使用 train start 开始训练');
          } else {
            console.log(chalk.bold('\n  🧠 已训练模型 (khy-xxx)\n'));
            modelNames.forEach(name => {
              const m = models[name];
              console.log(chalk.cyan(`  ${name}`));
              console.log(chalk.dim(`    基础: ${m.basedOn}`));
              console.log(chalk.dim(`    方法: ${m.method} · 数据量: ${m.datasetSize}`));
              console.log(chalk.dim(`    时间: ${new Date(m.trainedAt).toLocaleString('zh-CN')}`));
              console.log(chalk.dim(`    路径: ${m.path}`));
              console.log('');
            });
          }

        } else if (subCommand === 'start') {
          const baseModel = options.base || options.model || 'qwen-3b';
          const preset = options.preset || 'standard';
          const stats = training.getDatasetStats();

          if (stats.total < 10) {
            printWarn(`训练数据不足 (当前 ${stats.total} 条，建议 50+ 条)`);
            printInfo('继续使用 AI 对话以积累更多训练数据');
            return true;
          }

          printInfo(`准备本地微调: base=${baseModel}, preset=${preset}`);
          const dataset = training.exportDataset('alpaca', { quality: 'good' });
          printInfo(`数据集: ${dataset.count} 条 → ${dataset.path}`);

          const modelName = options.name || `khy-${training.getNextVersion()}`;
          printInfo(`开始训练 ${modelName}... (这可能需要几分钟到几小时)`);

          try {
            const result = await training.trainLocal({
              baseModel,
              datasetPath: dataset.path,
              outputName: modelName,
              preset,
              onProgress: (pct, msg) => {
                process.stdout.write(`\r  训练进度: ${pct}% ${msg || ''}`);
              },
            });
            console.log('');
            if (result.success) {
              printSuccess(`模型训练完成: ${modelName}`);
              printInfo(`路径: ${result.modelPath}`);
              printInfo('导出: train export ' + modelName + ' --format gguf');
            } else {
              printError('训练失败: ' + (result.error || '').slice(0, 200));
            }
          } catch (err) {
            printError(err.message);
          }

        } else if (subCommand === 'cloud') {
          const baseModel = options.base || 'qwen-7b';
          printInfo('提交云端训练任务...');
          try {
            const dataset = training.exportDataset('alpaca');
            const result = await training.trainCloud({ baseModel, datasetPath: dataset.path });
            if (result.success) {
              printSuccess(`训练任务已提交: ${result.jobId}`);
              printInfo('查看进度: train status ' + result.jobId);
            }
          } catch (err) { printError(err.message); }

        } else if (subCommand === 'distill') {
          printInfo('知识蒸馏: 从大模型生成训练数据，训练小模型');
          const studentBase = options.student || options.base || 'qwen-1.5b';
          // Use recorded conversation prompts
          const stats = training.getDatasetStats();
          if (stats.total < 5) {
            printWarn('需要更多交互数据用于蒸馏。请先积累对话记录');
            return true;
          }
          printInfo(`学生模型: ${studentBase}, 使用已记录的对话作为蒸馏素材`);
          printInfo('蒸馏过程较长，请耐心等待...');
          // Extract prompts from saved interactions for distillation
          printInfo('功能就绪，需要 Python 环境支持。详见: compute');

        } else if (subCommand === 'export') {
          const modelName = args[0];
          if (!modelName) { printError('用法: train export <模型名> [--format gguf|safetensors]'); return true; }
          const format = options.format || 'gguf';

          // Model export is no longer password-gated — proceed directly.
          const password = options.password || options.pwd || '';

          printInfo(`导出模型 ${modelName} → ${format}...`);
          try {
            if (format === 'gguf') {
              const quant = options.quant || 'q4_k_m';
              const result = await training.exportGGUF(modelName, quant, password);
              if (result.success) {
                printSuccess(`GGUF 导出完成: ${result.ggufPath}`);
                printInfo('注册到 Ollama: ollama create ' + modelName + ' -f Modelfile');
                const reg = await training.registerWithOllama(modelName, result.ggufPath);
                if (reg.success) printSuccess(reg.message);
              } else {
                printError('导出失败: ' + (result.error || '').slice(0, 200));
              }
            } else {
              const result = await training.exportSafetensors(modelName, password);
              if (result.success) {
                printSuccess(`Safetensors 导出完成: ${result.safetensorsPath}`);
                printInfo('可上传 HuggingFace: huggingface-cli upload ' + modelName + ' ' + result.safetensorsPath);
              } else {
                printError('导出失败: ' + (result.error || '').slice(0, 200));
              }
            }
          } catch (err) { printError(err.message); }

        } else if (subCommand === 'export-data') {
          const format = options.format || 'alpaca';
          try {
            const result = training.exportDataset(format);
            printSuccess(`数据集导出: ${result.count} 条 → ${result.path}`);
          } catch (err) { printError(err.message); }

        } else if (subCommand === 'upload') {
          const modelName = args[0];
          if (!modelName) { printError('用法: train upload <模型名> --platform github|gitee --repo <仓库名> [--token xxx]'); return true; }
          const platform = options.platform || options.p || 'github';
          const repo = options.repo || options.r || modelName;
          const token = options.token || process.env.GITHUB_TOKEN || process.env.GITEE_TOKEN || '';

          // Model upload is no longer password-gated — proceed directly.
          const password = options.password || options.pwd || '';

          printInfo(`上传模型 ${modelName} → ${platform}/${repo}...`);
          try {
            const result = await training.uploadToGitRepo(modelName, { platform, repo, token, password, owner: options.owner });
            if (result.success) {
              printSuccess(result.message);
              printInfo(`仓库地址: ${result.url}`);
            } else {
              printError('上传失败: ' + result.message);
            }
          } catch (err) { printError(err.message); }
        }
        return true;
      }

      case 'admin': {
        // Hidden admin command — requires password
        const adminSvc = require('../services/adminService');
        let password = options.password || options.pwd || args[0] || '';

        if (!password) {
          const readline = require('readline');
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          password = await new Promise(resolve => {
            rl.question(chalk.yellow('  🔐 管理密码: '), ans => { rl.close(); resolve(ans.trim()); });
          });
        }

        if (!adminSvc.verifyAdminPassword(password)) {
          printError('密码错误');
          return true;
        }

        if (!subCommand || subCommand === 'stats') {
          const result = adminSvc.getAdminStats(password);
          if (result.success) {
            console.log(chalk.bold('\n  🔧 管理面板\n'));
            const s = result.stats;
            console.log(chalk.dim('  设备哈希: ') + chalk.white(s.usageData.deviceHash));
            console.log(chalk.dim('  交互总数: ') + chalk.white(s.usageData.interactionCount || 0));
            console.log(chalk.dim('  安全事件: ') + chalk.white(s.securityEvents || 0));
            if (s.tokenUsage) {
              console.log(chalk.dim('  Token总量: ') + chalk.white(s.tokenUsage.totalTokens.toLocaleString()));
              const costCNY = s.tokenUsage.totalCost * 7.25;
              const costNum = require('./ccFormat').ccFormatCostOr(costCNY, costCNY.toFixed(4), process.env);
              console.log(chalk.dim('  总费用: ') + chalk.white(`￥${costNum}`));
            }
            if (s.models) {
              const modelCount = Object.keys(s.models).length;
              console.log(chalk.dim('  训练模型数: ') + chalk.white(modelCount));
            }
            console.log('');
          }

        } else if (subCommand === 'export-data') {
          const result = adminSvc.exportTrainingData(password, { output: options.output, since: options.since });
          if (result.success) {
            printSuccess(`训练数据导出: ${result.count} 条 → ${result.path}`);
          } else {
            printError(result.error);
          }

        } else if (subCommand === 'export-growth') {
          const result = adminSvc.exportGrowthData(password);
          if (result.success) {
            printSuccess(`成长数据导出: ${result.path}`);
          } else {
            printError(result.error);
          }

        } else if (subCommand === 'sync') {
          printInfo('同步遥测数据...');
          const result = await adminSvc.syncTelemetry();
          if (result.synced) {
            printSuccess(`同步完成 (status: ${result.status})`);
          } else {
            printWarn(`同步失败: ${result.reason}`);
          }
        }
        return true;
      }

      case 'growth': {
        const growthSvc = require('../services/growthService');

        if (!subCommand) {
          // Show growth summary
          const summary = growthSvc.getGrowthSummary();
          const { getLevelProgress } = require('../services/knowledgeTeachingService');
          const level = getLevelProgress();

          console.log(chalk.bold('\n  🌱 成长档案\n'));
          console.log(chalk.dim('  知识等级: ') + chalk.cyan(`${level.levelName} (${level.xp} XP)`) + chalk.dim(level.xpToNext > 0 ? ` → 下一级还需 ${level.xpToNext} XP` : ' (已满级)'));
          console.log(chalk.dim('  已学话题: ') + chalk.white(`${level.completedTopics} / ${level.totalTopics}`));
          console.log(chalk.dim('  总交互数: ') + chalk.white(summary.totalInteractions.toLocaleString()));
          console.log(chalk.dim('  策略记录: ') + chalk.white(summary.strategyRecords));
          console.log(chalk.dim('  Agent均准确率: ') + chalk.white(`${summary.avgAgentAccuracy}%`));
          if (summary.topSymbols.length > 0) {
            console.log(chalk.dim('  常用标的: ') + chalk.white(summary.topSymbols.join(', ')));
          }
          console.log(chalk.dim('  快照数: ') + chalk.white(summary.snapshots));
          console.log(chalk.dim('  上次更新: ') + chalk.white(summary.lastModified || '—'));
          console.log(chalk.dim('\n  命令:'));
          console.log(chalk.dim('    growth export [--path ./backup.tar.gz]  导出成长档案'));
          console.log(chalk.dim('    growth import <文件>                    导入合并'));
          console.log(chalk.dim('    growth snapshot                         创建快照'));
          console.log(chalk.dim('    growth snapshots                        查看快照列表'));
          console.log(chalk.dim('    growth restore <快照ID>                 恢复到快照'));
          console.log(chalk.dim('    growth reset                            重置 (不可逆)'));
          console.log('');

        } else if (subCommand === 'export') {
          const outputPath = options.path || args[0] || null;
          const exported = growthSvc.exportGrowth(outputPath);
          printSuccess(`成长档案已导出: ${exported}`);
          printInfo('复制此文件到另一台机器，使用 growth import 导入即可迁移成长数据');

        } else if (subCommand === 'import') {
          const file = args[0];
          if (!file) { printError('用法: growth import <归档文件路径>'); return true; }
          try {
            const result = growthSvc.importGrowth(file);
            printSuccess(`导入成功: 来自 ${result.importedFrom}, 合并了 ${result.filesImported} 个文件`);
            printInfo(`原始导出时间: ${result.exportedAt}`);
          } catch (err) { printError(err.message); }

        } else if (subCommand === 'snapshot') {
          const snap = growthSvc.createSnapshot();
          printSuccess(`快照已创建: ${snap.snapshotId}`);

        } else if (subCommand === 'snapshots') {
          const snaps = growthSvc.listSnapshots();
          if (snaps.length === 0) {
            printInfo('暂无快照。使用 growth snapshot 创建');
          } else {
            console.log(chalk.bold('\n  📸 成长快照\n'));
            snaps.forEach(s => {
              console.log(chalk.dim('  ') + chalk.cyan(s.id) + chalk.dim(` (${_ccFileSize(s.size, `${(s.size / 1024).toFixed(1)} KB`)})`));
            });
            console.log('');
          }

        } else if (subCommand === 'restore') {
          const snapId = args[0];
          if (!snapId) { printError('用法: growth restore <快照ID>'); return true; }
          try {
            const result = growthSvc.restoreSnapshot(snapId);
            printSuccess(`已恢复到快照: ${result.restored} (${result.files} 个文件)`);
          } catch (err) { printError(err.message); }

        } else if (subCommand === 'reset') {
          printWarn('⚠ 这将清除所有成长数据（不可逆）');
          const readline = require('readline');
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const confirm = await new Promise(resolve => {
            rl.question(chalk.yellow('  确认重置？输入 YES: '), ans => { rl.close(); resolve(ans.trim()); });
          });
          if (confirm === 'YES') {
            growthSvc.resetGrowth();
            printSuccess('成长数据已重置');
          } else {
            printInfo('已取消');
          }
        }
        return true;
      }

      case 'agent': {
        // 注意:量化交易相关的 agent 协作子命令(status/task/memory/collaborate)属于 khyquant
        // 应用,已从 khyos 底座 CLI 移除。此处仅保留 OS 原生代理运行器(list/templates/run/spawn)。
        if (subCommand === 'list' || subCommand === 'templates') {
          const agentRunner = require('../services/cliAgentRunner');
          const templates = agentRunner.listAgentTemplates();
          console.log(chalk.bold('\n  🤖 Agent Templates\n'));
          printTable(
            ['Role Key', 'Name', 'Tool Profile', 'Keywords'],
            templates.map(t => [t.key, t.name, t.toolProfile, String(t.keywordCount)])
          );
          console.log('');
          printInfo('Claude-compatible roles: general-purpose, Explore, Plan, verification, claude-code-guide');
          printInfo('Run one directly: agent run "<task>" --role Explore');
          printInfo('Spawn shortcut: agent spawn "<task>" --role codex|claude [--model <modelId>]');

        } else if (subCommand === 'run' || subCommand === 'spawn') {
          const prompt = args.join(' ');
          if (!prompt) {
            printError('Usage: agent run|spawn "<task>" [--role Explore|Plan|general-purpose|codex|claude] [--adapter codex|claude] [--model <modelId>]');
            return true;
          }

          const agentRunner = require('../services/cliAgentRunner');
          const roleInput = options.role || options.agent || options.type || 'general-purpose';
          const resolvedRole = agentRunner.resolveRoleKey(roleInput);
          const roleMeta = agentRunner.AGENT_ROLES[resolvedRole] || agentRunner.AGENT_ROLES.general;
          const preferredAdapter = String(options.adapter || options.provider || '').trim().toLowerCase();
          const preferredModel = String(options.model || '').trim();
          printInfo(`Running agent: ${roleMeta?.name || resolvedRole} (${resolvedRole})`);
          if (preferredAdapter) printInfo(`Preferred adapter: ${preferredAdapter}`);
          if (preferredModel) printInfo(`Preferred model: ${preferredModel}`);

          const aiModule = require('./ai');
          const states = await agentRunner.runAgents(
            [{ role: resolvedRole, name: roleMeta?.name || resolvedRole, task: prompt }],
            {
              ai: aiModule,
              preferredAdapter: preferredAdapter || undefined,
              preferredModel: preferredModel || undefined,
              onProgress: (agentStates) => {
                try {
                  const renderer = require('./aiRenderer');
                  renderer.renderAgentProgress(agentStates);
                } catch { /* best effort */ }
              },
            }
          );

          const first = states[0];
          if (!first || first.status !== 'completed') {
            printError(first?.detail || 'Agent run failed');
            return true;
          }
          // 时长走 agentDurationLabelOr SSOT(cli/agentStatLine,门控 KHY_CC_FORMAT),
          // 与同一 agent 的树视图 / renderer(ccFormatDuration 带 h/m/s 进位)一致:
          // 门控开 → 125.3s 显 "2m 5s"(树同款)、3.4s 显 "3s";门控关 → 逐字节回退
          // 原 `${(elapsed/1000).toFixed(1)}s`。此前本行裸 toFixed(1) 是绕过 SSOT 的孤儿,
          // 长 agent 在此显 "125.3s" 而树显 "2m 5s"(同一 agent 两种时长格式)。
          const _agentDur = require('./agentStatLine').agentDurationLabelOr(
            first.elapsed, `${(first.elapsed / 1000).toFixed(1)}s`, process.env,
          );
          printSuccess(`Agent completed in ${_agentDur}`);
          console.log('');
          console.log(first.result || '');
          console.log('');

        } else {
          printInfo('用法: agent run|spawn "<task>" [--role Explore|Plan|general-purpose|codex|claude] [--model <id>]');
          printInfo('     agent list                                   查看可用角色模板');
          printInfo('查看全部可用代理类型请用: /agents');
        }
        return true;
      }

      case 'prompt': {
        const promptLib = require('../services/promptLibraryService');

        if (!subCommand || subCommand === 'list') {
          const folder = args[0] || null;
          const prompts = promptLib.listPrompts(folder);
          if (prompts.length === 0) {
            printInfo('暂无保存的提示词。使用 prompt save "标题" "内容" 保存');
          } else {
            console.log(chalk.bold('\n  📝 提示词库\n'));
            prompts.forEach(p => {
              const used = p.usedCount > 0 ? chalk.dim(` (使用 ${p.usedCount} 次)`) : '';
              console.log(chalk.cyan(`  [${p.id}]`) + ` ${p.title}` + used + chalk.dim(` · ${p.folder}`));
            });
            console.log(chalk.dim(`\n  共 ${prompts.length} 条 · 目录: ${promptLib.getPromptDir()}`));
            console.log('');
          }

        } else if (subCommand === 'save') {
          const title = args[0];
          const content = args.slice(1).join(' ') || options.content;
          if (!title || !content) {
            printError('用法: prompt save "标题" "提示词内容" [--folder 分类] [--tags tag1,tag2]');
            return true;
          }
          const tags = options.tags ? options.tags.split(',') : [];
          const folder = options.folder || options.f || null;
          const result = promptLib.savePrompt({ title, content, tags }, folder);
          printSuccess(`提示词已保存: ${result.title} [${result.id}]`);
          printInfo(`路径: ${result.path}`);

        } else if (subCommand === 'use') {
          const id = args[0];
          if (!id) { printError('用法: prompt use <ID>'); return true; }
          const content = promptLib.usePrompt(id);
          if (content) {
            // Forward to AI
            return { aiForward: content };
          } else {
            printError(`未找到提示词: ${id}`);
          }

        } else if (subCommand === 'delete') {
          const id = args[0];
          if (!id) { printError('用法: prompt delete <ID>'); return true; }
          if (promptLib.deletePrompt(id)) {
            printSuccess('已删除');
          } else {
            printError(`未找到: ${id}`);
          }

        } else if (subCommand === 'search') {
          const keyword = args.join(' ');
          if (!keyword) { printError('用法: prompt search <关键词>'); return true; }
          const results = promptLib.searchPrompts(keyword);
          if (results.length === 0) {
            printInfo(`未找到匹配 "${keyword}" 的提示词`);
          } else {
            results.forEach(p => {
              console.log(chalk.cyan(`  [${p.id}]`) + ` ${p.title}` + chalk.dim(` · ${p.folder}`));
            });
          }

        } else if (subCommand === 'folder') {
          const action = args[0];
          if (action === 'new' || action === 'create') {
            const name = args[1];
            if (!name) { printError('用法: prompt folder new <名称>'); return true; }
            const result = promptLib.createFolder(name);
            if (result.success) printSuccess(`文件夹已创建: ${result.path}`);
            else printError(result.error);
          } else {
            const folders = promptLib.listFolders();
            console.log(chalk.bold('\n  📂 提示词文件夹\n'));
            folders.forEach(f => console.log(chalk.dim('  ') + chalk.cyan(f)));
            console.log('');
          }

        } else if (subCommand === 'dir') {
          const newDir = args[0];
          if (newDir) {
            if (promptLib.setPromptDir(newDir)) {
              printSuccess(`提示词目录已设置: ${newDir}`);
            } else {
              printError('目录设置失败');
            }
          } else {
            printInfo(`当前提示词目录: ${promptLib.getPromptDir()}`);
            printInfo('设置新目录: prompt dir /path/to/your/folder');
          }
        } else if (subCommand === 'compose' || subCommand === 'write' || subCommand === 'edit') {
          // /prompt 编辑器长提示词撰写(移植自 Hermes v0.18.0 /prompt):在 $EDITOR 里从容写多行
          // 提示词,存回后剥掉 #! 指引行并原样转发给 AI。门 KHY_PROMPT_COMPOSE(默认开)。
          const composer = require('../services/promptComposerService');
          const initialText = args.join(' ');
          printInfo('正在打开编辑器撰写提示词…(保存并关闭后发送)');
          const result = composer.composeInEditor({ initialText });
          if (result.ok && result.text) {
            return { aiForward: result.text };
          }
          if (result.reason === 'disabled') {
            printInfo('提示词撰写已禁用(KHY_PROMPT_COMPOSE=0)。可用 prompt save/use 管理提示词库');
          } else if (result.reason === 'empty') {
            printInfo('空提示词 — 未发送');
          } else if (result.reason === 'editor-failed') {
            printError(`打开编辑器失败:${result.detail || result.editor || ''}。可设置 $EDITOR 后重试`);
          } else {
            printError(`撰写失败:${result.detail || '未知错误'}`);
          }
        }
        return true;
      }

      case 'voice': {
        // Voice control placeholder — future integration with Windows Win+H
        console.log(chalk.bold('\n  🎤 语音控制 (预览)\n'));
        printInfo('语音控制功能正在开发中...');
        console.log('');
        console.log(chalk.dim('  计划支持:'));
        console.log(chalk.dim('  • Windows Win+H 语音输入集成'));
        console.log(chalk.dim('  • 语音命令识别 → 自动执行'));
        console.log(chalk.dim('  • 语音播报分析结果'));
        console.log(chalk.dim('  • 免手操作量化交易'));
        console.log('');
        console.log(chalk.dim('  当前可用: 使用系统语音输入 (Win+H) 直接在命令行输入'));
        console.log(chalk.dim('  提示: Win+H 的语音文字会自动输入到当前终端光标位置'));
        console.log('');
        return true;
      }

      case 'knowledge': {
        const kts = require('../services/knowledgeTeachingService');

        if (subCommand === 'search') {
          const query = args.join(' ');
          if (!query) { printError('请输入搜索关键词'); return true; }
          const results = kts.searchKnowledge(query);
          if (results.length === 0) {
            printInfo(`未找到与 "${query}" 相关的知识`);
          } else {
            console.log(chalk.bold(`\n  📚 知识库搜索: "${query}" (${results.length} 条)\n`));
            for (const r of results.slice(0, 10)) {
              const src = r.source === 'builtin' ? chalk.green('内置') : r.source === 'community' ? chalk.blue('社区') : chalk.cyan('学习');
              console.log(`  ${src} ${chalk.white(r.title)} [${r.category}]`);
              console.log(`  ${chalk.dim(r.content.slice(0, 100))}${r.content.length > 100 ? '...' : ''}`);
              console.log('');
            }
          }
          return true;
        }

        if (subCommand === 'stats') {
          const stats = kts.getKnowledgeStats();
          console.log(chalk.bold('\n  📊 知识库统计\n'));
          console.log(`  内置知识:    ${chalk.bold(stats.builtinCount)} 条`);
          console.log(`  学习积累:    ${chalk.bold(stats.learnedCount)} 条`);
          console.log(`  总计:        ${chalk.bold(stats.totalCount)} 条`);
          if (Object.keys(stats.learnedCategories).length > 0) {
            console.log(chalk.dim('\n  学习知识分类:'));
            for (const [cat, count] of Object.entries(stats.learnedCategories)) {
              console.log(`    ${cat}: ${count}`);
            }
          }
          console.log('');
          return true;
        }

        if (subCommand === 'self') {
          const aiCli = require('./ai');
          const studyMode = !!(aiCli.isStudyMode && aiCli.isStudyMode());
          let runtimeAdapter = null;
          let runtimeModel = null;
          try {
            const gw = require('../services/gateway/aiGateway');
            const active = gw.getActiveAdapter?.();
            runtimeAdapter = active?.name || null;
            runtimeModel = active?.activeModel || active?.name || null;
          } catch { /* best effort */ }

          const profile = kts.getSelfAwarenessProfile({
            studyMode,
            adapter: runtimeAdapter,
            model: runtimeModel,
            effort: aiCli.getEffort ? aiCli.getEffort() : null,
          });
          const lines = kts.formatSelfAwarenessProfile(profile);

          console.log('');
          for (const line of lines) {
            console.log(`  ${line}`);
          }
          console.log('');
          printInfo('建议: 开启学习模式后提问，系统会按“能力边界→学习路径→练习检查点”方式回答');
          return true;
        }

        if (subCommand === 'sync') {
          const syncAction = args[0];

          if (syncAction === 'config') {
            const repo = args[1];
            if (!repo) {
              printError('请指定仓库地址');
              printInfo('用法: knowledge sync config <owner/repo> [--platform github|gitee|gitlab] [--token <PAT>]');
              return true;
            }
            const result = kts.configureKBSync({
              repo,
              platform: options.platform || null,
              token: options.token || null,
              isPublic: !options.private,
            });
            printSuccess(`知识库同步已配置: ${result.platform}/${result.repo}`);
            printInfo(`类型: ${result.isPublic ? '公共贡献' : '私人备份'} | 自动同步: ${result.autoSync ? '开' : '关'}`);
            return true;
          }

          if (syncAction === 'push') {
            const result = kts.syncKBToGitHub();
            if (result.success) {
              printSuccess(`知识库已同步到 ${result.platform || 'github'}/${result.repo || ''}`);
              printInfo(`文件: ${result.filename}`);
            } else {
              printError(result.error);
              if (result.hint) printInfo(result.hint);
            }
            return true;
          }

          if (syncAction === 'pull') {
            const repo = args[1] || null;
            const platform = options.platform || null;
            const result = kts.pullCommunityKnowledge(repo, platform);
            if (result.success) {
              printSuccess(`已从社区拉取 ${result.merged} 条新知识 (来自 ${result.contributors} 个贡献者)`);
              printInfo(`本地知识库现有 ${result.totalNow} 条`);
            } else {
              printError(result.error);
            }
            return true;
          }

          if (syncAction === 'status') {
            const config = kts.getKBSyncConfig();
            if (!config) {
              printInfo('未配置知识库同步');
              printInfo('使用: knowledge sync config <repo> 配置');
            } else {
              console.log(chalk.bold('\n  🔄 知识库同步状态\n'));
              console.log(`  平台:      ${config.platform}`);
              console.log(`  仓库:      ${config.repo}`);
              console.log(`  类型:      ${config.isPublic ? '公共贡献' : '私人备份'}`);
              console.log(`  自动同步:  ${config.autoSync ? '开' : '关'} (每 ${config.syncThreshold} 条)`);
              console.log(`  上次同步:  ${config.lastSync || '从未'}`);
              console.log('');
            }
            return true;
          }

          // Default sync help
          console.log(chalk.bold('\n  🔄 知识库同步\n'));
          console.log(chalk.dim('  支持平台: GitHub, Gitee, GitLab\n'));
          console.log('  knowledge sync config <repo>  — 配置同步仓库');
          console.log('  knowledge sync push           — 推送知识到远端');
          console.log('  knowledge sync pull [repo]    — 拉取社区知识');
          console.log('  knowledge sync status         — 查看同步状态');
          console.log(chalk.dim('\n  选项: --platform gitee|gitlab  --token <PAT>  --private'));
          console.log('');
          return true;
        }

        // Default: show knowledge overview
        const progress = kts.getLevelProgress();
        const stats = kts.getKnowledgeStats();
        console.log(chalk.bold('\n  📚 量化知识库\n'));
        console.log(`  等级:     ${chalk.bold(progress.levelName)} (XP: ${progress.xp})`);
        console.log(`  进度:     ${progress.progress}% → 下一级还需 ${progress.xpToNext} XP`);
        console.log(`  内置知识: ${stats.builtinCount} 条`);
        console.log(`  学习积累: ${stats.learnedCount} 条`);
        console.log(`  已完成:   ${progress.completedTopics}/${progress.totalTopics} 个话题`);
        console.log('');
        printInfo('命令: knowledge self | knowledge search <关键词> | knowledge stats | knowledge sync');
        console.log('');
        return true;
      }

      case 'security': {
        const secSvc = require('../services/securityGuardService');

        if (subCommand === 'scan') {
          console.log(chalk.bold('\n  🛡️ 安全扫描...\n'));
          const result = secSvc.scanForThreats();
          if (result.clean) {
            printSuccess('扫描完成 — 未发现威胁');
          } else {
            printError(`发现 ${result.threats.length} 个威胁!`);
            for (const t of result.threats) {
              const icon = t.severity === 'critical' ? '🔴' : t.severity === 'high' ? '🟠' : '🟡';
              console.log(`  ${icon} [${t.severity}] ${t.detail}`);
              if (t.action) console.log(chalk.dim(`     修复: ${t.action}`));
            }
          }
          if (result.recommendations.length > 0) {
            console.log(chalk.bold('\n  📋 安全建议'));
            for (const r of result.recommendations) {
              console.log(chalk.dim(`  • ${r.detail}`));
            }
          }
          console.log('');
          return true;
        }

        if (subCommand === 'monitor') {
          secSvc.startSecurityMonitor();
          printSuccess('后台安全监控已启动 (每 10 分钟扫描一次)');
          printInfo('异常事件记录到 ~/.khyquant/security.log');
          return true;
        }

        if (subCommand === 'integrity') {
          const result = secSvc.checkProcessIntegrity();
          console.log(chalk.bold('\n  🔍 进程完整性检查\n'));
          console.log(`  当前 PID:     ${result.pid}`);
          console.log(`  子进程数:     ${result.childCount}`);
          console.log(`  可疑进程:     ${result.suspicious.length}`);
          if (result.clean) {
            printSuccess('进程完整性正常');
          } else {
            printError('发现可疑子进程:');
            for (const s of result.suspicious) {
              console.log(`    PID ${s.pid}: ${s.cmd}`);
            }
          }
          console.log('');
          return true;
        }

        if (subCommand === 'status') {
          const stats = secSvc.getSecurityStats();
          console.log(chalk.bold('\n  🛡️ 安全状态\n'));
          console.log(`  总拦截事件: ${stats.totalEvents}`);
          console.log(`  24h 内:     ${stats.last24h}`);
          if (stats.byType && Object.keys(stats.byType).length > 0) {
            console.log(chalk.dim('\n  按类型:'));
            for (const [type, count] of Object.entries(stats.byType)) {
              console.log(`    ${type}: ${count}`);
            }
          }
          // Show permission profile
          try {
            const permStore = require('../services/permissionStore');
            console.log(`\n  权限模式:   ${chalk.cyan(permStore.getProfile())}`);
            console.log(`  已授权工具: ${permStore.getApprovedTools().length}`);
            console.log(`  已拒绝工具: ${permStore.getDeniedTools().length}`);
          } catch { /* permissionStore not available */ }
          console.log('');
          return true;
        }

        if (subCommand === 'profile') {
          const permStore = require('../services/permissionStore');
          const profileName = args[0];
          if (profileName) {
            try {
              permStore.setProfile(profileName);
              // Also sync dangerous mode with yolo profile
              const toolCalling = require('../services/toolCalling');
              if (profileName === 'yolo') {
                toolCalling.enableDangerousMode();
                toolCalling.acknowledgeDangerousMode();
              } else {
                toolCalling.disableDangerousMode();
              }
              printSuccess(`权限模式已设置为: ${profileName}`);
              const desc = { strict: '所有工具需确认', normal: '安全工具自动放行', acceptEdits: '自动放行文件编辑，shell/危险操作仍需确认', yolo: '全部自动放行' };
              printInfo(desc[profileName] || '');
            } catch (err) {
              printError(err.message);
            }
          } else {
            const current = permStore.getProfile();
            console.log(chalk.bold('\n  🔒 权限模式\n'));
            for (const p of permStore.VALID_PROFILES) {
              const marker = p === current ? chalk.green(' ← 当前') : '';
              const desc = { strict: '所有工具需确认 (最安全)', normal: '安全工具自动放行 (默认)', acceptEdits: '自动放行文件编辑，shell/危险仍确认', yolo: '全部自动放行 (等同 --dangerous)' };
              console.log(`  ${p === current ? chalk.green('●') : chalk.dim('○')} ${chalk.bold(p)}  ${chalk.dim(desc[p])}${marker}`);
            }
            console.log(chalk.dim('\n  用法: security profile <strict|normal|acceptEdits|yolo>\n'));
          }
          return true;
        }

        if (subCommand === 'audit') {
          const auditLog = require('../services/auditLog');
          const toolFilter = options.tool || null;
          const limit = parseInt(options.limit) || 20;
          const entries = auditLog.queryAuditLog({ tool: toolFilter, limit });

          console.log(chalk.bold('\n  📋 工具执行审计日志\n'));
          if (entries.length === 0) {
            printInfo('暂无审计记录');
          } else {
            for (const e of entries) {
              const icon = e.result?.success ? chalk.green('✓') : chalk.red('✗');
              const time = new Date(e.timestamp).toLocaleString('zh-CN');
              const elapsed = e.elapsed ? chalk.dim(`${e.elapsed}ms`) : '';
              console.log(`  ${icon} ${chalk.dim(time)} ${chalk.cyan(e.tool)} ${elapsed} ${chalk.dim(`[${e.permission}]`)}`);
            }
            // Show stats summary
            const stats = auditLog.getAuditStats();
            console.log(chalk.dim(`\n  总计 ${stats.totalCalls} 次调用 · ${stats.errorCount} 次失败 · ${stats.deniedCount} 次拒绝 · 平均 ${stats.avgElapsed}ms`));
          }
          console.log('');
          return true;
        }

        if (subCommand === 'permissions') {
          const permStore = require('../services/permissionStore');
          const rules = permStore.getAllRules();
          console.log(chalk.bold('\n  🔑 权限规则\n'));
          console.log(`  当前模式: ${chalk.cyan(rules.profile)}`);

          const persistent = Object.entries(rules.persistent);
          if (persistent.length > 0) {
            console.log(chalk.bold('\n  持久规则:'));
            for (const [name, rule] of persistent) {
              const icon = rule.decision === 'allow' ? chalk.green('✓') : chalk.red('✗');
              console.log(`  ${icon} ${name} — ${rule.decision} (${rule.scope})${rule.migrated ? chalk.dim(' [已迁移]') : ''}`);
            }
          }
          if (rules.sessionApproved.length > 0) {
            console.log(chalk.bold('\n  会话授权:'));
            for (const name of rules.sessionApproved) {
              console.log(`  ${chalk.green('✓')} ${name}`);
            }
          }
          if (rules.sessionDenied.length > 0) {
            console.log(chalk.bold('\n  会话拒绝:'));
            for (const name of rules.sessionDenied) {
              console.log(`  ${chalk.red('✗')} ${name}`);
            }
          }
          if (persistent.length === 0 && rules.sessionApproved.length === 0 && rules.sessionDenied.length === 0) {
            printInfo('暂无自定义规则，使用默认模式');
          }
          console.log('');
          return true;
        }

        // Default: quick scan
        console.log(chalk.bold('\n  🛡️ 安全防护\n'));
        console.log('  security scan          — 完整安全扫描 (挖矿/木马/可疑进程)');
        console.log('  security monitor       — 启动后台监控 (每10分钟自动扫描)');
        console.log('  security integrity     — 进程完整性检查');
        console.log('  security status        — 查看拦截统计');
        console.log('  security profile <p>   — 设置权限模式 (strict/normal/yolo)');
        console.log('  security audit         — 查看工具执行审计日志');
        console.log('  security permissions   — 查看当前权限规则');
        console.log('');
        // Run quick integrity check
        const integrity = secSvc.checkProcessIntegrity();
        if (integrity.clean) {
          printSuccess('快速检查: 进程完整性正常');
        } else {
          printError(`快速检查: 发现 ${integrity.suspicious.length} 个可疑进程`);
        }
        console.log('');
        return true;
      }

      case 'monitor': {
        const aiMonitor = require('../services/aiMonitor');
        if (subCommand === 'selfcheck') {
          const selfCheck = require('../services/baseSelfCheckService');
          // Eagerly load the plugin-dev handler so it self-registers the
          // plugin doctor on the neutral pluginDoctorPort (DESIGN-ARCH-021).
          // Without this the self-check finds no doctor and degrades the
          // plugin QA sub-check to "unavailable". cli→cli keeps arch direction.
          try {
            require('./handlers/plugin-dev');
          } catch {
            // plugin-dev optional; doctor sub-check degrades gracefully if absent.
          }
          const action = (args[0] || 'status').toLowerCase();

          const colorSeverity = (severity) => {
            if (severity === 'critical') return chalk.red(severity);
            if (severity === 'degraded') return chalk.yellow(severity);
            return chalk.green(severity || 'healthy');
          };

          if (action === 'start') {
            const intervalMs = parseInt(
              options.interval || args[1] || process.env.KHY_SELF_CHECK_INTERVAL_MS || '300000',
              10
            );
            const st = selfCheck.start(intervalMs, { runImmediately: true });
            printSuccess(`循环自检已启动，间隔 ${st.intervalMs}ms`);
            if (st.lastResult) {
              printInfo(`最近结果: ${st.lastResult.severity} · score ${st.lastResult.score}`);
            }
            return true;
          }

          if (action === 'stop') {
            const st = selfCheck.stop();
            printSuccess('循环自检已停止');
            if (st.lastResult) {
              printInfo(`最后一次: ${st.lastResult.severity} · score ${st.lastResult.score}`);
            }
            return true;
          }

          if (action === 'run') {
            printInfo('执行一次底座自检...');
            const report = await selfCheck.runOnce({
              trigger: 'manual',
              forceThreatScan: true,
              forcePluginDoctor: true,
              pluginDoctorDeep: options.deep === true || options.deep === 'true',
            });

            if (report.skipped) {
              printWarn('已有自检任务在运行，跳过本次触发');
              return true;
            }

            console.log(chalk.bold('\n  🔁 自检结果\n'));
            console.log(`  严重级别: ${colorSeverity(report.severity)}`);
            console.log(`  评分:     ${report.score}/100`);
            console.log(`  耗时:     ${report.durationMs}ms`);
            console.log(`  问题数:   ${report.issues.length}`);
            const repairCount = Array.isArray(report.repairs) ? report.repairs.length : 0;
            console.log(`  修复数:   ${repairCount}`);
            if (report.issues.length > 0) {
              console.log(chalk.bold('\n  Top Issues:'));
              for (const issue of report.issues.slice(0, 8)) {
                const icon = issue.severity === 'critical'
                  ? chalk.red('✗')
                  : issue.severity === 'high'
                    ? chalk.yellow('!')
                    : chalk.dim('•');
                console.log(`  ${icon} [${issue.source}] ${issue.message}`);
              }
            }
            if (repairCount > 0) {
              console.log(chalk.bold('\n  Auto Repairs:'));
              for (const repair of report.repairs.slice(0, 8)) {
                const from = repair.from ? ` ${repair.from}` : '';
                const to = repair.to ? ` -> ${repair.to}` : '';
                const action = repair.action ? `[${repair.action}]` : '[repair]';
                console.log(`  ${chalk.green('✓')} ${action}${from}${to}`);
              }
            }
            console.log('');
            return true;
          }

          if (action === 'tail') {
            const n = Math.max(1, parseInt(options.n || args[1] || '10', 10) || 10);
            const logs = selfCheck.tail(n);
            if (logs.length === 0) {
              printInfo('暂无自检日志');
              return true;
            }
            console.log(chalk.bold(`\n  🔁 最近 ${logs.length} 条自检记录\n`));
            for (const row of logs) {
              const time = row.timestamp ? new Date(row.timestamp).toLocaleString('zh-CN') : '-';
              const sev = colorSeverity(row.severity || 'unknown');
              const score = Number.isFinite(row.score) ? row.score : '-';
              const issueCount = Number.isFinite(row.issueCount) ? row.issueCount : 0;
              const repairCount = Number.isFinite(row.repairCount) ? row.repairCount : 0;
              const dur = Number.isFinite(row.durationMs) ? `${row.durationMs}ms` : '-';
              console.log(`  ${time}  ${sev}  score=${score}  issues=${issueCount}  repairs=${repairCount}  ${dur}`);
            }
            console.log('');
            return true;
          }

          // status (default)
          const st = selfCheck.status();
          console.log(chalk.bold('\n  🔁 底座循环自检\n'));
          console.log(`  运行状态: ${st.running ? chalk.green('running') : chalk.yellow('stopped')}`);
          console.log(`  间隔:     ${st.intervalMs}ms`);
          console.log(`  运行次数: ${st.runCount}`);
          if (st.startedAt) {
            console.log(`  启动时间: ${new Date(st.startedAt).toLocaleString('zh-CN')}`);
          }
          if (st.lastResult) {
            console.log(`  最近级别: ${colorSeverity(st.lastResult.severity)} · score ${st.lastResult.score}`);
            console.log(`  最近时间: ${new Date(st.lastResult.timestamp).toLocaleString('zh-CN')}`);
            console.log(`  最近耗时: ${st.lastResult.durationMs}ms`);
            console.log(`  问题数量: ${st.lastResult.issueCount}`);
            console.log(`  修复数量: ${Number.isFinite(st.lastResult.repairCount) ? st.lastResult.repairCount : 0}`);
          } else {
            console.log(`  最近结果: ${chalk.dim('暂无')}`);
          }
          console.log(`  日志文件: ${st.logFile}`);
          console.log(chalk.dim('\n  用法: monitor selfcheck start|stop|status|run|tail [--interval ms] [--n N] [--deep]\n'));
          return true;
        }

        if (subCommand === 'dashboard') {
          // Unified telemetry dashboard
          const telemetry = require('../services/telemetryService');
          const dashboard = telemetry.createDashboardData();
          console.log(chalk.bold('\n  📊 统一监控仪表盘\n'));
          console.log(`  运行时间:     ${dashboard.summary.uptime}`);
          console.log(`  工具调用:     ${dashboard.counters.tools} (${dashboard.summary.toolCallsPerMinute}/min)`);
          console.log(`  成功率:       ${dashboard.summary.successRate}`);
          console.log(`  平均延迟:     ${dashboard.summary.avgLatency}`);
          console.log(`  智能体运行:   ${dashboard.counters.agents}`);
          console.log(`  服务调用:     ${dashboard.counters.services}`);
          console.log(`  错误数:       ${chalk.red(dashboard.counters.errors)}`);
          console.log(`  内存占用:     ${dashboard.summary.memoryUsed}`);
          if (dashboard.topTools.length > 0) {
            console.log(chalk.bold('\n  热门工具:'));
            for (const t of dashboard.topTools) {
              console.log(`    ${chalk.cyan(t.name)} — ${t.count} 次`);
            }
          }
          console.log('');
          return true;
        }

        if (subCommand === 'tools') {
          // Tool execution stats from audit log
          try {
            const auditLog = require('../services/auditLog');
            const stats = auditLog.getAuditStats();
            console.log(chalk.bold('\n  🔧 工具执行统计\n'));
            console.log(`  总调用: ${stats.totalCalls} · 错误: ${stats.errorCount} · 拒绝: ${stats.deniedCount} · 平均延迟: ${stats.avgElapsed}ms`);
            if (Object.keys(stats.byTool).length > 0) {
              console.log(chalk.bold('\n  按工具:'));
              const sorted = Object.entries(stats.byTool).sort(([, a], [, b]) => b - a);
              for (const [name, count] of sorted.slice(0, 15)) {
                const bar = '█'.repeat(Math.min(20, Math.ceil(count / Math.max(1, sorted[0][1]) * 20)));
                console.log(`    ${chalk.cyan(name.padEnd(20))} ${chalk.green(bar)} ${count}`);
              }
            }
            if (Object.keys(stats.byPermission).length > 0) {
              console.log(chalk.bold('\n  按权限:'));
              for (const [perm, count] of Object.entries(stats.byPermission)) {
                console.log(`    ${perm}: ${count}`);
              }
            }
            console.log('');
          } catch {
            printInfo('审计日志不可用');
          }
          return true;
        }

        if (subCommand === 'status' || !subCommand) {
          const stats = aiMonitor.getStats();
          console.log('');
          console.log(`  ${chalk.cyan.bold('AI Monitor 追踪')}`);
          console.log('');
          console.log(`  ${chalk.gray('总请求:')}   ${stats.total}`);
          console.log(`  ${chalk.gray('成功:')}     ${chalk.green(stats.success)}`);
          console.log(`  ${chalk.gray('失败:')}     ${chalk.red(stats.failure)}`);
          console.log(`  ${chalk.gray('成功率:')}   ${stats.successRate}`);
          console.log(`  ${chalk.gray('平均延迟:')} ${stats.avgLatencyMs}ms`);
          console.log(`  ${chalk.gray('缓冲:')}     ${stats.bufferSize}/${stats.maxBufferSize}`);
          if (Object.keys(stats.providers).length > 0) {
            console.log('');
            console.log(chalk.dim('  按 Provider:'));
            for (const [p, s] of Object.entries(stats.providers)) {
              console.log(`    ${p}: ${s.total} req, ${s.successRate}% ok, ${s.avgLatency}ms avg`);
            }
          }
          console.log('');
        } else if (subCommand === 'tail') {
          const recent = aiMonitor.getRecent(10);
          console.log('');
          console.log(`  ${chalk.cyan.bold('最近 AI 请求')}`);
          console.log('');
          for (const t of recent) {
            const icon = t.success ? chalk.green('●') : chalk.red('●');
            const _td = new Date(t.startTime);
            const time = require('./ccFormat').ccBriefTimestampOr(_td.getTime(), Date.now(), _td.toLocaleTimeString());
            console.log(`  ${icon} ${chalk.dim(time)} ${chalk.gray(t.request?.adapter || '?')} ${t.latencyMs ? t.latencyMs + 'ms' : '...'} ${chalk.dim(t.request?.prompt?.slice(0, 50) || '')}`);
          }
          if (recent.length === 0) printInfo('暂无追踪记录');
          console.log('');
        } else if (subCommand === 'clear') {
          aiMonitor.clearTraces();
          printSuccess('追踪记录已清除');
        }
        return true;
      }

      case 'services': {
        const registry = require('../services/serviceRegistry');
        if (subCommand === 'list' || !subCommand) {
          const services = registry.list();
          console.log(chalk.bold(`\n  📦 服务注册表 (${services.length} 个)\n`));
          // Group by category
          const grouped = {};
          for (const svc of services) {
            if (!grouped[svc.category]) grouped[svc.category] = [];
            grouped[svc.category].push(svc);
          }
          for (const [cat, svcs] of Object.entries(grouped).sort()) {
            console.log(chalk.bold(`  [${cat}]`));
            for (const svc of svcs) {
              const status = svc.error ? chalk.red('✗') : svc.loaded ? chalk.green('●') : chalk.dim('○');
              console.log(`    ${status} ${chalk.cyan(svc.name.padEnd(25))} ${chalk.dim(svc.description)}`);
            }
          }
          const st = registry.stats();
          console.log(chalk.dim(`\n  ${st.total} 注册 · ${st.loaded} 已加载 · ${st.errored} 错误\n`));
        } else if (subCommand === 'health') {
          printInfo('正在检查服务健康...');
          const results = await registry.healthCheck();
          console.log(chalk.bold('\n  🏥 服务健康检查\n'));
          for (const r of results) {
            const icon = r.healthy === true ? chalk.green('✓') : r.healthy === false ? chalk.red('✗') : chalk.dim('○');
            const latency = r.latency ? chalk.dim(` (${r.latency}ms)`) : '';
            const note = r.error ? chalk.red(` — ${r.error}`) : (r.note ? chalk.dim(` — ${r.note}`) : '');
            console.log(`  ${icon} ${r.name}${latency}${note}`);
          }
          console.log('');
        }
        return true;
      }

      case 'linux': {
        const { handleLinuxCommand } = require('./handlers/linux');
        await handleLinuxCommand(subCommand, args, options);
        return true;
      }

      case 'shell': {
        const showShellHelp = () => {
          console.log('');
          console.log(chalk.cyan.bold('  🖥 Shell Command'));
          console.log('');
          console.log('  shell <command...>                          执行 shell 命令');
          console.log('  shell run <command...>                      显式 run 模式');
          console.log('  shell --cwd <dir> --timeout <ms> -- <cmd>  指定目录/超时并执行命令');
          console.log('');
          console.log('  示例:');
          console.log('    shell ls -la');
          console.log('    shell run npm test');
          console.log('    shell --cwd backend --timeout 45000 -- npm run test -- --runInBand');
          console.log('');
          console.log('  说明: 若命令参数包含 --xxx，建议使用 `--` 分隔 CLI 选项和 shell 命令。');
          console.log('');
        };

        if (subCommand === 'help') {
          showShellHelp();
          return true;
        }

        const commandText = args.join(' ').trim();
        if (!commandText) {
          printError('Usage: shell <command...> [--cwd <path>] [--timeout <ms>]');
          printInfo('Tip: use `--` before shell command when it contains --flags.');
          return true;
        }

        const timeoutRaw = options.timeout ?? options.timeout_ms;
        const timeoutMs = Number(timeoutRaw);
        const payload = { command: commandText };
        if (typeof options.cwd === 'string' && options.cwd.trim()) payload.cwd = options.cwd.trim();
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) payload.timeout = timeoutMs;

        const toolCalling = require('../services/toolCalling');
        const permission = await toolCalling.requestPermission('shellCommand', payload);
        if (permission === 'deny') {
          printError('User denied shell command execution');
          return true;
        }
        const toolRegistry = toolCalling.getToolRegistry();
        const shellTool = toolRegistry?.get?.('shellCommand');
        if (!shellTool || typeof shellTool.execute !== 'function') {
          printError('shellCommand tool is unavailable');
          return true;
        }
        if (typeof shellTool.validateInput === 'function') {
          const semantic = await shellTool.validateInput(payload, {});
          if (semantic && semantic.valid === false) {
            printError(semantic.message || 'Shell command validation failed');
            return true;
          }
        }
        const result = await shellTool.execute(payload, {
          traceContext: { source: 'cli-shell', role: 'user' },
          onActivity: () => {},
        });

        const output = String(result?.output || '').trimEnd();
        if (output) console.log(output);

        if (result?.success) {
          const exitCode = Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : 0;
          printSuccess(`Shell command completed (exit ${exitCode})`);
        } else {
          let errText = '';
          if (typeof result?.error === 'string') errText = result.error.trim();
          else if (result?.error?.message) errText = String(result.error.message).trim();
          else if (result?.error) errText = JSON.stringify(result.error);
          if (!errText) {
            const exitCode = Number.isFinite(Number(result?.exitCode)) ? Number(result.exitCode) : null;
            errText = exitCode !== null
              ? `Shell command failed (exit ${exitCode})`
              : 'Shell command failed';
          }
          printError(errText);
          if (result?.hint) printInfo(`Hint: ${result.hint}`);
        }
        return true;
      }
      default:
        return ROUTER_NOT_HANDLED;
  }
}

module.exports = { dispatchOpsCommand, setRouterDispatchOpsDeps, ROUTER_NOT_HANDLED };
