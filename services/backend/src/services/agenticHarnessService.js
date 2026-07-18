'use strict';

/**
 * agenticHarnessService.js
 *
 * Five-pillar runtime composition for:
 *   1) Context engineering
 *   2) Agent loop resiliency
 *   3) Skills activation
 *   4) Memory engineering
 *   5) Harness-level observability
 *
 * This module does not replace existing services. It assembles them into one
 * reusable entrypoint so CLI/REPL/sub-agents can share the same workflow.
 */

const crypto = require('crypto');
const path = require('path');
const { AgentContext } = require('./agentContext');
const { routeContextStrategy, truncateToolResults } = require('./contextRouter');
const { compress } = require('./contextCompressor');
const { estimateTokens } = require('./contextWasm');
const { runToolUseLoop } = require('./toolUseLoop');
const { retryWithBackoff, isRetryableError } = require('./retryWithBackoff');
const backgroundTaskManager = require('./backgroundTaskManager');
const projectMemoryService = require('./projectMemoryService');
const projectMetadataService = require('./projectMetadataService');
const contextScopePlanner = require('./contextScope');
const memdir = require('../memdir');
const skills = require('../skills');

const DEFAULTS = Object.freeze({
  contextBudget: 128000,
  retryAttempts: 2,
  retryMinDelayMs: 700,
  retryMaxDelayMs: 5000,
  memoryHintLimit: 4,
  skillHintLimit: 6,
  cacheTtlMs: 120000,
  maxCacheEntries: 256,
  maxContinuationRounds: 3,
  continuationCooldownMs: 1500,
  maxRemediationRounds: 2,
});

function createAgenticHarness(options = {}) {
  const cfg = {
    ...DEFAULTS,
    ...(options || {}),
  };

  const hintCache = _createTtlCache(cfg.cacheTtlMs, cfg.maxCacheEntries);
  const vectorRetriever = typeof cfg.vectorRetriever === 'function' ? cfg.vectorRetriever : null;

  async function buildContextPacket(input = {}) {
    const userMessage = String(input.userMessage || '').trim();
    const systemPrompt = String(input.systemPrompt || '');
    const contextBudget = Math.max(2048, Number(input.contextBudget || cfg.contextBudget) || cfg.contextBudget);
    const messages = _cloneMessages(input.messages);
    const recentFiles = _safeArray(input.recentFiles);
    const cwd = input.cwd || process.cwd();

    const contextRoute = routeContextStrategy(messages, systemPrompt, userMessage, contextBudget);
    let workingMessages = _cloneMessages(messages);

    if (contextRoute.route === 'truncate_tool_results_only' || contextRoute.route === 'compact_then_truncate') {
      truncateToolResults(workingMessages, Math.max(0, contextRoute.overflow));
    }

    if ((contextRoute.route === 'compact_only' || contextRoute.route === 'compact_then_truncate')
      && typeof input.callModelForCompression === 'function'
      && workingMessages.length > 0) {
      try {
        const compactResult = await compress(workingMessages, {
          estimateTokensFn: estimateTokens,
          callModelFn: input.callModelForCompression,
          contextWindowTokens: contextBudget,
        });
        if (Array.isArray(compactResult.compressed)) {
          workingMessages = compactResult.compressed;
        }
      } catch {
        // Compression is best-effort. The route info still indicates pressure.
      }
    }

    const cacheKey = _hashInput(JSON.stringify({
      userMessage,
      cwd,
      recentFiles,
      memoryHintLimit: input.memoryHintLimit || cfg.memoryHintLimit,
      skillHintLimit: input.skillHintLimit || cfg.skillHintLimit,
    }));

    let hints = hintCache.get(cacheKey);
    if (!hints) {
      const memoryHints = await _collectMemoryHints({
        userMessage,
        maxItems: Math.max(1, Number(input.memoryHintLimit || cfg.memoryHintLimit) || cfg.memoryHintLimit),
        vectorRetriever,
      });
      const skillHints = _collectSkillHints({
        userMessage,
        cwd,
        recentFiles,
        maxItems: Math.max(1, Number(input.skillHintLimit || cfg.skillHintLimit) || cfg.skillHintLimit),
      });
      const templateHint = _collectTemplateHint({ userMessage });
      hints = { memoryHints, skillHints, templateHint };
      hintCache.set(cacheKey, hints);
    }

    const tokenEstimate = workingMessages.reduce((sum, msg) => sum + estimateTokens(msg.content || ''), 0)
      + estimateTokens(systemPrompt)
      + estimateTokens(userMessage);

    // Task-driven read/search scope planning (opt-in, zero-intrusion). Decides
    // WHAT to read and search from the task + the project's own `.ai/` map,
    // with a hard budget + sufficiency stop — accurate, not omniscient.
    let scopePlan = null;
    if (process.env.KHY_CONTEXT_SCOPE === '1' || process.env.KHY_CONTEXT_SCOPE === 'on') {
      try {
        scopePlan = await contextScopePlanner.planScope({
          task: userMessage,
          cwd,
          recentFiles,
          budget: input.scopeBudget || {},
          modelPlanner: typeof input.scopeModelPlanner === 'function' ? input.scopeModelPlanner : undefined,
        });
      } catch {
        scopePlan = null; // fail-soft: planning never blocks the run
      }
    }

    return {
      userMessage,
      cwd,
      messages: workingMessages,
      recentFiles,
      contextBudget,
      tokenEstimate,
      contextRoute,
      memoryHints: hints.memoryHints,
      skillHints: hints.skillHints,
      templateHint: hints.templateHint || null,
      scopePlan,
    };
  }

  async function run(request = {}) {
    const userMessage = String(request.userMessage || '').trim();
    const chat = request.chat;
    if (!userMessage) throw new Error('agenticHarnessService: userMessage is required');
    if (typeof chat !== 'function') throw new Error('agenticHarnessService: chat function is required');

    const cwd = request.cwd || process.cwd();
    const chatOpts = request.chatOpts || {};
    const onEvent = typeof request.onEvent === 'function' ? request.onEvent : null;
    let effectiveUserMessage = userMessage;
    let boulderResumeUsed = false;
    let changeGateContext = null;

    // ── Boulder State: resume from cross-session checkpoint ──
    const boulderResumeEnabled = !['0', 'false', 'off', 'no'].includes(
      String(process.env.KHY_BOULDER_RESUME || 'true').trim().toLowerCase(),
    );
    if (boulderResumeEnabled) {
      try {
        const { loadBoulderState, isSimilarMessage, diffFilesystemSnapshot } = require('./boulderState');
        const saved = loadBoulderState(cwd);
        if (saved && saved.status === 'in_progress' && isSimilarMessage(userMessage, saved.userMessage)) {
          boulderResumeUsed = true;
          // Build resume context with full conversation snapshot if available
          const contextParts = [
            `[SYSTEM: Resuming from checkpoint. ${saved.iterations} iterations completed, round ${saved.continuationRound}. Modes: ${(saved.activatedModes || []).join(', ') || 'none'}.`,
          ];
          // v4: Filesystem drift detection
          if (saved.filesystemSnapshot) {
            try {
              const drift = diffFilesystemSnapshot(cwd, saved.filesystemSnapshot);
              if (drift.summary) {
                contextParts.push(drift.summary);
                if (drift.changed.length > 0) {
                  contextParts.push(`Changed files: ${drift.changed.slice(0, 10).map(f => path.basename(f)).join(', ')}`);
                }
                if (drift.deleted.length > 0) {
                  contextParts.push(`Deleted files: ${drift.deleted.slice(0, 5).map(f => path.basename(f)).join(', ')}`);
                }
                if (drift.newCommits) {
                  contextParts.push('New git commits detected since checkpoint — re-read affected files before editing.');
                }
              }
            } catch { /* drift detection is best-effort */ }
          }
          if (saved.contextSummary) {
            contextParts.push(`Context summary: ${saved.contextSummary}`);
          }
          if (saved.conversationMessages && saved.conversationMessages.length > 0) {
            const recentMsgs = saved.conversationMessages.slice(-5).map(m => {
              const content = typeof m.content === 'string' ? m.content.slice(0, 300) : '(structured)';
              return `[${m.role}]: ${content}`;
            }).join('\n');
            contextParts.push(`Recent conversation:\n${recentMsgs}`);
          }
          contextParts.push('Continue where you left off.]');
          effectiveUserMessage = `${contextParts.join(' ')}\n\n${userMessage}`;
          if (onEvent) onEvent({ type: 'boulder_resume', previousIterations: saved.iterations, previousRound: saved.continuationRound, hasFullContext: !!(saved.conversationMessages && saved.conversationMessages.length > 0) });
        }
      } catch { /* boulderState not available — skip */ }
    }

    // ── Prompt Reuse: 检索历史相似任务的有效提示词并前置为复用建议 ──
    // 只加不改：建议块以 [SYSTEM:...] 显式包裹后前置，绝不改写既有提示词内容；
    // 无历史/无命中/停用时返回 null，零副作用。全 best-effort，绝不崩 Agent。
    let promptReuseUsed = false;
    try {
      const promptReuse = require('./promptReuseService');
      const rec = promptReuse.recommendForTask(userMessage);
      if (rec && rec.block) {
        promptReuseUsed = true;
        // 保持「<prefix>\n\n<userMessage>」单一分隔不变性：boulder 已变形时用单换行
        // 并入既有 prefix 段，避免引入第二个 \n\n 破坏下游 resumePrefix 切片逻辑。
        effectiveUserMessage = effectiveUserMessage === userMessage
          ? `${rec.block}\n\n${userMessage}`
          : `${rec.block}\n${effectiveUserMessage}`;
        if (onEvent) onEvent({ type: 'prompt_reuse', count: rec.candidates.length, top: rec.candidates[0] ? { category: rec.candidates[0].category, similarity: rec.candidates[0].similarity, effectiveness: rec.candidates[0].effectiveness } : null });
      }
    } catch { /* promptReuse not available — skip */ }

    const startedAt = Date.now();
    const defaultLabel = `agentic:${path.basename(cwd)}`;
    const taskHandle = backgroundTaskManager.register({
      type: 'agent',
      label: request.taskLabel || defaultLabel,
      meta: {
        phase: 'prepare',
        cwd,
      },
    });

    const runtimeCtx = request.agentContext instanceof AgentContext
      ? request.agentContext
      : new AgentContext({
          role: request.role || 'general',
          toolFilter: request.toolFilter || null,
          config: request.agentConfig || {},
        });

    try {
      const contextPacket = await buildContextPacket({
        userMessage,
        messages: request.messages,
        systemPrompt: request.systemPrompt,
        contextBudget: request.contextBudget,
        cwd,
        recentFiles: request.recentFiles,
        memoryHintLimit: request.memoryHintLimit,
        skillHintLimit: request.skillHintLimit,
        callModelForCompression: async (text, opts) => chat(text, {
          ...chatOpts,
          ...opts,
          _isFollowUp: true,
        }),
      });

      try {
        const {
          prepareChangeRegressionGate,
          prepareBugfixRegressionGate,
        } = require('./changeRegressionGate');
        const prepareGate = prepareChangeRegressionGate || prepareBugfixRegressionGate;
        changeGateContext = prepareGate({
          userMessage,
          chatOpts,
          cwd,
        });
        if (onEvent && changeGateContext?.shouldRun) {
          _emitRegressionGateEvent(onEvent, {
            phase: 'baseline_completed',
            model: changeGateContext.model || null,
            adapter: changeGateContext.adapter || null,
            requiredSteps: changeGateContext.requiredSteps || [],
            baselineSummary: changeGateContext.baseline?.summary || '',
          });
        }
      } catch (gateInitErr) {
        if (onEvent) {
          _emitRegressionGateErrorEvent(onEvent, {
            phase: 'baseline',
            error: String(gateInitErr?.message || 'unknown error'),
          });
        }
      }

      taskHandle.task.meta.phase = 'loop';
      taskHandle.task.updatedAt = Date.now();

      let loopInput = _buildLoopInput(contextPacket);
      // If resuming from boulder state, prepend resume context
      if (effectiveUserMessage !== userMessage) {
        const resumePrefix = effectiveUserMessage.slice(0, effectiveUserMessage.indexOf('\n\n'));
        loopInput = resumePrefix + '\n\n' + loopInput;
      }
      const loopOptions = request.loopOptions || {};

      // Boulder State: checkpoint callback for toolUseLoop
      const _boulderCheckpoint = boulderResumeEnabled ? (info) => {
        try {
          const { saveBoulderState } = require('./boulderState');
          const { detectModes } = require('./intentGate');
          saveBoulderState(cwd, {
            taskId: taskHandle?.id,
            userMessage,
            toolCallLog: info.toolCallLog,
            iterations: info.iteration + (info._totalPreviousIterations || 0),
            continuationRound: info._continuationRound || 0,
            activatedModes: detectModes(userMessage).modes,
            status: 'in_progress',
            // v2: full conversation context
            conversationMessages: info.messages || info.conversationMessages || [],
            contextSummary: info.contextSummary || '',
            sessionMeta: {
              model: chatOpts.model || chatOpts.preferredModel || '',
              adapter: chatOpts.adapter || chatOpts.preferredAdapter || '',
              sessionId: chatOpts.sessionId || '',
            },
            // v4: filesystem snapshot from tool loop's fileReadHashes
            fileReadHashes: info.fileReadHashes || null,
          });
        } catch { /* best-effort */ }
      } : undefined;

      const runLoopOnce = async () => {
        const result = await runToolUseLoop(loopInput, {
          ...loopOptions,
          chat,
          chatOpts: {
            ...chatOpts,
            _agentContext: runtimeCtx,
          },
          onCheckpoint: _boulderCheckpoint,
        });
        if (_isRetryableLoopOutcome(result)) {
          const err = new Error(`Transient tool loop error: ${result.errorType}`);
          err.code = `tool-loop-${result.errorType}`;
          err.loopResult = result;
          throw err;
        }
        return result;
      };

      // ── Auto-decomposition: split structured multi-step tasks before the tool loop ──
      let loopResult;
      const autoDecomposed = await _tryAutoDecompose(userMessage, {
        onEvent,
        chatOpts,
        parentContext: { _agentContext: runtimeCtx },
      });

      if (autoDecomposed) {
        loopResult = autoDecomposed;
      } else {
        try {
          loopResult = await retryWithBackoff(runLoopOnce, {
            attempts: Math.max(1, Number(request.retryAttempts || cfg.retryAttempts) || cfg.retryAttempts),
            minDelayMs: Math.max(100, Number(request.retryMinDelayMs || cfg.retryMinDelayMs) || cfg.retryMinDelayMs),
            maxDelayMs: Math.max(500, Number(request.retryMaxDelayMs || cfg.retryMaxDelayMs) || cfg.retryMaxDelayMs),
            shouldRetry: (err) => {
              if (err && err.loopResult) return true;
              return isRetryableError(err);
            },
            onRetry: (retryInfo) => {
              if (!onEvent) return;
              onEvent({
                type: 'retry',
                attempt: retryInfo.attempt,
                maxAttempts: retryInfo.maxAttempts,
                delayMs: retryInfo.delayMs,
                error: retryInfo.err?.message || 'retry',
              });
            },
          });
        } catch (err) {
          if (err && err.loopResult) {
            loopResult = err.loopResult;
          } else {
            throw err;
          }
        }
      }

      // ── Ralph Loop: auto-continuation when iteration limit is reached ──
      let activatedModes = [];
      try {
        const { detectModes } = require('./intentGate');
        activatedModes = detectModes(userMessage).modes || [];
      } catch { /* intentGate unavailable — keep default */ }
      const complexityFactor = _assessTaskComplexity(userMessage, activatedModes, loopResult);
      const adaptiveMaxRounds = Math.min(Math.ceil(3 * complexityFactor), 8);
      const maxContinuationRounds = Math.max(0, Math.min(adaptiveMaxRounds,
        Number(request.maxContinuationRounds ?? cfg.maxContinuationRounds) || adaptiveMaxRounds));
      let continuationRound = 0;
      let allToolCallLogs = [...(loopResult?.toolCallLog || [])];
      let totalIterations = loopResult?.iterations || 0;

      while (
        loopResult?.maxIterationsReached
        && continuationRound < maxContinuationRounds
        && _shouldAutoContinue(userMessage)
      ) {
        continuationRound++;
        if (onEvent) {
          onEvent({ type: 'continuation', round: continuationRound, maxRounds: maxContinuationRounds });
        }

        // Brief cooldown between rounds
        await new Promise(r => setTimeout(r, cfg.continuationCooldownMs));

        const summary = _buildContinuationSummary(loopResult);
        const continuationMessage = _buildContinuationInput(
          userMessage, summary, continuationRound, maxContinuationRounds,
        );

        try {
          // Pass prior conversation messages so the model retains full context
          // instead of only seeing a text summary (对标 Claude Code 的单循环 messages 持续增长)
          const priorMessages = loopResult?.conversationMessages || [];
          loopResult = await runToolUseLoop(continuationMessage, {
            ...loopOptions,
            chat,
            chatOpts: {
              ...chatOpts,
              _agentContext: runtimeCtx,
            },
            onCheckpoint: _boulderCheckpoint,
            initialMessages: priorMessages,
          });
          allToolCallLogs.push(...(loopResult?.toolCallLog || []));
          totalIterations += (loopResult?.iterations || 0);

          // Boulder State: checkpoint after each continuation round
          try {
            const { saveBoulderState } = require('./boulderState');
            const { detectModes } = require('./intentGate');
            saveBoulderState(cwd, {
              taskId: taskHandle?.id,
              userMessage,
              toolCallLog: allToolCallLogs,
              iterations: totalIterations,
              continuationRound,
              activatedModes: detectModes(userMessage).modes,
              status: 'in_progress',
              // v2: full conversation context
              conversationMessages: loopResult?.messages || [],
              contextSummary: loopResult?.contextSummary || '',
              sessionMeta: {
                model: chatOpts.model || chatOpts.preferredModel || '',
                adapter: chatOpts.adapter || chatOpts.preferredAdapter || '',
                sessionId: chatOpts.sessionId || '',
              },
            });
          } catch { /* best-effort */ }
        } catch (contErr) {
          // Continuation failure is non-fatal; keep previous result
          if (onEvent) onEvent({ type: 'continuation_error', round: continuationRound, error: contErr?.message });
          break;
        }
      }

      // Merge continuation results
      if (continuationRound > 0) {
        loopResult = {
          ...loopResult,
          toolCallLog: allToolCallLogs,
          iterations: totalIterations,
          continuationRounds: continuationRound,
        };
      }

      // ── Delivery Gate: post-loop deliverable verification ──────────
      let deliveryGateReport = null;
      let acceptancePack = null;
      const deliveryGateEnabled = String(process.env.KHY_DELIVERY_GATE || 'true').trim().toLowerCase();
      const maxRemediationRounds = Math.max(0, Math.min(3,
        Number(process.env.KHY_DELIVERY_MAX_REMEDIATION ?? cfg.maxRemediationRounds) || cfg.maxRemediationRounds));

      if (
        !['0', 'false', 'off', 'no'].includes(deliveryGateEnabled)
        && !loopResult?.stopped
        && !loopResult?.errorType
        && maxRemediationRounds > 0
      ) {
        try {
          const { detectModes } = require('./intentGate');
          const { buildAcceptancePack } = require('./acceptanceCriteria');
          const modes = detectModes(userMessage);
          const { evaluateDelivery, buildRemediationPrompt, inferProjectRoot } = require('./deliveryGate');
          const projectRoot = inferProjectRoot(
            allToolCallLogs.length > 0 ? allToolCallLogs : (loopResult?.toolCallLog || []),
            cwd,
          );
          acceptancePack = buildAcceptancePack({
            modes: modes.modes,
            userMessage,
            finalResponse: String(loopResult?.finalResponse || ''),
            toolCallLog: allToolCallLogs.length > 0 ? allToolCallLogs : (loopResult?.toolCallLog || []),
            projectRoot,
          });
          const criteria = acceptancePack.criteria;

          if (criteria.length > 0) {

            deliveryGateReport = evaluateDelivery(projectRoot, criteria, {
              finalResponse: String(loopResult?.finalResponse || ''),
              toolCallLog: allToolCallLogs.length > 0 ? allToolCallLogs : (loopResult?.toolCallLog || []),
              acceptancePack,
            });

            // §4.B cost-to-goal heuristic h(s) — additive telemetry only.
            // Attaches the admissible remaining-work estimate to the report so
            // planning/reflection share the same objective. No control-flow
            // change (zero regression); Phase A consumes prevHeuristic for
            // value backfill and belief calibration.
            let prevHeuristic = _attachHeuristic(deliveryGateReport, null, onEvent, 0);

            // §4.A LRTA* learning restart: seed the learned cost-to-goal
            // estimate from any prior trial/session (warm start), then backfill
            // it every round so the blind fixed-count restart becomes a
            // convergent learning restart. Monotone non-increasing across rounds.
            let learnedH = _seedLearnedHeuristic(cwd);
            learnedH = _backfillTrial(
              cwd, taskHandle?.id, learnedH, prevHeuristic,
              loopResult?.iterations || 0, onEvent, 0,
            );

            let remediationRound = 0;

            while (
              !deliveryGateReport.passed
              && deliveryGateReport.missing.length > 0
              && remediationRound < maxRemediationRounds
            ) {
              remediationRound++;
              if (onEvent) {
                onEvent({
                  type: 'delivery_remediation',
                  round: remediationRound,
                  maxRounds: maxRemediationRounds,
                  missing: deliveryGateReport.missing.map(m => m.label),
                });
              }

              await new Promise(r => setTimeout(r, cfg.continuationCooldownMs));

              const remediationPrompt = buildRemediationPrompt(
                userMessage,
                deliveryGateReport.missing,
                deliveryGateReport.warnings,
                remediationRound,
                maxRemediationRounds,
              );

              const itersBeforeRound = totalIterations;
              try {
                const remediationResult = await runToolUseLoop(remediationPrompt, {
                  ...loopOptions,
                  chat,
                  chatOpts: {
                    ...chatOpts,
                    _agentContext: runtimeCtx,
                  },
                });
                allToolCallLogs.push(...(remediationResult?.toolCallLog || []));
                totalIterations += (remediationResult?.iterations || 0);

                loopResult = {
                  ...loopResult,
                  ...remediationResult,
                  toolCallLog: allToolCallLogs,
                  iterations: totalIterations,
                };
              } catch (remErr) {
                if (onEvent) onEvent({ type: 'delivery_remediation_error', round: remediationRound, error: remErr?.message });
                break;
              }

              // Re-evaluate after remediation
              deliveryGateReport = evaluateDelivery(projectRoot, criteria, {
                finalResponse: String(loopResult?.finalResponse || ''),
                toolCallLog: allToolCallLogs,
                acceptancePack,
              });

              // §4.B re-measure h(s); prevHeuristic carries the prior round so
              // stagnation (no strict decrease) is observable across trials.
              prevHeuristic = _attachHeuristic(deliveryGateReport, prevHeuristic, onEvent, remediationRound);

              // §4.A backfill the learned estimate with this trial's cost g_k
              // (iterations spent this round) and the new admissible remainder.
              learnedH = _backfillTrial(
                cwd, taskHandle?.id, learnedH, prevHeuristic,
                totalIterations - itersBeforeRound, onEvent, remediationRound,
              );
            }

            if (remediationRound > 0) {
              deliveryGateReport.remediationRounds = remediationRound;
            }
          }
        } catch (gateErr) {
          // Delivery gate is best-effort — never block the main flow
          if (onEvent) onEvent({ type: 'delivery_gate_error', error: gateErr?.message });
        }
      }

      // ── Verification Agent: dynamic quality check (syntax/lint/test/build) ──
      let verificationReport = null;
      const verifyEnabled = !['0', 'false', 'off', 'no'].includes(
        String(process.env.KHY_VERIFICATION_GATE || 'true').trim().toLowerCase()
      );
      if (verifyEnabled && !loopResult?.stopped && !loopResult?.errorType) {
        try {
          const { verify } = require('./verificationAgent');
          const editToolPattern = /^(editFile|edit_file|edit|write_file|writeFile|scaffoldFiles|apply_patch)$/i;
          const modifiedFiles = (allToolCallLogs.length > 0 ? allToolCallLogs : (loopResult?.toolCallLog || []))
            .filter(entry => editToolPattern.test(entry.tool || entry.name || ''))
            .map(entry => entry.params?.file_path || entry.params?.path || entry.params?.filePath)
            .filter(Boolean);
          // Deduplicate
          const uniqueFiles = [...new Set(modifiedFiles)];

          if (uniqueFiles.length > 0) {
            verificationReport = verify({ files: uniqueFiles, cwd, failFast: false });

            if (onEvent) {
              onEvent({
                type: 'verification_gate',
                passed: verificationReport.passed,
                summary: verificationReport.summary,
                steps: verificationReport.steps.map(s => ({ name: s.name, pass: s.pass })),
              });
            }

            // If verification failed, run one remediation loop to fix issues
            if (!verificationReport.passed) {
              const failedSteps = verificationReport.steps.filter(s => !s.pass);
              const verifyRemediationPrompt = [
                '[SYSTEM: Verification Gate — quality check FAILED after your changes]',
                '',
                '[Failed checks]:',
                ...failedSteps.map((s, i) => `  ${i + 1}. ${s.name}: ${s.output.slice(0, 500)}`),
                '',
                '[Modified files]:',
                ...uniqueFiles.map(f => `  - ${f}`),
                '',
                '[Instructions]',
                'Fix ALL the errors reported above.',
                'Re-read any file before editing if needed.',
                'After fixing, the system will re-verify automatically.',
              ].join('\n');

              try {
                if (onEvent) onEvent({ type: 'verification_remediation', round: 1 });
                await new Promise(r => setTimeout(r, cfg.continuationCooldownMs));
                const verifyFixResult = await runToolUseLoop(verifyRemediationPrompt, {
                  ...loopOptions,
                  chat,
                  chatOpts: { ...chatOpts, _agentContext: runtimeCtx },
                });
                allToolCallLogs.push(...(verifyFixResult?.toolCallLog || []));
                totalIterations += (verifyFixResult?.iterations || 0);
                loopResult = {
                  ...loopResult,
                  ...verifyFixResult,
                  toolCallLog: allToolCallLogs,
                  iterations: totalIterations,
                };

                // Re-verify after remediation
                const reVerify = verify({ files: uniqueFiles, cwd, failFast: false });
                verificationReport = reVerify;
                if (onEvent) {
                  onEvent({
                    type: 'verification_gate_re_check',
                    passed: reVerify.passed,
                    summary: reVerify.summary,
                  });
                }
              } catch (verifyFixErr) {
                if (onEvent) onEvent({ type: 'verification_remediation_error', error: verifyFixErr?.message });
              }
            }
          }
        } catch (verifyErr) {
          if (onEvent) onEvent({ type: 'verification_gate_error', error: verifyErr?.message });
        }
      }

      // ── Change Regression Gate: block low-tier bugfix/feature regressions ──
      let regressionGateReport = null;
      try {
        if (changeGateContext && changeGateContext.enabled) {
          const {
            evaluateChangeRegressionGate,
            evaluateBugfixRegressionGate,
          } = require('./changeRegressionGate');
          const evaluateGate = evaluateChangeRegressionGate || evaluateBugfixRegressionGate;
          regressionGateReport = evaluateGate({
            context: changeGateContext,
            cwd,
            toolCallLog: allToolCallLogs.length > 0 ? allToolCallLogs : (loopResult?.toolCallLog || []),
          });
          if (onEvent) {
            _emitRegressionGateEvent(onEvent, {
              phase: 'final_evaluation',
              passed: regressionGateReport.passed,
              summary: regressionGateReport.summary,
              regressedSteps: regressionGateReport.regressedSteps || [],
            });
          }

          if (!regressionGateReport.passed) {
            loopResult = {
              ...loopResult,
              errorType: loopResult?.errorType || 'regression_gate',
              finalResponse: _appendRegressionGateSummary(loopResult?.finalResponse, regressionGateReport),
            };
          }
        }
      } catch (regressionErr) {
        if (onEvent) {
          _emitRegressionGateErrorEvent(onEvent, {
            phase: 'final_evaluation',
            error: String(regressionErr?.message || 'unknown error'),
          });
        }
      }

      // ── False-Positive-Fix Guard: 防小模型误判 bug 把正确代码改坏(分档收口)──
      // 弱档(low)且命中(幻想 bug 无复现 / 改未覆盖源码 / 静默行为漂移)→ 并入同一
      // regressionGateReport(passed=false),复用 deliveryGate 的 regression_gate 阻断路径硬拦;
      // 强档(high)恒仅提示、绝不阻断(提示已在 loop 内非绑定注入)。真 RED→GREEN → 自动沉淀复现。
      try {
        const _fpfState = loopResult && loopResult._fpfState;
        let _fpfGuard = null;
        try { _fpfGuard = require('./falsePositiveFixGuard'); } catch { _fpfGuard = null; }
        if (_fpfGuard && _fpfState && _fpfGuard.isEnabled() && _fpfState.bugfixIntent) {
          // 档位:复用回归门的模型档位解析(单源);无法解析时按强档(不硬拦)。
          let tier = 'high';
          try {
            if (changeGateContext && typeof changeGateContext.lowTierModel === 'boolean') {
              tier = changeGateContext.lowTierModel ? 'low' : 'high';
            } else {
              const { isLowTierModel, _resolveModelMeta } = require('./changeRegressionGate');
              if (typeof isLowTierModel === 'function' && typeof _resolveModelMeta === 'function') {
                tier = isLowTierModel(_resolveModelMeta(chatOpts)) ? 'low' : 'high';
              }
            }
          } catch { tier = 'high'; }

          const _fpfToolLog = allToolCallLogs.length > 0 ? allToolCallLogs : (loopResult?.toolCallLog || []);
          let _fpfChangedFiles = [];
          try {
            const { collectChangedFiles } = require('./changeRegressionGate');
            _fpfChangedFiles = collectChangedFiles(_fpfToolLog, cwd);
          } catch { _fpfChangedFiles = []; }
          const _fpfKnownFiles = _listKnownFiles(cwd);

          const fpfVerdict = _fpfGuard.finalize(
            _fpfState,
            {
              tier, changedFiles: _fpfChangedFiles, knownFiles: _fpfKnownFiles,
              // 行为特征化(characterizationSnapshot)接线:把回归门已产出的 baseline/current
              // 验证快照透传给 finalize,使其就地差分出「未覆盖文件上的静默行为漂移」并入裁决。
              // 门 KHY_FPF_CHANGE_REGRESSION_GATE 未跑 / KHY_FPF_CHARACTERIZATION 关 → 无快照或
              // 特征化返空 → 逐字节回退。
              baseline: regressionGateReport ? regressionGateReport.baseline : null,
              current: regressionGateReport ? regressionGateReport.current : null,
            },
            process.env,
          );

          if (onEvent) {
            onEvent({
              type: 'false_positive_fix_gate',
              tier,
              verdict: fpfVerdict.verdict,
              phantomSuspected: fpfVerdict.phantomSuspected,
              reproObserved: fpfVerdict.reproObserved,
              uncoveredFiles: fpfVerdict.uncoveredFiles,
              reasons: (fpfVerdict.reasons || []).map(r => r.code),
              summary: fpfVerdict.summary,
            });
          }

          // 弱档硬拦:并入同一 regressionGateReport(passed=false)。回归门未产报告 / 被跳过时,
          // 合成最小非 skipped 报告,使 deliveryGate.buildHarnessDeliveryVerdict 走 regression_gate 阻断。
          if (fpfVerdict.verdict === 'block') {
            if (!regressionGateReport || regressionGateReport.skipped) {
              regressionGateReport = {
                ...(regressionGateReport || {}),
                passed: false,
                skipped: false,
                regressedSteps: (regressionGateReport && regressionGateReport.regressedSteps) || [],
                summary: fpfVerdict.summary,
                falsePositiveFix: fpfVerdict,
              };
            } else {
              regressionGateReport.passed = false;
              regressionGateReport.summary = `${regressionGateReport.summary || ''}\n${fpfVerdict.summary}`.trim();
              regressionGateReport.falsePositiveFix = fpfVerdict;
            }
            loopResult = {
              ...loopResult,
              errorType: loopResult?.errorType || 'false_positive_fix_guard',
              finalResponse: _appendFalsePositiveFixSummary(loopResult?.finalResponse, fpfVerdict),
            };
          }

          // 自动沉淀复现测试:仅真 RED→GREEN 触发(幻想 bug 改坏全程无红 → 不会误沉淀)。
          if (fpfVerdict.deposit && fpfVerdict.deposit.shouldDeposit) {
            const dep = _depositReproTest(cwd, fpfVerdict.deposit, process.env);
            if (dep && dep.created && onEvent) {
              onEvent({
                type: 'false_positive_fix_repro_deposited',
                file: dep.file,
                signature: fpfVerdict.deposit.signature,
              });
            }
          }
        }
      } catch (fpfErr) {
        if (onEvent) onEvent({ type: 'false_positive_fix_gate_error', error: String(fpfErr?.message || 'unknown error') });
      }
      // 内部守卫状态不外泄给调用方:消费完即从 loopResult 摘除(含 Set/Map,非数据契约)。
      try {
        if (loopResult && Object.prototype.hasOwnProperty.call(loopResult, '_fpfState')) {
          loopResult = { ...loopResult };
          delete loopResult._fpfState;
        }
      } catch { /* best-effort */ }

      // ── Boulder State: clear checkpoint on completion ──
      try {
        const { clearBoulderState } = require('./boulderState');
        clearBoulderState(cwd);
      } catch { /* best-effort */ }

      // ── Sub-agent result aggregation ──
      // Extract structured results from Agent tool calls in the tool log
      const subAgentSummaries = _extractSubAgentSummaries(
        allToolCallLogs.length > 0 ? allToolCallLogs : (loopResult?.toolCallLog || [])
      );
      const { buildHarnessDeliveryVerdict } = require('./deliveryGate');
      const deliveryVerdict = buildHarnessDeliveryVerdict({
        loopResult,
        deliveryGateReport,
        verificationReport,
        regressionGateReport,
        toolCallLog: allToolCallLogs.length > 0 ? allToolCallLogs : (loopResult?.toolCallLog || []),
        acceptancePack,
      });

      if (onEvent) {
        onEvent({
          type: 'delivery_verdict',
          verdict: deliveryVerdict.verdict,
          blockedBy: deliveryVerdict.blockedBy,
          summary: deliveryVerdict.summary,
        });
      }

      // 交付门人类可读报告落盘(承 deliveryGateReporter 叶——此前零生产消费者):
      // deliveryGate 只把结构化摘要挂到 harnessReport.deliveryGate,从不产出带逐条
      // 判定 + 改进建议的 markdown。这里在最终 verdict 定案处,把完整报告经
      // saveDeliveryReport 落到本项目的 ~/.khyquant/projects/<hash>/ 轨迹目录(与
      // saveSessionTrace 同源),给维护者/用户一份可打开的交付说明,并发
      // delivery_gate_report 事件告知路径。门控 KHY_DELIVERY_GATE_REPORT 关 → 不
      // require、不落盘、不发事件(harness 行为逐字节回退)。fail-soft:报告是装饰性,
      // 绝不打断主流程(同 delivery_gate best-effort 约定)。
      if (deliveryGateReport) {
        const _reportEnabled = !['0', 'false', 'off', 'no'].includes(
          String(process.env.KHY_DELIVERY_GATE_REPORT || 'true').trim().toLowerCase()
        );
        if (_reportEnabled) {
          try {
            const { saveDeliveryReport } = require('./deliveryGateReporter');
            const _reportDir = projectMemoryService.getProjectDir(projectRoot || cwd);
            const _reportPath = require('path').join(_reportDir, 'delivery-gate-report.md');
            saveDeliveryReport(deliveryGateReport, _reportPath);
            if (onEvent) {
              onEvent({
                type: 'delivery_gate_report',
                path: _reportPath,
                verdict: deliveryGateReport.verdict,
              });
            }
          } catch { /* fail-soft:交付报告是装饰性,绝不打断返回 */ }
        }
      }

      const finishedAt = Date.now();
      const harnessReport = {
        durationMs: finishedAt - startedAt,
        contextRoute: contextPacket.contextRoute.route,
        tokenEstimate: contextPacket.tokenEstimate,
        memoryHints: contextPacket.memoryHints,
        skillHints: contextPacket.skillHints,
        templateHint: contextPacket.templateHint
          ? { templateId: contextPacket.templateHint.templateId, templateName: contextPacket.templateHint.templateName }
          : null,
        iterations: Number(loopResult?.iterations || 0),
        toolCalls: Array.isArray(loopResult?.toolCallLog) ? loopResult.toolCallLog.length : 0,
        taskId: taskHandle.task.id,
        continuationRounds: continuationRound,
        subAgentSummaries: subAgentSummaries.length > 0 ? subAgentSummaries : null,
        deliveryVerdict,
        deliveryGate: deliveryGateReport ? {
          verdict: deliveryGateReport.verdict,
          passed: deliveryGateReport.passed,
          summary: deliveryGateReport.summary,
          projectRoot: deliveryGateReport.projectRoot,
          criteriaCount: deliveryGateReport.criteriaCount,
          profileIds: deliveryGateReport.profileIds,
          modes: deliveryGateReport.modes,
          missing: deliveryGateReport.missing.map(m => m.label),
          warnings: deliveryGateReport.warnings.map(w => w.label),
          remediationRounds: deliveryGateReport.remediationRounds || 0,
        } : null,
        regressionGate: regressionGateReport ? {
          skipped: !!regressionGateReport.skipped,
          passed: !!regressionGateReport.passed,
          reason: regressionGateReport.reason || '',
          summary: regressionGateReport.summary || '',
          regressedSteps: regressionGateReport.regressedSteps || [],
          changedFiles: regressionGateReport.changedFiles || [],
          requiredSteps: regressionGateReport.requiredSteps || [],
          recommendations: regressionGateReport.recommendations || [],
        } : null,
        verificationGate: verificationReport ? {
          passed: verificationReport.passed,
          summary: verificationReport.summary,
          projectType: verificationReport.projectType,
          steps: (verificationReport.steps || []).map(s => ({
            name: s.name, pass: s.pass, durationMs: s.durationMs,
          })),
        } : null,
        analytics: {
          adaptiveRounds: maxContinuationRounds,
          roundsUsed: continuationRound,
          roundEfficiency: continuationRound > 0
            ? (allToolCallLogs.filter(tc => tc?.result?.success !== false).length / Math.max(1, allToolCallLogs.length))
            : null,
          boulderResumed: !!boulderResumeUsed,
          complexityFactor: typeof complexityFactor !== 'undefined' ? complexityFactor : null,
        },
      };

      try {
        projectMemoryService.saveSessionTrace(cwd, {
          type: 'agentic_harness_run',
          promptPreview: userMessage.slice(0, 500),
          contextRoute: harnessReport.contextRoute,
          iterations: harnessReport.iterations,
          toolCalls: harnessReport.toolCalls,
          memoryHints: harnessReport.memoryHints.map(item => item.filename),
          skillHints: harnessReport.skillHints.map(item => item.trigger || item.name),
          durationMs: harnessReport.durationMs,
          success: deliveryVerdict.verdict !== 'fail',
          deliveryVerdict,
          deliveryGate: harnessReport.deliveryGate,
          verificationGate: harnessReport.verificationGate,
          regressionGate: harnessReport.regressionGate,
        });
      } catch {
        // Session trace persistence is best-effort.
      }

      // ── Prompt Reuse: 回收本次任务效果，沉淀/更新可复用提示词配方 ──
      // 复用与现有交付/验证门同源的 success 信号；只登记效果统计，绝不改业务结果。
      // 全 best-effort，任何异常静默吞掉，绝不阻断任务完成。
      try {
        require('./promptReuseService').captureOutcome({
          taskText: userMessage,
          success: deliveryVerdict.verdict !== 'fail',
          durationMs: harnessReport.durationMs,
          traceId: harnessReport.traceId || null,
        });
      } catch {
        // Prompt-reuse capture is best-effort.
      }

      // ── 可维护性元数据（种子文档）──────────────────────────────────
      // 目标：凡 khy 生成的项目都必须自带 .ai/ 元数据，即便将来无 AI 也能维护。
      // 仅当本次运行确实生成了项目（脚手架/模板或 >= KHY_META_MIN_FILES 个新文件）
      // 且项目根尚无 .ai/MAP.md 时触发。fail-soft，绝不阻断任务完成。
      try {
        const metaLog = (allToolCallLogs && allToolCallLogs.length)
          ? allToolCallLogs
          : (loopResult?.toolCallLog || []);
        const metaResult = await projectMetadataService.maybeGenerateAfterRun(cwd, metaLog, {
          log: (msg) => { if (onEvent) onEvent({ type: 'metadata', message: String(msg) }); },
        });
        if (metaResult && metaResult.generated) {
          harnessReport.maintainabilityMetadata = {
            root: metaResult.root,
            files: metaResult.files,
          };
          if (onEvent) {
            onEvent({
              type: 'metadata_generated',
              root: metaResult.root,
              files: metaResult.files,
            });
          }
        }
      } catch {
        // Maintainability metadata generation is best-effort; never wedge completion.
      }

      backgroundTaskManager.complete(taskHandle.task.id, harnessReport);
      if (onEvent) onEvent({ type: 'completed', report: harnessReport });

      return {
        ...loopResult,
        harness: harnessReport,
      };
    } catch (err) {
      backgroundTaskManager.fail(taskHandle.task.id, err?.message || 'agentic harness failed');
      if (onEvent) onEvent({ type: 'failed', error: err?.message || 'agentic harness failed' });
      throw err;
    }
  }

  return {
    run,
    buildContextPacket,
    config: { ...cfg },
    clearCache: () => hintCache.clear(),
  };
}

/**
 * Extract structured summaries from Agent tool calls in the tool log.
 * Each Agent tool result may contain subtaskResults, filesModified, etc.
 */
function _extractSubAgentSummaries(toolCallLog) {
  if (!Array.isArray(toolCallLog)) return [];
  const summaries = [];
  for (const entry of toolCallLog) {
    const toolName = String(entry?.tool || entry?.name || '').toLowerCase();
    if (toolName !== 'agent' && toolName !== 'sub_agent' && toolName !== 'delegate') continue;
    const result = entry?.result;
    if (!result) continue;
    summaries.push({
      subagentType: result.subagent_type || result.subagentType || 'unknown',
      role: result.role || 'general',
      success: result.success !== false,
      toolCalls: result.toolCalls || 0,
      filesModified: result.filesModified || [],
      subtaskCount: result.subtaskCount || 0,
      elapsed: result.elapsed || null,
      output: (result.output || '').slice(0, 500),
    });
  }
  return summaries;
}

/**
 * Attempt programmatic task decomposition before entering the tool loop.
 * When the user message contains explicit multi-step structure (numbered lists,
 * parallel markers, multi-file targets), split into parallel sub-agents via
 * SubAgentOrchestrator and aggregate results — no LLM decision needed.
 *
 * @returns {object|null} loopResult-compatible object, or null to skip decomposition
 */
async function _tryAutoDecompose(userMessage, ctx) {
  // Feature gate
  if (process.env.KHY_AUTO_DECOMPOSE === 'false' || process.env.KHY_AUTO_DECOMPOSE === '0') {
    return null;
  }

  try {
    const { _isComplexTask, _shouldAutoDecompose } = require('./toolUseLoop');
    const { decompose, mergeResults } = require('./taskDecomposer');

    const complexResult = _isComplexTask(userMessage);
    if (!complexResult.isComplex) return null;

    const plan = decompose(userMessage, complexResult);
    if (!plan.shouldDecompose || plan.subtasks.length < 2) return null;

    // Dependency-aware wave scheduling (farewell-gift leaf). The decomposer may emit
    // subtasks carrying `dependencies` (see _llmDecomposer) that were previously
    // dropped — every subtask fanned out at once regardless of order. planWaves
    // compiles them into ordered waves (parallel-within, serial-between). Gate off /
    // no deps / single wave → exactly one wave = today's flat fan-out (byte-revert).
    let wavePlan;
    try {
      const { planWaves } = require('./orchestrator/dependencyWaveScheduler');
      wavePlan = planWaves(plan.subtasks, { env: process.env });
    } catch {
      wavePlan = null;
    }
    const waves = wavePlan && Array.isArray(wavePlan.waves) && wavePlan.waves.length
      ? wavePlan.waves
      : [plan.subtasks];
    // Resolved dependency edges + per-wave source positions (from the same leaf).
    // These drive fault-aware wave execution below; both degrade to empty/flat when
    // the plan collapsed to a single wave, so the fault-stop path is a guaranteed
    // no-op unless there are real resolved edges across multiple waves.
    const waveEdges = wavePlan && Array.isArray(wavePlan.edges) ? wavePlan.edges : [];
    const waveGlobalIndex = wavePlan && Array.isArray(wavePlan.waveGlobalIndex)
      ? wavePlan.waveGlobalIndex
      : null;

    // Notify: auto-decomposition triggered
    if (ctx.onEvent) {
      ctx.onEvent({
        type: 'auto_decompose',
        subtaskCount: plan.subtasks.length,
        waveCount: waves.length,
        reason: plan.reason,
        subtasks: plan.subtasks.map(s => ({ role: s.role, preview: s.prompt.slice(0, 80) })),
      });
    }

    // Execute via AgentTool's orchestrated path (reuses SubAgentOrchestrator). Each
    // wave is ONE call to the EXISTING parallel primitive; multiple waves are awaited
    // in order. A single wave collapses to the original single call (byte-equivalent).
    const agentTool = require('../tools/AgentTool');
    const _runOneWave = (waveSubtasks) => agentTool._runOrchestrated(
      { prompt: userMessage, subtasks: waveSubtasks },
      'general',          // parentRole
      'general-purpose',  // subagentType
      300_000,            // timeoutMs
      ctx.parentContext || null,
      {
        preferredAdapter: ctx.chatOpts?.preferredAdapter || '',
        preferredModel: ctx.chatOpts?.preferredModel || '',
        progressCallback: ctx.onEvent
          ? (evt) => ctx.onEvent({ type: 'decompose_progress', ...evt })
          : null,
      },
    );

    let result;
    if (waves.length <= 1) {
      // Single wave — identical to the pre-existing flat fan-out.
      result = await _runOneWave(waves[0] || plan.subtasks);
    } else {
      // Multiple waves — run each in order, remapping each wave's per-call
      // `subtask-N` result names back to the subtask's GLOBAL position in
      // plan.subtasks so the structured merger (which keys on subtask-<globalIdx+1>)
      // stitches the whole run correctly.
      //
      // Fault-aware execution (gate KHY_DEP_WAVE_FAULT_STOP, default-on): a subtask
      // whose resolved dependency already FAILED or was SKIPPED upstream must NOT be
      // launched on a broken premise — running `verify` on top of a failed `explore`
      // and reporting it as a normal result is dishonest. Such a subtask is
      // short-circuited to a skipped failure item and counts as a failure. Skips
      // propagate transitively (a skipped node's index joins the failed set, so its
      // own downstream is skipped too). Gate off → every wave runs unconditionally
      // (byte-revert to the pre-existing ordered-but-not-fault-aware behavior).
      const {
        partitionWaveBySurvivors,
        buildPredecessorContext,
        injectPredecessorContext,
      } = require('./orchestrator/dependencyWaveScheduler');
      const _FAULT_FALSY = new Set(['0', 'false', 'off', 'no']);
      const _faultStopEnabled = (() => {
        const v = process.env.KHY_DEP_WAVE_FAULT_STOP;
        if (v === undefined || v === null) return true;
        return !_FAULT_FALSY.has(String(v).trim().toLowerCase());
      })();
      // Predecessor-result CONTEXT INJECTION (gate KHY_DEP_WAVE_CONTEXT_INJECT,
      // default-on, INDEPENDENT of fault-stop): before forking a downstream wave
      // member, prepend its direct predecessors' result text to its prompt so the
      // sub-agent no longer runs blind (`implement` sees what `explore` produced).
      // Gate off → push the original subtask, leave the Map empty → byte-revert to
      // today's ordered-but-blind multi-wave path. Requires positional global
      // indices to key prior results on (same guard as fault-stop).
      const _CTX_FALSY = new Set(['0', 'false', 'off', 'no']);
      const _contextInjectEnabled = (() => {
        const v = process.env.KHY_DEP_WAVE_CONTEXT_INJECT;
        if (v === undefined || v === null) return true;
        return !_CTX_FALSY.has(String(v).trim().toLowerCase());
      })();
      const contextInject = _contextInjectEnabled && Array.isArray(waveGlobalIndex)
        && waveGlobalIndex.length === waves.length;
      // globalIdx → the inner result object of a member that actually RAN (skipped
      // members have no result text, so they are never recorded here).
      const priorResultsByGlobalIdx = new Map();
      // Only meaningful when we have positional global indices to key on.
      const faultStop = _faultStopEnabled && Array.isArray(waveGlobalIndex)
        && waveGlobalIndex.length === waves.length;

      const mergedSubtaskResults = [];
      let successCount = 0;
      let failCount = 0;
      const failedGlobalIdx = new Set();

      for (let w = 0; w < waves.length; w += 1) {
        const wave = waves[w];
        const globalIdx = faultStop ? waveGlobalIndex[w] : wave.map((st) => plan.subtasks.indexOf(st));

        // Split this wave into members still safe to run vs. those whose dependency
        // collapsed upstream. When fault-stop is off (or we lack positional indices)
        // everything runs — exactly today's behavior.
        const { toRun, toSkip } = faultStop
          ? partitionWaveBySurvivors(globalIdx, waveEdges, failedGlobalIdx)
          : { toRun: globalIdx.slice(), toSkip: [] };

        // Report the skipped members honestly (never silently drop or run them).
        for (const g of toSkip) {
          mergedSubtaskResults.push({
            name: `subtask-${g + 1}`,
            result: { success: false, skipped: true, error: '依赖失败，已跳过' },
          });
          failCount += 1;
          failedGlobalIdx.add(g); // skip propagates transitively to this node's downstream
        }

        if (toRun.length === 0) continue; // whole wave skipped — nothing to fan out

        // Build the sublist to actually run, preserving order, and remember each
        // run member's global index positionally (no indexOf → duplicate-object safe).
        // When context injection is on, prepend each member's direct-predecessor
        // result block to its prompt on a SHALLOW CLONE — never mutate the original
        // subtask object (the gate-off path at line ~1141 keys on plan.subtasks
        // object identity via indexOf, so the injected prompt must stay confined to
        // runSubtasks and never leak upstream into `wave`/`plan.subtasks`).
        const runSubtasks = [];
        const runGlobalIdx = [];
        for (const g of toRun) {
          // Map a global index back to its position within THIS wave.
          const posInWave = globalIdx.indexOf(g);
          if (posInWave < 0) continue;
          const st = wave[posInWave];
          if (contextInject) {
            const block = buildPredecessorContext(st, waveEdges, g, priorResultsByGlobalIdx);
            const injected = injectPredecessorContext(st.prompt, block);
            // No injection (empty block) → keep object identity (zero clone churn).
            runSubtasks.push(injected === st.prompt ? st : { ...st, prompt: injected });
          } else {
            runSubtasks.push(st);
          }
          runGlobalIdx.push(g);
        }

        const waveResult = await _runOneWave(runSubtasks);
        successCount += waveResult.successCount || 0;
        failCount += waveResult.failCount || 0;
        const aggregated = Array.isArray(waveResult.subtaskResults) ? waveResult.subtaskResults : [];
        runGlobalIdx.forEach((g, j) => {
          const agItem = aggregated.find(a => a && a.name === `subtask-${j + 1}`);
          if (agItem) {
            mergedSubtaskResults.push({ ...agItem, name: `subtask-${g + 1}` });
            // A genuinely-failed subtask's index also feeds the transitive skip set.
            if (agItem.result && agItem.result.success === false) failedGlobalIdx.add(g);
            // Record this ran member's result so later waves can inject it as
            // predecessor context (only members that actually ran are recorded;
            // skipped members carry no result text).
            if (contextInject && agItem.result) priorResultsByGlobalIdx.set(g, agItem.result);
          }
        });
      }
      result = {
        subtaskResults: mergedSubtaskResults,
        subtaskCount: plan.subtasks.length,
        successCount,
        failCount,
        elapsed: undefined,
      };
    }

    // Build merged output using the structured merger
    const mergedOutput = mergeResults(plan.subtasks, result.subtaskResults || []);

    if (ctx.onEvent) {
      ctx.onEvent({
        type: 'auto_decompose_done',
        subtaskCount: plan.subtasks.length,
        waveCount: waves.length,
        successCount: result.successCount,
        failCount: result.failCount,
        elapsed: result.elapsed,
      });
    }

    // Return loopResult-compatible shape
    return {
      finalResponse: mergedOutput,
      toolCallLog: [],
      iterations: result.subtaskCount || 0,
      provider: 'orchestrator',
      decomposed: true,
      decomposePlan: plan,
      subtaskResults: result.subtaskResults,
      successCount: result.successCount,
      failCount: result.failCount,
    };
  } catch (err) {
    // Decomposition failure is non-fatal — fall back to normal execution
    if (ctx.onEvent) {
      ctx.onEvent({ type: 'auto_decompose_error', error: err.message });
    }
    return null;
  }
}

function _buildLoopInput(packet) {
  const sections = [packet.userMessage];

  if (packet.memoryHints.length > 0) {
    sections.push([
      '[System Memory Hints]',
      ...packet.memoryHints.map((item, idx) => `${idx + 1}. ${item.title} (${item.filename}) - ${item.snippet}`),
    ].join('\n'));
  }

  if (packet.skillHints.length > 0) {
    sections.push([
      '[System Skill Hints]',
      ...packet.skillHints.map((item, idx) => `${idx + 1}. ${item.trigger || item.name}: ${item.description}`),
    ].join('\n'));
  }

  if (packet.templateHint && packet.templateHint.instructions) {
    sections.push([
      `[Task Playbook: ${packet.templateHint.templateName || packet.templateHint.templateId}]`,
      packet.templateHint.instructions,
    ].join('\n'));
  }

  if (packet.contextRoute.route !== 'fits') {
    sections.push(
      `[System Context Route] route=${packet.contextRoute.route}; overflow=${packet.contextRoute.overflow}; `
      + `toolResultTokens=${packet.contextRoute.toolResultTokens}.`,
    );
  }

  return sections.join('\n\n');
}

function _appendRegressionGateSummary(finalResponse, gateReport) {
  const base = String(finalResponse || '').trim();
  const summary = String(gateReport?.summary || 'Regression gate blocked delivery.').trim();
  const recommendations = Array.isArray(gateReport?.recommendations)
    ? gateReport.recommendations.filter(Boolean)
    : [];
  const lines = [
    '[Regression Gate]',
    summary,
  ];
  if (recommendations.length > 0) {
    lines.push('Next steps:');
    for (let i = 0; i < recommendations.length; i++) {
      lines.push(`${i + 1}. ${recommendations[i]}`);
    }
  }
  return [base, lines.join('\n')].filter(Boolean).join('\n\n');
}

function _emitRegressionGateEvent(onEvent, payload = {}) {
  if (typeof onEvent !== 'function') return;
  const body = { ...(payload || {}) };
  onEvent({ type: 'change_regression_gate', ...body });
  onEvent({ type: 'bugfix_regression_gate', ...body });
}

/**
 * 防 bug 误判:把复现先行守卫的硬拦裁决拼进 finalResponse(仅弱档 block 时调用)。
 * 镜像 _appendRegressionGateSummary 的呈现风格,使阻断原因对用户可见且可执行。
 */
function _appendFalsePositiveFixSummary(finalResponse, fpfVerdict) {
  const base = String(finalResponse || '').trim();
  const summary = String(fpfVerdict?.summary || 'False-positive-fix guard blocked delivery.').trim();
  const recommendations = Array.isArray(fpfVerdict?.recommendations)
    ? fpfVerdict.recommendations.filter(Boolean)
    : [];
  const lines = ['[复现先行守卫]', summary];
  if (recommendations.length > 0) {
    lines.push('建议:');
    for (let i = 0; i < recommendations.length; i++) {
      lines.push(`${i + 1}. ${recommendations[i]}`);
    }
  }
  return [base, lines.join('\n')].filter(Boolean).join('\n\n');
}

/**
 * 复现先行守卫的「兄弟测试覆盖」判定需要项目已知文件清单。零额外重活:best-effort 用
 * `git ls-files` 取受版本控制的文件列表(有上限),任何失败 → 空数组(守卫覆盖维度 fail-open)。
 */
function _listKnownFiles(cwd) {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('git', ['ls-files'], {
      cwd,
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = String(out || '').split('\n').map(s => s.trim()).filter(Boolean);
    // 上限保护:超大仓库只取前 20000 条(覆盖判定为名字启发式,样本足够)。
    return files.length > 20000 ? files.slice(0, 20000) : files;
  } catch {
    return [];
  }
}

/**
 * 自动沉淀复现测试:仅在守卫确认了真实 RED→GREEN 修复(deposit.shouldDeposit)时调用。
 * 幂等 + 防撞:文件名含复现签名的 sha256 前 8 位,**仅当不存在时创建,绝不覆盖**;落进 khy
 * 自身回归套件目录(从 __dirname 解析,不写入任意用户仓),目录不存在(打包安装)则静默跳过。
 * 文件是薄 wrapper,记录被捕获的复现命令并断言其现已通过,带 auto-marker 头注供人工接管。
 * 任何 IO 失败都 fail-soft,绝不影响主流程。
 * @returns {{created:boolean, file:string|null}}
 */
function _depositReproTest(cwd, deposit, env = process.env, targetDir = null) {
  try {
    const fs = require('fs');
    const testsDir = targetDir || path.resolve(__dirname, '..', '..', 'tests', 'services');
    // 仅当目录已存在(开发 / editable 安装)才沉淀;打包只读安装下静默跳过。
    if (!fs.existsSync(testsDir)) return { created: false, file: null };

    const sig = String(deposit.signature || '');
    const sha8 = crypto.createHash('sha256').update(sig).digest('hex').slice(0, 8);
    const firstFail = (Array.isArray(deposit.redFailures) && deposit.redFailures[0]) || deposit.framework || 'repro';
    const slug = String(firstFail).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'repro';
    const fileName = `repro.autodeposit.${slug}.${sha8}.test.js`;
    const filePath = path.join(testsDir, fileName);

    // 幂等:同复现 → 同名 → 已存在则不重写(防测试目录被撞 / 重试累积)。
    if (fs.existsSync(filePath)) return { created: false, file: filePath };

    const command = String(deposit.command || '').replace(/[`$\\]/g, '');
    const failures = (Array.isArray(deposit.redFailures) ? deposit.redFailures : []).slice(0, 8);
    const failuresBlock = failures.length
      ? failures.map(f => ` *   - ${String(f).replace(/\*\//g, '* /')}`).join('\n')
      : ' *   (未记录具体失败用例名)';

    const content = `'use strict';

/**
 * ${fileName} — KHY 自动沉淀的复现回归测试(AUTO-DEPOSITED · 待人工接管)。
 *
 * 由 falsePositiveFixGuard 在一次真实的 RED→GREEN 修复后自动沉淀:某测试曾失败(红),
 * 经修改后转绿。本文件把该复现命令固化成永久回归,防同一 bug 复发。
 *
 * 复现框架 : ${String(deposit.framework || 'test')}
 * 复现命令 : ${command || '(未记录)'}
 * 当时红的失败用例:
${failuresBlock}
 *
 * ⚠️ 这是占位回归骨架,不自行 spawn 外部命令(避免在 CI/沙箱误触发)。请维护者把上面的
 *    复现命令转写成针对性的内联断言后,删除本 marker。命令现应通过(绿)。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('AUTO-DEPOSIT 复现占位(${sha8}) — 待维护者落实断言', () => {
  // 复现命令: ${command || 'N/A'}
  // 修复后应通过;此处留空占位,确保文件可被测试发现器收集而不误报失败。
  assert.ok(true);
});
`;

    // 闸:KHY_FPF_AUTO_DEPOSIT_REPRO 默认开,仅 off/0/false 关闭。
    const flag = env && env.KHY_FPF_AUTO_DEPOSIT_REPRO;
    if (flag === 'off' || flag === '0' || flag === 'false') return { created: false, file: null };

    fs.writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx' }); // wx:仅当不存在时创建
    return { created: true, file: filePath };
  } catch {
    return { created: false, file: null }; // fail-soft
  }
}

/**
 * §4.B — compute the cost-to-goal heuristic h(s) for a delivery-gate report,
 * attach it as `report.heuristic`, and emit observability telemetry. Purely
 * additive: it never alters control flow, so it is zero-regression even when
 * enabled. Returns the heuristic value of THIS report (for the caller to carry
 * forward as the previous-trial value), or the unchanged prior value on any
 * error / when disabled. `KHY_HEURISTIC_ENABLED` (default on) gates it.
 */
function _attachHeuristic(deliveryGateReport, prevHeuristic, onEvent, round) {
  const enabled = !['0', 'false', 'off', 'no'].includes(
    String(process.env.KHY_HEURISTIC_ENABLED || 'true').trim().toLowerCase()
  );
  if (!enabled || !deliveryGateReport) return prevHeuristic;
  try {
    const { computeHeuristic, shouldCalibrate } = require('./heuristic');
    const metrics = computeHeuristic(deliveryGateReport);
    const prevH = (prevHeuristic && Number.isFinite(prevHeuristic.h)) ? prevHeuristic.h : null;
    const stagnant = prevH === null ? false : shouldCalibrate(prevH, metrics.h);
    deliveryGateReport.heuristic = { ...metrics, round, prevH, stagnant };
    if (typeof onEvent === 'function') {
      onEvent({
        type: 'heuristic',
        round,
        h: metrics.h,
        hAdmissible: metrics.hAdmissible,
        atGoal: metrics.atGoal,
        unsatisfiedRequired: metrics.unsatisfiedRequired,
        unsatisfiedOptional: metrics.unsatisfiedOptional,
        prevH,
        stagnant,
      });
    }
    return deliveryGateReport.heuristic;
  } catch (_err) {
    // Heuristic is best-effort observability — never break the harness.
    return prevHeuristic;
  }
}

function _lrtaEnabled() {
  return !['0', 'false', 'off', 'no'].includes(
    String(process.env.KHY_LRTA_ENABLED || 'true').trim().toLowerCase()
  );
}

/**
 * §4.A — seed the learned cost-to-goal estimate from a prior trial / session so
 * the trial loop starts warm (LRTA* learning restart). Returns +Infinity when
 * nothing is persisted yet (first encounter) or when disabled — i.e. the first
 * backfill simply adopts that round's estimate. Best-effort.
 */
function _seedLearnedHeuristic(cwd) {
  if (!_lrtaEnabled()) return Infinity;
  try {
    const { loadLearnedHeuristic } = require('./lrtaBackfill');
    const rec = loadLearnedHeuristic(cwd);
    return rec && Number.isFinite(rec.h) ? rec.h : Infinity;
  } catch {
    return Infinity;
  }
}

/**
 * §4.A — apply one LRTA* value-backfill step H <- min(prevStoredH, g + h_k)
 * against the learned cost-to-goal estimate for the fixed task state, persist it
 * (isolated sidecar — never the resume checkpoint), and emit telemetry. The
 * returned sequence across rounds is monotone non-increasing (running min),
 * upgrading the blind restart into a convergent learning restart. Best-effort +
 * env-gated; on any error returns `prevStoredH` unchanged (zero regression).
 */
function _backfillTrial(cwd, taskId, prevStoredH, heuristic, roundIterations, onEvent, round) {
  if (!_lrtaEnabled() || !heuristic || !Number.isFinite(heuristic.h)) return prevStoredH;
  try {
    const { backfill, roundCost, saveLearnedHeuristic } = require('./lrtaBackfill');
    const stepCost = roundCost({ iterations: roundIterations });
    const learned = backfill(prevStoredH, stepCost, heuristic.h);
    saveLearnedHeuristic(cwd, learned, { taskId, round, now: Date.now() });
    if (typeof onEvent === 'function') {
      onEvent({
        type: 'lrta_backfill',
        round,
        stepCost,
        hNext: heuristic.h,
        learnedH: learned,
        prevLearnedH: Number.isFinite(prevStoredH) ? prevStoredH : null,
      });
    }
    return learned;
  } catch (_err) {
    return prevStoredH;
  }
}

function _emitRegressionGateErrorEvent(onEvent, payload = {}) {
  if (typeof onEvent !== 'function') return;
  const body = { ...(payload || {}) };
  onEvent({ type: 'change_regression_gate_error', ...body });
  onEvent({ type: 'bugfix_regression_gate_error', ...body });
}

// 可重试循环结局的判定常量（Ch2「不要每轮重建可复用结构」）：_isRetryableLoopOutcome 在每次
// 重试判定时都重建这个字面量 Set 与两个正则。集合/正则均与输入无关,提升到模块作用域一次构造。
// 两个正则仅用 `.test()` 且**无 `/g` 标志**(无 lastIndex 跨调用泄漏),Set 仅经 `.has` 只读消费,
// 三者都不 mutate、不逃逸(函数只返回布尔),逐字节等价。
const _RETRYABLE_LOOP_ERROR_TYPES = new Set(['timeout', 'network', 'process', 'unknown', 'cancelled']);
const _COOLDOWN_RE = /\bcooldown\b/i;
const _RECENT_FAILURE_CACHED_RE = /recent.*failure.*cached/i;

function _isRetryableLoopOutcome(loopResult) {
  const errorType = String(loopResult?.errorType || '').trim().toLowerCase();
  if (!errorType || !_RETRYABLE_LOOP_ERROR_TYPES.has(errorType)) return false;
  // Cooldown failures are deterministic — the adapter cached a recent failure
  // and won't retry until the cooldown expires.  Retrying immediately is futile.
  const content = String(loopResult?.finalResponse || loopResult?.content || '');
  if (_COOLDOWN_RE.test(content) || _RECENT_FAILURE_CACHED_RE.test(content)) return false;
  const calls = Array.isArray(loopResult?.toolCallLog) ? loopResult.toolCallLog.length : 0;
  return calls === 0;
}

async function _collectMemoryHints({ userMessage, maxItems, vectorRetriever }) {
  if (!userMessage) return [];
  const queryTokens = _tokenize(userMessage);
  if (queryTokens.size === 0) return [];

  const candidates = [];
  const seen = new Set();

  const pushHit = (hit, source) => {
    const filename = String(hit?.filename || '').trim();
    if (!filename || seen.has(filename)) return;
    seen.add(filename);
    const frontmatter = hit.frontmatter || {};
    const joined = [frontmatter.name, frontmatter.description, ...(hit.matches || [])].filter(Boolean).join(' ');
    const textTokens = _tokenize(joined);
    const score = _overlapScore(queryTokens, textTokens);
    candidates.push({
      filename,
      title: String(frontmatter.name || filename),
      snippet: _safeSnippet((hit.matches || []).join(' | ') || frontmatter.description || ''),
      score,
      source,
    });
  };

  try {
    const direct = memdir.searchMemories(userMessage);
    for (const hit of direct) pushHit(hit, 'text');
  } catch {
    // ignore
  }

  if (candidates.length < maxItems) {
    const tokenQueries = [...queryTokens].filter(t => t.length >= 2).slice(0, 4);
    for (const token of tokenQueries) {
      try {
        const tokenHits = memdir.searchMemories(token);
        for (const hit of tokenHits) pushHit(hit, 'token');
      } catch {
        // ignore
      }
      if (candidates.length >= maxItems * 3) break;
    }
  }

  if (vectorRetriever) {
    try {
      const vectorHits = await vectorRetriever({
        query: userMessage,
        maxItems: maxItems * 2,
      });
      if (Array.isArray(vectorHits)) {
        for (const hit of vectorHits) {
          pushHit({
            filename: hit.filename || hit.id || `vector-${candidates.length + 1}`,
            frontmatter: {
              name: hit.title || hit.name || hit.filename || 'vector-memory',
              description: hit.description || '',
            },
            matches: [hit.snippet || hit.content || ''],
          }, 'vector');
        }
      }
    } catch {
      // Vector retrieval is optional.
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename))
    .slice(0, maxItems)
    .map(({ filename, title, snippet, source }) => ({ filename, title, snippet, source }));
}

function _collectSkillHints({ userMessage, cwd, recentFiles, maxItems }) {
  try {
    skills.discoverAllSkills(cwd);
    const activeSkills = skills.getActiveSkills({ cwd, recentFiles });
    if (!Array.isArray(activeSkills) || activeSkills.length === 0) return [];

    const queryTokens = _tokenize(userMessage);
    const scored = activeSkills.map((skill) => {
      const baseText = [
        skill.name,
        skill.description,
        skill.trigger,
        ...(skill.tags || []),
      ].filter(Boolean).join(' ');
      const skillTokens = _tokenize(baseText);
      return {
        name: skill.name,
        trigger: skill.trigger,
        description: _safeSnippet(skill.description || '', 140),
        score: _overlapScore(queryTokens, skillTokens),
      };
    });

    const hasSignal = scored.some(item => item.score > 0);
    const picked = (hasSignal
      ? scored.filter(item => item.score > 0)
      : scored
    )
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, maxItems)
      .map(({ name, trigger, description }) => ({ name, trigger, description }));

    return picked;
  } catch {
    return [];
  }
}

/**
 * 任务模板执行手册匹配(承 taskTemplates 叶——此前零生产消费者)。
 *
 * 用户消息命中常见编程任务(加接口/修 bug/加功能/spec 驱动)关键词时,返回该模板的分步
 * 执行手册,供 _buildLoopInput 作为 [Task Playbook] 附加进模型上下文——纯引导,降低小模型
 * 推理负担,绝不抑制任何输出。
 *
 * 门控 KHY_TASK_TEMPLATE_HINT 关(env ∈ {0,false,off,no})→ 恒返 null,不 require 叶、
 * 不匹配、不注入(loopInput 逐字节回退)。fail-soft:任何异常 → null。
 *
 * @param {{ userMessage: string }} args
 * @returns {{ templateId, templateName, instructions } | null}
 */
function _collectTemplateHint({ userMessage }) {
  const enabled = !['0', 'false', 'off', 'no'].includes(
    String(process.env.KHY_TASK_TEMPLATE_HINT || 'true').trim().toLowerCase()
  );
  if (!enabled) return null;
  try {
    const { generateTaskInstructions } = require('./taskTemplates');
    const matched = generateTaskInstructions(String(userMessage || ''));
    if (!matched || !matched.instructions) return null;
    return {
      templateId: matched.templateId,
      templateName: matched.templateName,
      instructions: matched.instructions,
    };
  } catch {
    return null;
  }
}

function _tokenize(text) {
  const raw = String(text || '').toLowerCase();
  const out = new Set();
  const words = raw.match(/[a-z0-9_./-]+/g) || [];
  for (const word of words) {
    const normalized = word.trim();
    if (normalized.length >= 2) out.add(normalized);
  }

  // Keep CJK bigrams to support Chinese query matching.
  const cjk = (raw.match(/[\u4e00-\u9fff]+/g) || []).join('');
  for (let i = 0; i < cjk.length - 1; i++) {
    out.add(cjk.slice(i, i + 2));
  }
  return out;
}

function _overlapScore(left, right) {
  if (!(left instanceof Set) || !(right instanceof Set) || left.size === 0 || right.size === 0) {
    return 0;
  }
  let hit = 0;
  for (const token of left) {
    if (right.has(token)) hit++;
  }
  return hit / left.size;
}

function _safeSnippet(text, maxLen = 180) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1)}…`;
}

function _cloneMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((msg) => ({
    role: String(msg?.role || 'assistant'),
    content: String(msg?.content || ''),
  }));
}

function _safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function _hashInput(input) {
  return crypto.createHash('sha1').update(String(input || '')).digest('hex');
}

function _createTtlCache(ttlMs, maxEntries) {
  const ttl = Math.max(1000, Number(ttlMs) || DEFAULTS.cacheTtlMs);
  const cap = Math.max(16, Number(maxEntries) || DEFAULTS.maxCacheEntries);
  const map = new Map();

  function get(key) {
    const entry = map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      map.delete(key);
      return null;
    }
    return entry.value;
  }

  function set(key, value) {
    if (map.size >= cap) {
      const firstKey = map.keys().next().value;
      if (firstKey !== undefined) map.delete(firstKey);
    }
    map.set(key, {
      value,
      expiresAt: Date.now() + ttl,
    });
  }

  function clear() {
    map.clear();
  }

  return { get, set, clear };
}

// ── Ralph Loop helpers ──────────────────────────────────────────────

/**
 * Assess task complexity to determine adaptive Ralph Loop rounds.
 * @param {string} userMessage - The original user prompt
 * @param {string[]} activatedModes - Intent modes (from IntentGate)
 * @param {object|null} firstLoopResult - Result of the first tool-use loop iteration
 * @returns {number} Complexity factor (1.0 – 2.5)
 */
function _assessTaskComplexity(userMessage, activatedModes, firstLoopResult) {
  let factor = 1.0;
  if ((userMessage || '').length > 2000) factor += 0.5;
  const modes = activatedModes || [];
  if (modes.includes('ultrawork') || modes.includes('coding')) factor += 0.5;
  const toolCount = firstLoopResult?.toolCallLog?.length || 0;
  if (toolCount > 10) factor += 0.5;
  return factor;
}

function _shouldAutoContinue(userMessage) {
  const envFlag = String(process.env.KHY_RALPH_LOOP || '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(envFlag)) return false;

  try {
    const { detectModes } = require('./intentGate');
    const modes = detectModes(userMessage);
    // 明确的 ultrawork/coding 模式直接触发
    if (modes.ultrawork || modes.coding) return true;
    // analyze 模式也可续接
    if (modes.analyze) return true;
  } catch { /* intentGate 失败不阻断 */ }

  // 复杂任务启发式: 消息较长(>200字)且包含动作性关键词也触发续接
  const msg = String(userMessage || '');
  if (msg.length > 200) {
    const actionPatterns = /\b(create|implement|build|refactor|migrate|add|write|develop|设计|实现|创建|重构|编写|开发|搭建|迁移)\b/i;
    if (actionPatterns.test(msg)) return true;
  }

  return false;
}

function _buildContinuationSummary(loopResult) {
  const log = Array.isArray(loopResult?.toolCallLog) ? loopResult.toolCallLog : [];
  const writes = [];
  const shells = [];
  const reads = [];
  let successes = 0;
  let failures = 0;

  for (const entry of log) {
    const tool = String(entry.tool || '');
    const ok = entry.result?.success !== false;
    if (ok) successes++; else failures++;

    if (/write|scaffold|edit/i.test(tool)) {
      const p = entry.params?.path || entry.params?.file_path || entry.params?.root || '';
      if (p) writes.push(p);
    } else if (/shell/i.test(tool)) {
      const cmd = String(entry.params?.command || '').slice(0, 80);
      if (cmd) shells.push(cmd);
    } else if (/read/i.test(tool)) {
      const p = entry.params?.path || entry.params?.file_path || '';
      if (p) reads.push(p);
    }
  }

  const parts = [`Tool calls: ${log.length} (${successes} ok, ${failures} failed)`];
  if (writes.length > 0) parts.push(`Files written/edited: ${writes.slice(0, 15).join(', ')}${writes.length > 15 ? ` (+${writes.length - 15} more)` : ''}`);
  if (shells.length > 0) parts.push(`Shell commands: ${shells.slice(0, 5).join('; ')}${shells.length > 5 ? ` (+${shells.length - 5} more)` : ''}`);
  if (reads.length > 0) parts.push(`Files read: ${reads.slice(0, 10).join(', ')}${reads.length > 10 ? ` (+${reads.length - 10} more)` : ''}`);

  const lastReply = String(loopResult?.finalResponse || '').trim();
  if (lastReply) parts.push(`Last AI response: ${lastReply.slice(0, 300)}`);

  return parts.join('\n');
}

function _buildContinuationInput(originalMessage, summary, round, maxRounds) {
  return [
    `[SYSTEM: Ralph Loop continuation round ${round}/${maxRounds} — auto-continuing because iteration limit was reached.]`,
    '',
    '[Original task]',
    originalMessage.slice(0, 500),
    '',
    '[Progress so far]',
    summary,
    '',
    '[Instructions]',
    'Continue from where the previous round left off.',
    'Do NOT repeat work already completed — focus only on remaining steps.',
    'If the task is now complete, provide a final summary of what was accomplished.',
  ].join('\n');
}

module.exports = {
  createAgenticHarness,
  DEFAULTS,
  // 测试逃生阀:复现先行守卫收口的纯/IO helper(非公开 API,供 harness 单测验证沉淀幂等等)。
  _internals: {
    _appendFalsePositiveFixSummary,
    _listKnownFiles,
    _depositReproTest,
    _isRetryableLoopOutcome,
    _collectTemplateHint,
    _buildLoopInput,
  },
};
