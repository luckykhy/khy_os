/**
 * ML Agent Service (ML 推理引擎)
 *
 * Integrates trained XGBoost / LightGBM models for local inference.
 * Provides six named ML agent roles: market_analyst, technical_analyst,
 * fundamental_analyst, news_analyst, risk_analyst, strategy_analyst.
 *
 * Calls the Python ML pipeline (backend/ml/predict.py) via subprocess.
 * See thesis Chapter 5.3, Code Block 7 (weighted fusion formula).
 */

const { spawn } = require('child_process');
const { safeKill } = require('../tools/platformUtils');
const path = require('path');
const fs = require('fs');
const agentDisplay = require('./agentDisplay');

// ── Agent 显示规范（DESIGN-ARCH-016）接入层 ──────────────────────────────────
// 仅替换日志代码为结构化开发者日志（单行 NDJSON + 脱敏 §1.3 + 摘要 §1.4），
// 绝不改动 ML 推理、权重融合或工具执行结果等核心逻辑。
function _dev(agent, display) {
  return display ? display.child(agent) : agentDisplay.create({ agent });
}
function _logError(agent, action, error, display) {
  _dev(agent, display).log('error', {
    action,
    detail: error && (error.stack || error.message) ? (error.stack || error.message) : String(error),
    status: 'error',
  });
}

class MLAgentService {
  constructor() {
    this.modelsPath = path.join(__dirname, '../../ml/models');
    // 根据操作系统选择 Python 命令
    // 动态探测 Python 路径，支持跨机器迁移
    const { findPython } = require('../utils/pythonPath');
    this.pythonPath = findPython();
    this.requiredMlPythonPackages = ['joblib', 'numpy', 'pandas', 'sklearn', 'xgboost', 'lightgbm'];
    
    this.retrainJob = null;

    // 智能体启用状态配置
    this.agentConfig = {
      market_analyst: {
        enabled: true,
        name: '市场分析师',
        model: 'Random Forest',
        description: '基于随机森林算法，擅长趋势判断和特征重要性分析',
        accuracy: 0.74
      },
      technical_analyst: {
        enabled: true,
        name: '技术分析师',
        model: 'XGBoost',
        description: '基于XGBoost梯度提升算法，擅长技术指标组合评分',
        accuracy: 0.76
      },
      fundamental_analyst: {
        enabled: true,
        name: '基本面分析师',
        model: 'LightGBM',
        description: '基于LightGBM，擅长财务因子与估值因子联合建模',
        accuracy: 0.69
      },
      news_analyst: {
        enabled: true,
        name: '新闻分析师',
        model: 'Naive Bayes',
        description: '基于朴素贝叶斯，擅长新闻情感与主题分类',
        accuracy: 0.65
      },
      risk_analyst: {
        enabled: true,
        name: '风险分析师',
        model: 'Logistic Regression',
        description: '基于逻辑回归，擅长风险概率输出与阈值控制',
        accuracy: 0.72
      },
      strategy_analyst: {
        enabled: true,
        name: '策略分析师',
        model: 'Deep Neural Network',
        description: '基于深度神经网络，擅长多信号融合与策略执行',
        accuracy: 0.78
      }
    };
  }
  
  /**
   * Trigger model retraining as background process
   * @param {object} options - { days, forceCollect, distillationRounds }
   * @returns {object} { jobId, status }
   */
  retrain(options = {}) {
    const { days = 365, forceCollect = false, distillationRounds = 3, skipDistill = false } = options;

    if (this.retrainJob && this.retrainJob.status === 'running') {
      return { success: false, message: 'A retrain job is already running', job: this.retrainJob };
    }

    const jobId = `retrain_${Date.now()}`;
    const scriptPath = path.join(__dirname, '../../ml/retrain_distilled.py');
    const args = [scriptPath, '--days', String(days)];
    if (forceCollect) args.push('--force-collect');
    if (skipDistill) args.push('--skip-distill');
    else args.push('--distillation-rounds', String(distillationRounds));

    this.retrainJob = {
      jobId,
      status: 'running',
      startedAt: new Date().toISOString(),
      logs: [],
      options: { days, forceCollect, distillationRounds, skipDistill }
    };

    const cwd = path.join(__dirname, '../../ml');
    const proc = spawn(this.pythonPath, args, {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });
    // Keep the handle so the long-running training child can be cancelled or
    // killed on shutdown instead of becoming an orphan that wedges retrains.
    this._retrainProc = proc;

    proc.stdout.on('data', (data) => {
      const line = data.toString('utf8').trim();
      if (line) this.retrainJob.logs.push(line);
      // Keep only last 200 lines
      if (this.retrainJob.logs.length > 200) this.retrainJob.logs.shift();
    });

    proc.stderr.on('data', (data) => {
      const line = data.toString('utf8').trim();
      if (line) this.retrainJob.logs.push('[stderr] ' + line);
      if (this.retrainJob.logs.length > 200) this.retrainJob.logs.shift();
    });

    proc.on('close', (code) => {
      if (this._retrainProc === proc) this._retrainProc = null;
      this.retrainJob.status = code === 0 ? 'completed' : 'failed';
      this.retrainJob.exitCode = code;
      this.retrainJob.finishedAt = new Date().toISOString();
      _dev('ml_retrain').log('end', { action: 'model.retrain', detail: `job ${jobId} code ${code}`, status: code === 0 ? 'ok' : 'error' });
    });

    proc.on('error', (err) => {
      if (this._retrainProc === proc) this._retrainProc = null;
      this.retrainJob.status = 'failed';
      this.retrainJob.error = err.message;
      this.retrainJob.finishedAt = new Date().toISOString();
    });

    return { success: true, job: this.retrainJob };
  }

  /**
   * Cancel a running retrain job and kill its child process.
   * Without this a hung training child lives forever and the running-guard in
   * retrain() permanently blocks all future retrains.
   */
  cancelRetrain() {
    const proc = this._retrainProc;
    if (!proc || proc.killed) {
      return { success: false, message: 'No retrain job is running' };
    }
    safeKill(proc);
    this._retrainProc = null;
    if (this.retrainJob && this.retrainJob.status === 'running') {
      this.retrainJob.status = 'cancelled';
      this.retrainJob.finishedAt = new Date().toISOString();
    }
    return { success: true, message: 'Retrain job cancelled', job: this.retrainJob };
  }

  /**
   * Get retrain job status
   */
  getRetrainStatus() {
    return this.retrainJob || { status: 'idle', message: 'No retrain job has been started' };
  }

  /**
   * 获取智能体配置
   */
  getAgentConfig() {
    return this.agentConfig;
  }
  
  /**
   * 设置智能体启用状态
   * @param {string} agentName - 智能体名称
   * @param {boolean} enabled - 是否启用
   */
  setAgentEnabled(agentName, enabled) {
    if (this.agentConfig[agentName]) {
      this.agentConfig[agentName].enabled = enabled;
      _dev('ml').log('result', { action: 'agent.setEnabled', detail: `${this.agentConfig[agentName].name}=${enabled}`, status: 'ok' });
      return true;
    }
    return false;
  }
  
  /**
   * 批量设置智能体状态
   * @param {object} config - 配置对象 { agent_name: true/false }
   */
  setAgentsConfig(config) {
    const results = {};
    for (const [agentName, enabled] of Object.entries(config)) {
      results[agentName] = this.setAgentEnabled(agentName, enabled);
    }
    return results;
  }
  
  /**
   * 获取已启用的智能体列表
   */
  getEnabledAgents() {
    return Object.entries(this.agentConfig)
      .filter(([_, config]) => config.enabled)
      .map(([name, config]) => ({
        id: name,
        name: config.name,
        model: config.model,
        description: config.description,
        accuracy: config.accuracy
      }));
  }

  getAgentIds() {
    return Object.keys(this.agentConfig);
  }

  /**
   * 获取某个智能体可用的模型候选文件（按优先级）
   */
  getModelPathCandidates(agentName) {
    const candidates = [
      {
        variant: 'distilled',
        isCanonical: true,
        file: `${agentName}_distilled_latest.joblib`,
        path: path.join(this.modelsPath, `${agentName}_distilled_latest.joblib`)
      },
      {
        variant: 'legacy',
        isCanonical: true,
        file: `${agentName}_latest.joblib`,
        path: path.join(this.modelsPath, `${agentName}_latest.joblib`)
      }
    ];

    const timestampRegex = new RegExp(`^${agentName}_(\\d{8}_\\d{6})\\.joblib$`);
    let files = [];
    try {
      files = fs.readdirSync(this.modelsPath);
    } catch {
      files = [];
    }

    const timestampCandidates = files
      .map((file) => {
        const match = file.match(timestampRegex);
        if (!match) return null;
        return {
          variant: 'legacy',
          isCanonical: false,
          file,
          path: path.join(this.modelsPath, file),
          timestampToken: match[1]
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.timestampToken.localeCompare(a.timestampToken));

    return [...candidates, ...timestampCandidates];
  }

  resolvePrimaryModel(agentName) {
    const candidates = this.getModelPathCandidates(agentName);
    for (const item of candidates) {
      if (fs.existsSync(item.path)) {
        return item;
      }
    }
    return null;
  }

  /**
   * 获取当前模型文件清单（用于状态页和模型更新确认）
   */
  getModelManifest() {
    const manifest = {};

    for (const agent of this.getAgentIds()) {
      const selected = this.resolvePrimaryModel(agent);
      if (!selected) {
        manifest[agent] = {
          available: false,
          variant: null,
          file: null,
          path: null,
          isCanonical: false,
          size: 0,
          updatedAt: null
        };
        continue;
      }

      const stat = fs.statSync(selected.path);
      manifest[agent] = {
        available: true,
        variant: selected.variant,
        file: selected.file,
        path: selected.path,
        isCanonical: selected.isCanonical,
        size: stat.size,
        updatedAt: stat.mtime.toISOString()
      };
    }

    return manifest;
  }

  /**
   * 刷新模型文件：支持从外部目录导入，并将最新时间戳模型提升为 *_latest.joblib
   */
  refreshModelFiles(options = {}) {
    const {
      sourceDir = null,
      preferDistilled = true
    } = options;

    if (!fs.existsSync(this.modelsPath)) {
      fs.mkdirSync(this.modelsPath, { recursive: true });
    }

    const importedFiles = [];
    if (sourceDir) {
      const resolvedSourceDir = path.resolve(sourceDir);
      if (!fs.existsSync(resolvedSourceDir) || !fs.statSync(resolvedSourceDir).isDirectory()) {
        throw new Error(`sourceDir does not exist or is not a directory: ${resolvedSourceDir}`);
      }

      const sourceFiles = fs.readdirSync(resolvedSourceDir)
        .filter((name) => /\.(joblib|json)$/i.test(name));

      for (const file of sourceFiles) {
        const from = path.join(resolvedSourceDir, file);
        const to = path.join(this.modelsPath, file);
        fs.copyFileSync(from, to);
        importedFiles.push(file);
      }
    }

    const promoted = [];
    const skipped = [];

    for (const agent of this.getAgentIds()) {
      const candidates = this.getModelPathCandidates(agent);
      const distilled = candidates.find((item) => item.variant === 'distilled' && fs.existsSync(item.path));
      const legacyCanonical = candidates.find((item) => item.variant === 'legacy' && item.isCanonical && fs.existsSync(item.path));
      const legacyTimestamp = candidates.find((item) => item.variant === 'legacy' && !item.isCanonical && fs.existsSync(item.path));

      const selected = (preferDistilled ? distilled : null) || distilled || legacyCanonical || legacyTimestamp || null;
      if (!selected) {
        skipped.push(agent);
        continue;
      }

      const canonicalTarget = path.join(
        this.modelsPath,
        selected.variant === 'distilled'
          ? `${agent}_distilled_latest.joblib`
          : `${agent}_latest.joblib`
      );

      if (path.resolve(selected.path) !== path.resolve(canonicalTarget)) {
        fs.copyFileSync(selected.path, canonicalTarget);
        promoted.push({
          agent,
          from: selected.file,
          to: path.basename(canonicalTarget),
          variant: selected.variant
        });
      }
    }

    return {
      sourceDir: sourceDir ? path.resolve(sourceDir) : null,
      importedFiles,
      promoted,
      skipped,
      manifest: this.getModelManifest()
    };
  }

  /**
   * 检查模型是否存在
   */
  checkModelsExist() {
    const results = {};

    for (const agent of this.getAgentIds()) {
      results[agent] = Boolean(this.resolvePrimaryModel(agent));
    }

    return results;
  }

  createModelError(message, code = 'ML_MODEL_ERROR', details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }

  buildPredictionSourceStatus({
    mode = 'trained_model',
    hasFallback = false,
    trainedAgentCount = 0,
    fallbackAgentCount = 0,
    missingAgents = [],
    failedAgents = [],
    message = ''
  } = {}) {
    const modeTextMap = {
      trained_model: '真实训练模型',
      fallback_rule: '规则兜底',
      mixed: '模型+兜底混合',
      fallback_llm: '在线LLM兜底',
      fallback_missing: '模型结果缺失'
    };

    return {
      mode,
      modeText: modeTextMap[mode] || mode,
      hasFallback: Boolean(hasFallback),
      trainedAgentCount: Number(trainedAgentCount) || 0,
      fallbackAgentCount: Number(fallbackAgentCount) || 0,
      missingAgents: Array.isArray(missingAgents) ? missingAgents : [],
      failedAgents: Array.isArray(failedAgents) ? failedAgents : [],
      message: message || (mode === 'trained_model' ? '已使用真实训练模型推理' : '当前结果包含兜底逻辑')
    };
  }

  /**
   * Run a quick Python dependency check at startup so missing ML packages
   * are visible immediately in server logs.
   */
  checkPythonRuntimeDependencies() {
    return new Promise((resolve) => {
      const importProbeScript = [
        'import importlib.util, json',
        `mods = ${JSON.stringify(this.requiredMlPythonPackages)}`,
        'missing = [m for m in mods if importlib.util.find_spec(m) is None]',
        'print(json.dumps({"missing": missing}))'
      ].join('; ');

      const py = spawn(this.pythonPath, ['-c', importProbeScript], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });

      let stdout = '';
      let stderr = '';
      let _settled = false;

      // Bounded timeout: a hung import (e.g. a package probing the network on
      // import) must not keep the probe child alive forever.
      const _timer = setTimeout(() => {
        if (_settled) return;
        _settled = true;
        if (py && !py.killed) safeKill(py);
        resolve({
          ok: false,
          pythonPath: this.pythonPath,
          missing: [...this.requiredMlPythonPackages],
          message: 'Python dependency check timed out (30s)'
        });
      }, 30000);

      py.stdout.on('data', (data) => {
        stdout += data.toString('utf8');
      });

      py.stderr.on('data', (data) => {
        stderr += data.toString('utf8');
      });

      py.on('error', (error) => {
        if (_settled) return;
        _settled = true;
        clearTimeout(_timer);
        resolve({
          ok: false,
          pythonPath: this.pythonPath,
          missing: [...this.requiredMlPythonPackages],
          message: `Failed to start Python process: ${error.message}`
        });
      });

      py.on('close', (code) => {
        if (_settled) return;
        _settled = true;
        clearTimeout(_timer);
        if (code !== 0) {
          resolve({
            ok: false,
            pythonPath: this.pythonPath,
            missing: [...this.requiredMlPythonPackages],
            message: `Python dependency check failed (exit ${code}): ${stderr || 'no stderr output'}`
          });
          return;
        }

        try {
          const parsed = JSON.parse(String(stdout || '').trim() || '{}');
          const missing = Array.isArray(parsed.missing) ? parsed.missing : [...this.requiredMlPythonPackages];
          resolve({
            ok: missing.length === 0,
            pythonPath: this.pythonPath,
            missing,
            message: missing.length === 0
              ? 'All ML Python dependencies are available'
              : `Missing ML Python packages: ${missing.join(', ')}`
          });
        } catch (error) {
          resolve({
            ok: false,
            pythonPath: this.pythonPath,
            missing: [...this.requiredMlPythonPackages],
            message: `Unable to parse Python dependency check output: ${error.message}`
          });
        }
      });
    });
  }

  runPredictScript(payload = {}) {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(__dirname, '../../ml/predict.py');
      const inputData = JSON.stringify(payload || {});

      const python = spawn(this.pythonPath, [scriptPath], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });

      let output = '';
      let error = '';
      let _settled = false;

      // Activity-aware idle timeout: without it a hung predict child never gets
      // killed and the Promise never settles, hanging the caller indefinitely.
      let _idleTimer = null;
      const IDLE_MS = 120000;
      const _clearIdle = () => { if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; } };
      const _resetIdle = () => {
        _clearIdle();
        _idleTimer = setTimeout(() => {
          if (_settled) return;
          _settled = true;
          if (python && !python.killed) safeKill(python);
          reject(new Error(`Predict script idle timeout (${IDLE_MS / 1000}s with no output)`));
        }, IDLE_MS);
      };
      _resetIdle();

      // Missing 'error' handler previously meant a spawn failure threw an
      // uncaught event and left the Promise unsettled.
      python.on('error', (err) => {
        if (_settled) return;
        _settled = true;
        _clearIdle();
        reject(new Error(`Failed to start predict process: ${err.message}`));
      });

      python.stdout.on('data', (data) => {
        output += data.toString('utf8');
        _resetIdle();
      });

      python.stderr.on('data', (data) => {
        error += data.toString('utf8');
        _resetIdle();
      });

      python.on('close', (code) => {
        if (_settled) return;
        _settled = true;
        _clearIdle();
        if (code !== 0) {
          reject(new Error(`Python script failed: ${error || `exit code ${code}`}`));
          return;
        }

        try {
          const trimmed = String(output || '').trim();
          if (!trimmed) {
            reject(new Error(`Predict script returned empty output${error ? `; stderr: ${error}` : ''}`));
            return;
          }

          // Prefer the last JSON line to tolerate incidental log lines.
          const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          const jsonCandidate = lines.length > 1 ? lines[lines.length - 1] : trimmed;
          const result = JSON.parse(jsonCandidate);
          resolve(result);
        } catch (e) {
          reject(new Error(`Failed to parse predict output: ${e.message}${error ? `; stderr: ${error}` : ''}`));
        }
      });

      python.stdin.write(inputData);
      python.stdin.end();
    });
  }

  /**
   * 使用ML模型进行预测
   * @param {string} agentName - 智能体名称
   * @param {object} stockData - 股票数据
   * @returns {Promise<object>} 预测结果
   */
  async predict(agentName, stockData) {
    if (!this.agentConfig[agentName]) {
      throw this.createModelError(`不支持的智能体: ${agentName}`, 'ML_AGENT_UNSUPPORTED', { agentName });
    }

    const primaryModel = this.resolvePrimaryModel(agentName);
    if (!primaryModel) {
      throw this.createModelError(
        `未找到 ${agentName} 的训练模型文件，请先完成模型训练`,
        'ML_MODEL_MISSING',
        { agentName }
      );
    }

    try {
      const result = await this.runPredictScript({
        agent: agentName,
        stock_data: stockData
      });

      if (!result?.success) {
        throw this.createModelError(
          `${agentName} 模型推理失败: ${result?.error || '未知错误'}`,
          'ML_PREDICT_FAILED',
          { agentName, result }
        );
      }

      return {
        ...result,
        sourceStatus: 'trained_model',
        predictionSource: this.buildPredictionSourceStatus({
          mode: 'trained_model',
          hasFallback: false,
          trainedAgentCount: 1,
          fallbackAgentCount: 0,
          message: `${agentName} 预测来自真实训练模型`
        }),
        modelFile: result.model_file || primaryModel.file,
        modelVariant: result.model_variant || primaryModel.variant
      };
    } catch (error) {
      _logError(agentName, 'ml.predict', error);
      if (error?.code) {
        throw error;
      }
      throw this.createModelError(
        `${agentName} 模型推理进程失败: ${error?.message || '未知错误'}`,
        'ML_PREDICT_FAILED',
        { agentName, cause: error?.message || null }
      );
    }
  }

  /**
   * 获取所有智能体的预测
   * @param {object} stockData - 股票数据
   * @param {array} enabledAgents - 指定要使用的智能体（可选）
   * @returns {Promise<object>} 所有智能体的预测结果
   */
  async predictAll(stockData, enabledAgents = null) {
    const modelStatus = this.checkModelsExist();

    // 确定要使用的智能体
    let agentsToUse;
    if (enabledAgents && Array.isArray(enabledAgents) && enabledAgents.length > 0) {
      // 使用指定的智能体列表
      agentsToUse = enabledAgents.filter(agent =>
        this.agentConfig[agent] && this.agentConfig[agent]?.enabled !== false
      );
      _dev('ml').log('tool', { action: 'predictAll.select', detail: `指定 ${agentsToUse.length} 个: ${agentsToUse.join(',')}` });
    } else {
      // 使用所有已启用智能体
      agentsToUse = Object.keys(modelStatus).filter(agent =>
        this.agentConfig[agent]?.enabled
      );
      _dev('ml').log('tool', { action: 'predictAll.select', detail: `全部已启用 ${agentsToUse.length} 个` });
    }

    if (agentsToUse.length === 0) {
      throw this.createModelError('没有可用的已启用智能体', 'ML_AGENT_UNAVAILABLE', {
        enabledAgents,
        modelStatus
      });
    }

    const missingAgents = agentsToUse.filter((agent) => !modelStatus[agent]);
    if (missingAgents.length > 0) {
      throw this.createModelError(
        `缺少已训练模型: ${missingAgents.join(', ')}`,
        'ML_MODEL_MISSING',
        { missingAgents, modelStatus, agentsToUse }
      );
    }

    // 单次Python进程推理全部智能体，确保输出来自真实训练模型
    let allPredictions;
    try {
      allPredictions = await this.runPredictScript({
        stock_data: stockData
      });
    } catch (error) {
      throw this.createModelError(
        `批量模型推理进程失败: ${error?.message || '未知错误'}`,
        'ML_PREDICT_FAILED',
        { agentsToUse, cause: error?.message || null }
      );
    }

    if (allPredictions?.success === false && allPredictions?.error) {
      throw this.createModelError(
        `批量模型推理失败: ${allPredictions.error}`,
        'ML_PREDICT_FAILED',
        { allPredictions, agentsToUse }
      );
    }

    const predictions = {};
    const failedAgents = [];

    for (const agent of agentsToUse) {
      const result = allPredictions?.[agent];
      if (result?.success) {
        const primaryModel = this.resolvePrimaryModel(agent);
        predictions[agent] = {
          ...result,
          sourceStatus: 'trained_model',
          predictionSource: this.buildPredictionSourceStatus({
            mode: 'trained_model',
            hasFallback: false,
            trainedAgentCount: 1,
            fallbackAgentCount: 0,
            message: `${agent} 预测来自真实训练模型`
          }),
          modelFile: result.model_file || primaryModel?.file || null,
          modelVariant: result.model_variant || primaryModel?.variant || null
        };
      } else {
        const message = result?.error || '模型未返回有效预测结果';
        failedAgents.push({ agent, error: message });
        predictions[agent] = { error: message };
      }
    }

    if (failedAgents.length > 0) {
      throw this.createModelError(
        `部分智能体推理失败: ${failedAgents.map(item => item.agent).join(', ')}`,
        'ML_PREDICT_PARTIAL_FAILED',
        { failedAgents, predictions }
      );
    }

    return predictions;
  }

  /**
   * 从股票数据中提取特征
   */
  extractFeatures(stockData) {
    return {
      // 价格特征
      price: stockData.price || 0,
      open: stockData.open || 0,
      high: stockData.high || 0,
      low: stockData.low || 0,
      close: stockData.close || 0,
      
      // 技术指标
      ma5: stockData.ma5 || 0,
      ma10: stockData.ma10 || 0,
      ma20: stockData.ma20 || 0,
      macd: stockData.macd || 0,
      rsi: stockData.rsi || 0,
      kdj_k: stockData.kdj_k || 0,
      kdj_d: stockData.kdj_d || 0,
      kdj_j: stockData.kdj_j || 0,
      
      // 成交量
      volume: stockData.volume || 0,
      amount: stockData.amount || 0,
      
      // 基本面（如果有）
      pe_ratio: stockData.pe_ratio || 0,
      pb_ratio: stockData.pb_ratio || 0,
      roe: stockData.roe || 0
    };
  }

  /**
   * 获取默认分析(当没有训练模型时)
   */
  getDefaultAnalysis(stockData) {
    throw this.createModelError(
      '规则默认预测已禁用。请先训练并加载真实模型文件后再执行预测。',
      'ML_DEFAULT_ANALYSIS_DISABLED',
      {
        stockCode: stockData?.stock_code || stockData?.symbol || null
      }
    );

    const price = stockData.close || stockData.price || 0;
    const ma5 = stockData.ma5 || 0;
    const ma10 = stockData.ma10 || 0;
    const ma20 = stockData.ma20 || 0;
    const ma60 = stockData.ma60 || 0;
    const rsi = stockData.rsi || 50;
    const macd = stockData.macd || 0;
    const macd_signal = stockData.macd_signal || 0;
    const volume = stockData.volume || 0;
    const turnover_rate = stockData.turnover_rate || 0;
    
    // 计算技术指标
    const priceChange = ma20 > 0 ? ((price - ma20) / ma20 * 100) : 0;
    const ma5_ma20_diff = ma20 > 0 ? ((ma5 - ma20) / ma20 * 100) : 0;
    const macd_hist = macd - macd_signal;
    
    return {
      market_analyst: {
        prediction: ma5 > ma20 ? 1 : 0,
        confidence: 0.7,
        algorithm: 'Random Forest',
        analysis: `你好！我是小K的市场分析师。很高兴能以量化交易技术分析师的身份为您服务。

【分析算法】Random Forest (随机森林)
本次分析采用随机森林集成学习算法，通过500棵决策树的投票机制进行市场趋势预测。该算法特别擅长捕捉价格与技术指标之间的非线性关系，在处理多维度市场数据时表现优异。

【一、特征工程：技术指标构建】

在输入随机森林模型之前，我们构建了以下核心技术特征：

趋势因子：
• MA5 (5日均线): ¥${ma5.toFixed(2)}
• MA20 (20日均线): ¥${ma20.toFixed(2)}
• MA60 (60日均线): ¥${ma60.toFixed(2)}
• 均线乖离率: ${ma5_ma20_diff.toFixed(2)}%

动量因子：
• RSI指标: ${rsi.toFixed(2)} ${rsi > 70 ? '(超买区)' : rsi < 30 ? '(超卖区)' : '(中性区间)'}
• MACD: ${macd.toFixed(4)}
• MACD信号线: ${macd_signal.toFixed(4)}
• MACD柱状图: ${macd_hist.toFixed(4)} ${macd_hist > 0 ? '(多头)' : '(空头)'}

成交量因子：
• 成交量: ${(volume / 10000).toFixed(2)}万手
• 换手率: ${turnover_rate.toFixed(2)}%

【二、模型配置与训练】

我们构建了一个随机森林分类器，目标是预测未来5个交易日的涨跌方向。

参数设置：
• n_estimators: 500 (500棵决策树)
• max_depth: 20 (最大深度20层)
• min_samples_split: 5
• random_state: 42
• n_jobs: -1 (使用所有CPU核心)

【三、特征重要性排名】

随机森林输出的特征重要性揭示了当前驱动市场走势的核心逻辑：

Top 1: MA5/MA20交叉 - 重要性得分: 1850
分析师解读：均线系统是最经典的趋势判断指标。当前MA5${ma5 > ma20 ? '上穿' : '下穿'}MA20，形成${ma5 > ma20 ? '金叉' : '死叉'}信号，这是${ma5 > ma20 ? '多头' : '空头'}趋势的重要确认。

Top 2: MACD柱状图 - 重要性得分: 1520
分析师解读：MACD柱状图${macd_hist > 0 ? '为正' : '为负'}，表明${macd_hist > 0 ? '多头动能增强' : '空头压力增大'}。模型识别出MACD与价格的背离关系对预测准确率有显著提升。

Top 3: RSI相对强弱 - 重要性得分: 980
分析师解读：当前RSI为${rsi.toFixed(2)}，处于${rsi > 70 ? '超买' : rsi < 30 ? '超卖' : '正常'}区间。模型显示RSI在${rsi > 70 ? '70以上' : rsi < 30 ? '30以下' : '30-70之间'}时，市场${rsi > 70 ? '回调' : rsi < 30 ? '反弹' : '震荡'}概率显著提升。

【四、模型预测表现】

基于最新数据的回测结果：

• AUC值: 0.72 (具备较好的区分能力)
• 精确率: 65% (预测上涨的准确率)
• 召回率: 68%

具体数据推演：
当前输入特征：
• 价格: ¥${price.toFixed(2)}
• MA5/MA20: ${ma5 > ma20 ? '金叉' : '死叉'}状态
• MACD: ${macd > 0 ? '多头' : '空头'}排列
• RSI: ${rsi.toFixed(2)} (${rsi > 70 ? '超买' : rsi < 30 ? '超卖' : '中性'})

随机森林预测结果：
• 预测${ma5 > ma20 ? '上涨' : '下跌'}概率: ${ma5 > ma20 ? '68.5%' : '62.3%'}
• 预测${ma5 > ma20 ? '下跌' : '上涨'}概率: ${ma5 > ma20 ? '31.5%' : '37.7%'}

【五、综合分析结论】

基于随机森林算法的分析结果，我们得出以下量化技术面观点：

1. 趋势判断：
当前市场呈现${ma5 > ma20 ? '多头' : '空头'}排列，MA5${ma5 > ma20 ? '上穿' : '下穿'}MA20形成${ma5 > ma20 ? '金叉' : '死叉'}信号。
价格相对MA20的乖离率为${priceChange.toFixed(2)}%，${Math.abs(priceChange) > 5 ? '乖离率较大，注意回归风险' : '乖离率适中，趋势较为健康'}。

2. 动能分析：
MACD柱状图${macd_hist > 0 ? '持续为正' : '转为负值'}，表明${macd_hist > 0 ? '多头动能强劲' : '空头压力增大'}。
RSI指标${rsi > 70 ? '进入超买区，短期存在回调压力' : rsi < 30 ? '进入超卖区，存在反弹机会' : '处于中性区间，可继续观察'}。

3. 成交量配合：
成交量${volume > 0 ? '活跃' : '低迷'}，换手率${turnover_rate > 3 ? '较高' : '适中'}，${volume > 0 && ma5 > ma20 ? '量价配合良好' : '需关注量能变化'}。

【六、投资建议】

根据随机森林的预测概率(${ma5 > ma20 ? '>65%看多' : '>60%看空'})，量化模型建议：

操作策略：${ma5 > ma20 ? '增持' : '减持'}
建议仓位：${rsi > 70 ? '30%' : rsi < 30 ? '60%' : '40%'}
止损位：¥${(price * 0.95).toFixed(2)} (-5%)
止盈位：¥${(price * 1.10).toFixed(2)} (+10%)

风险提示：
• 模型基于历史数据训练，市场环境变化可能影响预测准确性
• 建议结合基本面分析和市场情绪综合判断
• 严格执行止损策略，控制单笔交易风险在2%以内`,
        keyFindings: [
          `均线系统: MA5${ma5 > ma20 ? '金叉' : '死叉'}MA20`,
          `MACD: ${macd_hist > 0 ? '多头动能' : '空头压力'}`,
          `RSI: ${rsi.toFixed(2)} (${rsi > 70 ? '超买' : rsi < 30 ? '超卖' : '中性'})`,
          `建议操作: ${ma5 > ma20 ? '增持' : '减持'}`
        ]
      },
      technical_analyst: {
        prediction: rsi > 50 && macd > 0 ? 1 : 0,
        confidence: 0.75,
        algorithm: 'XGBoost',
        analysis: `你好！我是小K的技术分析师。很高兴能以量化交易技术指标专家的身份为您服务。

【分析算法】XGBoost (Extreme Gradient Boosting)
本次分析采用XGBoost极端梯度提升算法，通过500个提升器的迭代优化进行技术指标深度分析。该算法对技术指标的微小变化高度敏感，特别擅长捕捉指标之间的复杂交互关系。

【一、核心技术指标体系】

动量指标：
• RSI (相对强弱指标): ${rsi.toFixed(2)}
  - 当前状态: ${rsi > 70 ? '超买区(>70)' : rsi < 30 ? '超卖区(<30)' : '中性区间(30-70)'}
  - 历史分位数: ${rsi > 70 ? '95%' : rsi < 30 ? '5%' : '50%'}
  - 信号强度: ${rsi > 70 || rsi < 30 ? '强' : '中'}

趋势指标：
• MACD: ${macd.toFixed(4)}
• MACD信号线: ${macd_signal.toFixed(4)}
• MACD柱状图: ${macd_hist.toFixed(4)}
  - 当前状态: ${macd > 0 ? 'MACD在零轴上方(多头)' : 'MACD在零轴下方(空头)'}
  - 金叉/死叉: ${macd > macd_signal ? 'MACD上穿信号线(金叉)' : 'MACD下穿信号线(死叉)'}
  - 柱状图趋势: ${macd_hist > 0 ? '红柱增长(动能增强)' : '绿柱增长(动能减弱)'}

成交量指标：
• 成交量: ${(volume / 10000).toFixed(2)}万手
• 换手率: ${turnover_rate.toFixed(2)}%
• 量能状态: ${volume > 0 ? '活跃' : '低迷'}

【二、XGBoost模型配置】

参数设置：
• n_estimators: 500 (500个提升器)
• max_depth: 10 (树深度10层)
• learning_rate: 0.05 (学习率0.05，精细调优)
• subsample: 0.8 (80%样本采样)
• colsample_bytree: 0.8 (80%特征采样)

训练策略：
• 目标函数: binary:logistic (二分类)
• 评估指标: AUC, Precision, Recall
• 早停轮数: 50轮无提升则停止

【三、特征重要性分析】

XGBoost通过增益(Gain)计算特征重要性：

Top 1: RSI指标 - Gain: 2150
技术解读：RSI是最强预测因子。当RSI${rsi > 70 ? '>70' : rsi < 30 ? '<30' : '在30-70之间'}时，模型识别出${rsi > 70 ? '回调' : rsi < 30 ? '反弹' : '震荡'}的高概率模式。
历史回测显示，RSI极值区域的预测准确率达到73%。

Top 2: MACD柱状图变化率 - Gain: 1890
技术解读：MACD柱状图的变化速度比绝对值更重要。当前柱状图${macd_hist > 0 ? '由负转正' : '由正转负'}，这是${macd_hist > 0 ? '多头' : '空头'}动能转换的关键信号。
模型显示，柱状图连续3日${macd_hist > 0 ? '增长' : '缩短'}时，趋势延续概率超过65%。

Top 3: 量价配合度 - Gain: 1420
技术解读：价格${ma5 > ma20 ? '上涨' : '下跌'}时，成交量${volume > 0 ? '同步放大' : '萎缩'}，${volume > 0 && ma5 > ma20 ? '量价配合良好，趋势可靠' : '量价背离，需警惕反转'}。
XGBoost捕捉到量价关系的非线性特征，这是传统技术分析难以量化的部分。

【四、模型预测性能】

样本外测试结果(2024年数据)：
• AUC: 0.76 (优秀的区分能力)
• 精确率: 71% (预测上涨的准确率)
• 召回率: 69%
• F1-Score: 0.70

具体预测输出：
输入特征向量：
[RSI=${rsi.toFixed(2)}, MACD=${macd.toFixed(4)}, Volume=${(volume/10000).toFixed(2)}万手, MA5/MA20=${ma5 > ma20 ? '金叉' : '死叉'}]

XGBoost预测概率：
• ${rsi > 50 && macd > 0 ? '上涨' : '下跌'}概率: ${rsi > 50 && macd > 0 ? '72.3%' : '68.5%'}
• ${rsi > 50 && macd > 0 ? '下跌' : '上涨'}概率: ${rsi > 50 && macd > 0 ? '27.7%' : '31.5%'}
• 置信度: ${rsi > 50 && macd > 0 ? '高' : '中'}

【五、技术面综合研判】

1. RSI分析：
当前RSI=${rsi.toFixed(2)}，${rsi > 70 ? '已进入超买区，短期存在技术性回调压力。建议关注RSI回落至60附近的支撑' : rsi < 30 ? '已进入超卖区，存在技术性反弹机会。建议关注RSI回升至40附近的阻力' : '处于中性区间，多空力量相对均衡，可继续持有观察'}。

历史统计：当RSI${rsi > 70 ? '>70' : rsi < 30 ? '<30' : '在30-70之间'}时，未来5日${rsi > 70 ? '回调' : rsi < 30 ? '反弹' : '震荡'}概率为${rsi > 70 ? '68%' : rsi < 30 ? '65%' : '55%'}。

2. MACD分析：
MACD${macd > 0 ? '在零轴上方' : '在零轴下方'}，${macd > macd_signal ? '且上穿信号线形成金叉' : '且下穿信号线形成死叉'}，这是${macd > 0 && macd > macd_signal ? '强烈的多头' : macd < 0 && macd < macd_signal ? '强烈的空头' : '中性'}信号。

MACD柱状图${macd_hist > 0 ? '为正且持续增长' : '为负且持续缩短'}，表明${macd_hist > 0 ? '多头动能正在加速' : '空头动能正在减弱'}。

3. 量价关系：
成交量${volume > 0 ? '明显放大' : '相对萎缩'}，换手率${turnover_rate > 3 ? '较高' : '适中'}。
${volume > 0 && ma5 > ma20 ? '价涨量增，多头趋势健康' : volume > 0 && ma5 < ma20 ? '价跌量增，空头趋势确认' : '量能不足，趋势可靠性降低'}。

【六、操作建议】

基于XGBoost的技术指标分析，给出以下量化交易建议：

交易信号：${rsi > 50 && macd > 0 ? '买入' : rsi < 50 && macd < 0 ? '卖出' : '持有观望'}
信号强度：${(rsi > 70 || rsi < 30) && Math.abs(macd) > 0.5 ? '强' : '中'}
建议仓位：${rsi > 70 ? '30% (超买减仓)' : rsi < 30 ? '60% (超卖加仓)' : '40% (中性持仓)'}

具体策略：
• 入场点：${rsi < 50 ? `RSI回升至${(rsi + 5).toFixed(0)}附近` : `RSI回落至${(rsi - 5).toFixed(0)}附近`}
• 止损位：¥${(price * 0.97).toFixed(2)} (-3%)
• 止盈位：¥${(price * 1.08).toFixed(2)} (+8%)
• 持仓周期：5-10个交易日

风险提示：
• XGBoost模型对技术指标的短期波动敏感，建议结合趋势分析
• 当RSI和MACD出现背离时，优先相信MACD信号
• 技术分析需要与基本面分析相互验证，避免单一依赖`,
        keyFindings: [
          `RSI: ${rsi.toFixed(2)} (${rsi > 70 ? '超买' : rsi < 30 ? '超卖' : '中性'})`,
          `MACD: ${macd > macd_signal ? '金叉' : '死叉'} (${macd > 0 ? '多头' : '空头'})`,
          `量价关系: ${volume > 0 && ma5 > ma20 ? '配合良好' : '需要关注'}`,
          `交易信号: ${rsi > 50 && macd > 0 ? '买入' : '观望'}`
        ]
      },
      fundamental_analyst: {
        prediction: 1,
        confidence: 0.65,
        algorithm: 'LightGBM',
        analysis: `你好！我是小K的基本面分析师，将使用 LightGBM 模型对公司价值进行系统化评估。

【分析算法】LightGBM (Light Gradient Boosting Machine)
LightGBM 采用叶子优先生长策略，在处理财务因子、估值因子和盈利质量因子时效率更高，适合金融场景下”特征多、样本不均衡、噪声较高”的问题。模型重点关注估值是否透支、盈利是否可持续、现金流是否支持当前价格。

【一、核心财务与估值因子】

估值指标：
• 市盈率(PE): ${stockData.pe_ratio || '15.8'} (行业中位数: 15.8)
• 市净率(PB): ${stockData.pb_ratio || '2.3'} (行业中位数: 2.3)
• 净资产收益率(ROE): ${stockData.roe || '12.5'}% (行业中位数: 12.5%)
• 当前价格: ¥${price.toFixed(2)}
• 价格相对行业估值分位: ${stockData.pe_ratio ? (stockData.pe_ratio > 30 ? '偏高分位(前25%)' : stockData.pe_ratio > 15 ? '中性分位(25%-75%)' : '偏低分位(后25%)') : '中性分位(参考值)'}

盈利质量因子：
• 毛利率稳定性: ${stockData.gross_margin_stability || '中等'}
• 净利润现金覆盖率: ${stockData.cash_coverage || '1.05 (合理)'}
• 营收增速(YoY): ${stockData.revenue_growth || '8.2'}%

【二、LightGBM 模型配置与训练】

参数设置：
• num_leaves: 63 (叶子节点数)
• learning_rate: 0.03 (学习率)
• n_estimators: 800 (迭代次数)
• feature_fraction: 0.75 (特征采样比)
• bagging_fraction: 0.8 (样本采样比)
• 目标函数: binary (二分类 — 未来季度业绩是否超预期)

特征重要性排名：
Top 1: ROE变化趋势 - Gain: 2340
Top 2: PE/PB比值 - Gain: 1890
Top 3: 现金流/净利润比 - Gain: 1560

【三、模型判读逻辑】

1) 估值层：PE、PB 与行业中位数偏离过大时，模型会下调未来收益预期。
当前PE=${stockData.pe_ratio || '15.8'}，与行业中位数偏离${stockData.pe_ratio ? ((stockData.pe_ratio - 15.8) / 15.8 * 100).toFixed(1) : '0.0'}%。
2) 盈利层：ROE 与利润稳定性是预测中期收益的重要因子，ROE 越稳定，得分越高。
当前ROE=${stockData.roe || '12.5'}%，${(stockData.roe || 12.5) > 15 ? '高于行业平均，盈利能力突出' : (stockData.roe || 12.5) > 10 ? '处于行业平均水平' : '低于行业平均，需关注盈利改善'}。
3) 质量层：当盈利质量与现金流匹配时，模型给出更高置信度；若出现利润增长但现金流弱，模型自动增加风险惩罚。

【四、当前结果解读】

${stockData.pe_ratio ?
`实时数据表明：PE=${stockData.pe_ratio}，PB=${stockData.pb_ratio}，ROE=${stockData.roe}%。
综合判断为${stockData.pe_ratio > 30 ? '估值偏贵，需等待业绩验证' : stockData.pe_ratio > 15 ? '估值与盈利较匹配，可跟踪配置' : '估值相对偏低，存在价值修复机会'}。` :
`当前缺少实时财务明细，先使用行业基准进行估值中枢判断。
基于价格 ¥${price.toFixed(2)} 和技术面数据推算：
• 隐含PE估值区间: 14-18倍
• 安全边际: ${priceChange > 5 ? '偏低(价格高于均值)' : priceChange < -5 ? '较高(价格低于均值)' : '适中'}
建议同步核对最近两期财报，并重点观察利润增速、现金流与资产负债结构。`}

模型预测：
• 未来季度业绩超预期概率: 58%
• 估值修复概率: ${priceChange < 0 ? '65%' : '42%'}
• AUC: 0.69 | 精确率: 62%

【五、操作框架建议】

• 若估值高于行业且盈利增速放缓：以防守为主，控制追涨仓位，建议仓位不超过20%。
• 若估值中性且盈利稳定：可分批配置，优先选择回调后的风险收益比区间，建议仓位30-40%。
• 若估值偏低且盈利改善：关注价值修复窗口，可适当提高仓位至50%，但需设置动态止损 ¥${(price * 0.92).toFixed(2)}。

【六、风险提示】

• LightGBM 依赖历史财务规律，若行业政策突变，模型有效性会下降。
• 财报存在披露时滞，短期波动可能与基本面方向不一致。
• 建议与技术分析、风险模型联合使用，避免单因子决策。`,
        keyFindings: [
          `PE: ${stockData.pe_ratio || '15.8'} (行业中位数15.8)`,
          `PB: ${stockData.pb_ratio || '2.3'} (行业中位数2.3)`,
          `ROE: ${stockData.roe || '12.5'}% (${(stockData.roe || 12.5) > 15 ? '优秀' : '中等'})`,
          `估值判断: ${stockData.pe_ratio > 30 ? '偏贵' : '合理区间'}`
        ]
      },
      news_analyst: {
        prediction: 0,
        confidence: 0.6,
        algorithm: 'Naive Bayes',
        analysis: `你好！我是小K的新闻分析师，本轮采用 Naive Bayes 模型对公告、舆情和媒体文本进行概率化判断。

【分析算法】Naive Bayes (朴素贝叶斯)
Naive Bayes 在金融文本任务中的优势是可解释性强、推理速度快，能将”利好/中性/利空”拆分为可量化概率，适合高频更新的资讯环境。模型会对标题关键词、事件类型、情感词权重和否定词结构进行联合打分。

【一、模型配置】
• 算法类型: Multinomial Naive Bayes
• 词汇表大小: 50,000+ 金融领域术语
• 平滑参数(alpha): 0.1
• 训练样本: 150,000+ 条金融新闻标注数据
• 分类准确率: 78.5%

【二、新闻情绪分布】

当前价格 ¥${price.toFixed(2)}，MA5/MA20 ${ma5 > ma20 ? '金叉' : '死叉'}状态下的新闻面分析：

• 正面新闻概率: ${ma5 > ma20 ? '52%' : '38%'}
• 中性新闻概率: ${ma5 > ma20 ? '35%' : '42%'}
• 负面新闻概率: ${ma5 > ma20 ? '13%' : '20%'}
• 综合情绪标签: ${ma5 > ma20 ? '中性偏积极' : '中性偏谨慎'}
• 情绪强度指数: ${(rsi / 100 * 0.6 + 0.2).toFixed(2)} (0-1，越高越积极)

【三、信号来源拆解】

1) 公司层面：
公告语气以中性信息披露为主，${ma5 > ma20 ? '近期有利好催化因子出现' : '缺少强催化事件'}。
关键词检测：”${ma5 > ma20 ? '业绩增长、产能扩张、回购计划' : '业绩平稳、战略调整、成本控制'}”
贝叶斯概率权重: +${ma5 > ma20 ? '0.15' : '0.05'}

2) 行业层面：
政策与行业景气度${ma5 > ma20 ? '保持积极趋势' : '未出现显著拐点'}，预期${ma5 > ma20 ? '向好' : '稳定但弹性有限'}。
关键词检测：”${macd > 0 ? '政策支持、行业回暖、景气上行' : '行业调整、竞争加剧、需求放缓'}”
贝叶斯概率权重: +${macd > 0 ? '0.12' : '-0.08'}

3) 交易层面：
市场讨论热度${turnover_rate > 3 ? '较高' : '中等'}，换手率 ${turnover_rate.toFixed(2)}%。
成交量 ${(volume / 10000).toFixed(2)}万手，${volume > 0 && ma5 > ma20 ? '量价配合引发积极讨论' : '短线资金更关注价格与成交量共振'}。
贝叶斯概率权重: +${turnover_rate > 3 ? '0.10' : '0.03'}

【四、Naive Bayes 评分解读】

模型识别到”业绩、扩产、回购、政策支持”等词组时提升正向权重；识别”减持、诉讼、业绩下修、监管处罚”等词组时提升负向权重。

当前文本特征向量：
• 正向关键词命中数: ${ma5 > ma20 ? '12' : '7'}
• 负向关键词命中数: ${ma5 > ma20 ? '3' : '6'}
• 中性关键词命中数: 18
• 最终后验概率: P(利好|特征) = ${ma5 > ma20 ? '0.52' : '0.38'}

结论：当前文本集合中正负关键词比例${ma5 > ma20 ? '偏正向' : '相对均衡'}，输出${ma5 > ma20 ? '中性偏积极' : '中性偏谨慎'}结论。

【五、交易层面的应用建议】

• 若后续出现高等级利好公告，可将新闻因子作为加仓触发条件之一。
• 若出现连续负面事件且成交量放大，应将新闻信号纳入风控优先级。
• 在缺少突发事件时，不建议仅凭新闻面做重仓决策，应与技术和风险模型联动确认。
• 当前新闻面对价格 ¥${price.toFixed(2)} 的支撑强度: ${ma5 > ma20 ? '中强' : '偏弱'}

【六、风险提示】

• 新闻文本存在时效衰减，旧闻对价格影响会快速下降。
• 标题党和二手解读可能放大噪声，需优先参考原始公告。
• Naive Bayes 假设特征独立，面对复杂语义时可能低估上下文关联。`,
        keyFindings: [
          `新闻情绪: ${ma5 > ma20 ? '中性偏积极(正面52%)' : '中性偏谨慎(正面38%)'}`,
          `正向关键词: ${ma5 > ma20 ? '12个' : '7个'} vs 负向: ${ma5 > ma20 ? '3个' : '6个'}`,
          `市场讨论热度: ${turnover_rate > 3 ? '较高' : '中等'} (换手率${turnover_rate.toFixed(2)}%)`,
          `新闻面支撑: ${ma5 > ma20 ? '中强' : '偏弱'}`
        ]
      },
      risk_analyst: {
        prediction: 0,
        confidence: 0.7,
        algorithm: 'Logistic Regression',
        analysis: `你好！我是小K的风险分析师，本轮使用 Logistic Regression 模型输出可解释的风险概率。

【分析算法】Logistic Regression (逻辑回归)
Logistic Regression 通过线性可解释因子对”未来回撤风险”进行概率建模，特别适合做仓位管理和止损阈值决策。与黑盒模型不同，该方法可以直接看到每个风险因子的方向和强度，便于执行层落地。

【一、模型配置】
• 正则化: L2 (Ridge)
• 正则化强度(C): 1.0
• 求解器: lbfgs
• 最大迭代: 1000
• 训练样本: 100,000+ 条历史回撤事件

【二、核心风险因子输入】

价格风险因子：
• 当前价格: ¥${price.toFixed(2)}
• MA5/MA20乖离率: ${ma5_ma20_diff.toFixed(2)}%  系数: ${Math.abs(ma5_ma20_diff) > 3 ? '+0.35 (偏离过大)' : '+0.10 (正常)'}
• 价格/MA20偏离度: ${priceChange.toFixed(2)}%  系数: ${Math.abs(priceChange) > 5 ? '+0.40 (高偏离)' : '+0.15 (低偏离)'}
• MA60支撑距离: ${ma60 > 0 ? ((price - ma60) / ma60 * 100).toFixed(2) : '0.00'}%

动量风险因子：
• RSI: ${rsi.toFixed(2)} (${rsi > 70 ? '超买区 — 回撤风险+0.30' : rsi < 30 ? '超卖区 — 反弹概率+0.25' : '中性区间 — 风险系数+0.05'})
• MACD柱状图: ${macd_hist.toFixed(4)} (${macd_hist > 0 ? '多头' : '空头'}动能)
• MACD背离检测: ${(macd > 0 && ma5 < ma20) || (macd < 0 && ma5 > ma20) ? '存在背离 — 风险系数+0.25' : '无背离 — 风险系数+0.00'}

成交量风险因子：
• 成交量: ${(volume / 10000).toFixed(2)}万手
• 换手率: ${turnover_rate.toFixed(2)}%  ${turnover_rate > 5 ? '(异常放量 — 风险+0.20)' : turnover_rate > 3 ? '(放量 — 风险+0.10)' : '(正常 — 风险+0.05)'}

【三、逻辑回归风险评分】

模型将上述风险因子通过线性加权后经 Sigmoid 函数输出回撤概率：

风险因子加权求和(z):
z = ${Math.abs(priceChange) > 5 ? '0.40' : '0.15'} + ${rsi > 70 ? '0.30' : rsi < 30 ? '0.25' : '0.05'} + ${turnover_rate > 5 ? '0.20' : '0.05'} + ${(macd > 0 && ma5 < ma20) || (macd < 0 && ma5 > ma20) ? '0.25' : '0.00'} + bias(-0.50)

回撤概率 P(回撤>5%) = Sigmoid(z) = ${(1 / (1 + Math.exp(-(
  (Math.abs(priceChange) > 5 ? 0.40 : 0.15) +
  (rsi > 70 ? 0.30 : rsi < 30 ? 0.25 : 0.05) +
  (turnover_rate > 5 ? 0.20 : 0.05) +
  ((macd > 0 && ma5 < ma20) || (macd < 0 && ma5 > ma20) ? 0.25 : 0.00) - 0.50
))) * 100).toFixed(1)}%

风险等级: ${rsi > 70 || rsi < 30 || Math.abs(priceChange) > 5 ? '较高' : '中等'}

【四、执行层风控建议】

1) 仓位管理：
   建议仓位: ${rsi > 70 ? '30%' : rsi < 30 ? '50%' : '40%'}，避免一次性重仓。
   最大单笔风险敞口: 总资金的2%。

2) 止损管理：
   硬止损位: ¥${(price * 0.95).toFixed(2)} (-5%)
   动态止损: ¥${(price * 0.97).toFixed(2)} (-3%，趋势跟踪)
   触发后先降风险再评估。

3) 止盈管理：
   第一目标: ¥${(price * 1.05).toFixed(2)} (+5%) — 减仓1/3
   第二目标: ¥${(price * 1.10).toFixed(2)} (+10%) — 减仓1/3
   剩余仓位跟踪止盈。

4) 事件风控：关注突发公告与宏观政策窗口，必要时切换至防守模式。

【五、模型边界说明】

• Logistic Regression 对线性边界更敏感，极端行情(涨停/跌停)下需结合波动率模型补充判断。
• 风险概率不是方向预测，核心目的是控制回撤而非追求最高收益。
• 建议与技术分析师、策略分析师结果联合，构建”先风控后收益”的执行链路。
• 模型AUC: 0.74 | 精确率: 70% | 召回率: 66%`,
        keyFindings: [
          `风险等级: ${rsi > 70 || rsi < 30 || Math.abs(priceChange) > 5 ? '较高' : '中等'}`,
          `回撤概率: ${(1 / (1 + Math.exp(-((Math.abs(priceChange) > 5 ? 0.40 : 0.15) + (rsi > 70 ? 0.30 : rsi < 30 ? 0.25 : 0.05) + (turnover_rate > 5 ? 0.20 : 0.05) - 0.50))) * 100).toFixed(1)}%`,
          `建议仓位: ${rsi > 70 ? '30%' : rsi < 30 ? '50%' : '40%'}`,
          `硬止损: ¥${(price * 0.95).toFixed(2)} (-5%)`
        ]
      },
      strategy_analyst: {
        prediction: 1,
        confidence: 0.72,
        algorithm: 'Deep Neural Network',
        analysis: `你好！我是小K的策略分析师，本轮使用 Deep Neural Network (DNN) 进行多因子策略融合与执行建议输出。

【分析算法】Deep Neural Network (深度神经网络)
当前采用 4 层 DNN 结构（256-128-64-32），输入信号覆盖趋势、动量、波动、量价关系和风险约束。DNN 的优势在于能够学习非线性组合关系，不依赖单一指标，从而降低”某个指标失效导致整体误判”的风险。

【一、网络架构与配置】
• 输入层: 12维特征向量
• 隐藏层1: 256个神经元 (ReLU + BatchNorm + Dropout 0.3)
• 隐藏层2: 128个神经元 (ReLU + BatchNorm + Dropout 0.2)
• 隐藏层3: 64个神经元 (ReLU + BatchNorm)
• 输出层: 32→1 (Sigmoid)
• 优化器: Adam (lr=0.001)
• 训练轮次: 200 epochs
• 模型AUC: 0.78 | 精确率: 72% | 召回率: 70%

【二、策略输入特征向量】

当前输入到DNN的12维特征：
• [0] 趋势方向: ${ma5 > ma20 ? '1 (上升)' : '0 (下降)'}
• [1] MA5/MA20乖离: ${ma5_ma20_diff.toFixed(4)}
• [2] 价格/MA60偏离: ${ma60 > 0 ? ((price - ma60) / ma60).toFixed(4) : '0.0000'}
• [3] RSI归一化: ${(rsi / 100).toFixed(4)}
• [4] MACD: ${macd.toFixed(4)}
• [5] MACD柱状图: ${macd_hist.toFixed(4)}
• [6] 成交量(标准化): ${(volume / 10000).toFixed(2)}
• [7] 换手率: ${turnover_rate.toFixed(4)}
• [8] 动能强度: ${Math.abs(macd) > 0.5 ? '0.8 (强)' : '0.3 (弱)'}
• [9] 市场情绪代理: ${rsi > 60 ? '0.7 (乐观)' : rsi < 40 ? '0.3 (悲观)' : '0.5 (中性)'}
• [10] 价格-MA20偏离: ${(priceChange / 100).toFixed(4)}
• [11] 风险约束因子: ${rsi > 70 || rsi < 30 ? '0.8 (高风险)' : '0.3 (正常)'}

【三、DNN 输出解释】

前向传播结果：
• 买入概率(Softmax): ${ma5 > ma20 && macd > 0 ? '0.72' : ma5 < ma20 && macd < 0 ? '0.25' : '0.48'}
• 卖出概率(Softmax): ${ma5 > ma20 && macd > 0 ? '0.15' : ma5 < ma20 && macd < 0 ? '0.65' : '0.30'}
• 持有概率(Softmax): ${ma5 > ma20 && macd > 0 ? '0.13' : ma5 < ma20 && macd < 0 ? '0.10' : '0.22'}

综合信号: ${ma5 > ma20 && macd > 0 ? '买入(置信度72%)' : ma5 < ma20 && macd < 0 ? '卖出(置信度65%)' : '持有(置信度48%)'}

模型识别当前市场处于${ma5 > ma20 ? '趋势延续窗口' : '震荡修复窗口'}。与规则策略相比，DNN 对”弱趋势 + 高波动”的场景有更强识别能力，能够动态降低激进信号权重。

【四、执行层建议】

短线策略(1-5日)：
• 操作: ${ma5 > ma20 ? '回调至 ¥' + (price * 0.98).toFixed(2) + ' 附近分批吸纳' : '反弹至 ¥' + (price * 1.02).toFixed(2) + ' 附近分批减仓'}
• 止损: ¥${(price * 0.97).toFixed(2)} (-3%)
• 止盈: ¥${(price * 1.05).toFixed(2)} (+5%)

中线策略(5-20日)：
• 操作: ${macd > 0 ? '维持趋势跟随，跌破 ¥' + (price * 0.95).toFixed(2) + ' 再减仓' : '以等待确认信号为主，不抢反弹'}
• 止损: ¥${(price * 0.92).toFixed(2)} (-8%)
• 止盈: ¥${(price * 1.12).toFixed(2)} (+12%)

仓位管理：
• 建议仓位: ${rsi > 70 ? '30%' : rsi < 30 ? '60%' : '40%'}，并随波动率动态调整
• 最大单笔仓位: 总资金的20%
• 资金利用率上限: 70%

【五、策略协同建议】

各模型信号一致性检测：
• Random Forest (市场分析师): ${ma5 > ma20 ? '看多' : '看空'}
• XGBoost (技术分析师): ${rsi > 50 && macd > 0 ? '看多' : '看空'}
• DNN (策略分析师): ${ma5 > ma20 && macd > 0 ? '看多' : ma5 < ma20 && macd < 0 ? '看空' : '中性'}
• 信号一致性: ${(ma5 > ma20) === (rsi > 50 && macd > 0) ? '高(可提升执行权重)' : '低(需谨慎，降低仓位)'}

当 DNN 与风险模型冲突时，优先执行风险模型的仓位约束。
若消息面出现突发事件，应临时下调 DNN 信号置信度并人工复核。

【六、风险提示】

• DNN 对训练分布敏感，极端行情下可能出现置信度失真。
• 建议定期重训并监控样本漂移，防止策略老化。
• 任何自动化信号都应配合止损与仓位纪律执行。`,
        keyFindings: [
          `操作建议: ${ma5 > ma20 && macd > 0 ? '买入(72%)' : ma5 < ma20 && macd < 0 ? '卖出(65%)' : '持有(48%)'}`,
          `建议仓位: ${rsi > 70 ? '30%' : rsi < 30 ? '60%' : '40%'}`,
          `止损: ¥${(price * 0.95).toFixed(2)} (-5%)`,
          `信号一致性: ${(ma5 > ma20) === (rsi > 50 && macd > 0) ? '高' : '低'}`
        ]
      }
    };
  }

  /**
   * 将预测值标准化到 [0, 1]
   */
  normalizePredictionValue(value, fallback = 0.5) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return fallback;
    }
    return Math.min(Math.max(n, 0), 1);
  }

  /**
   * 基于预测概率映射投票方向
   */
  mapPredictionToVote(prediction) {
    const p = this.normalizePredictionValue(prediction, 0.5);
    if (p >= 0.6) return 'buy';
    if (p <= 0.4) return 'sell';
    return 'hold';
  }

  /**
   * 获取智能体归一化权重（基于配置中的accuracy）
   */
  getNormalizedAgentWeights(agentIds = []) {
    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      return {};
    }

    const defaultAccuracy = 0.6;
    const rawWeights = {};
    let total = 0;

    for (const agentId of agentIds) {
      const acc = Number(this.agentConfig[agentId]?.accuracy);
      const weight = Number.isFinite(acc) && acc > 0 ? acc : defaultAccuracy;
      rawWeights[agentId] = weight;
      total += weight;
    }

    if (total <= 0) {
      const equal = 1 / agentIds.length;
      return Object.fromEntries(agentIds.map((id) => [id, equal]));
    }

    return Object.fromEntries(
      Object.entries(rawWeights).map(([id, weight]) => [id, weight / total])
    );
  }

  /**
   * 加权投票融合：输出最终建议与置信度
   */
  aggregateWeightedDecision(agentResults = []) {
    const decisionScores = { buy: 0, sell: 0, hold: 0 };
    const probabilityBuckets = { buy: [], sell: [], hold: [] };

    for (const item of agentResults) {
      const vote = item.vote || this.mapPredictionToVote(item.prediction);
      const confidence = this.normalizePredictionValue(item.confidence, 0.7);
      const prediction = this.normalizePredictionValue(item.prediction, 0.5);
      const weight = Math.max(Number(item.weight) || 0, 0);
      const weightedSupport = weight * confidence;

      decisionScores[vote] += weightedSupport;

      let voteProbability = 0.5;
      if (vote === 'buy') {
        voteProbability = prediction;
      } else if (vote === 'sell') {
        voteProbability = 1 - prediction;
      } else {
        voteProbability = 1 - Math.min(Math.abs(prediction - 0.5) * 2, 1);
      }

      probabilityBuckets[vote].push({
        weightedSupport,
        voteProbability
      });
    }

    const sortedScores = Object.entries(decisionScores).sort((a, b) => b[1] - a[1]);
    const [winnerVote, winnerScore = 0] = sortedScores[0] || ['hold', 0];
    const totalScore = Object.values(decisionScores).reduce((sum, value) => sum + value, 0);
    const consensus = totalScore > 0 ? winnerScore / totalScore : 0.5;

    const weightedProbabilitySum = probabilityBuckets[winnerVote]
      .reduce((sum, item) => sum + item.weightedSupport * item.voteProbability, 0);
    const winnerProbability = winnerScore > 0 ? weightedProbabilitySum / winnerScore : 0.5;

    // 最终置信度 = 共识度 × 胜出方向的平均概率
    const finalConfidence = Math.min(Math.max(consensus * winnerProbability, 0), 1);

    const recommendationMap = {
      buy: '买入',
      sell: '卖出',
      hold: '持有'
    };

    return {
      recommendation: recommendationMap[winnerVote] || '持有',
      confidence: finalConfidence,
      vote: winnerVote,
      decisionScores,
      consensus,
      winnerProbability
    };
  }

  /**
   * 将ML预测结果转换为系统格式
   */
  formatPredictions(predictions, stockCode, stockData = {}) {
    const agentResults = [];

    const agentNames = {
      market_analyst: '市场分析师',
      technical_analyst: '技术分析师',
      fundamental_analyst: '基本面分析师',
      news_analyst: '新闻分析师',
      risk_analyst: '风险分析师',
      strategy_analyst: '策略分析师'
    };

    const agentAlgorithms = {
      market_analyst: 'Random Forest',
      technical_analyst: 'XGBoost',
      fundamental_analyst: 'LightGBM',
      news_analyst: 'Naive Bayes',
      risk_analyst: 'Logistic Regression',
      strategy_analyst: 'Deep Neural Network'
    };

    for (const [agentId, result] of Object.entries(predictions)) {
      if (result.error) {
        _dev(agentId).log('error', { action: 'predict.aggregate', detail: result.error, status: 'error' });
        continue;
      }

      // 确保confidence是0-1之间的小数
      const confidence = Math.min(Math.max(result.confidence || 0.7, 0), 1);

      // 使用模型返回分析，避免伪造默认结论
      const analysis = (result.analysis || '').trim() || '模型已返回预测值，但未提供详细分析文本。';

      const prediction = this.normalizePredictionValue(result.prediction, 0.5);

      agentResults.push({
        agentId: agentId,
        agentName: result.agent_name || agentNames[agentId] || agentId,
        algorithm: result.algorithm || agentAlgorithms[agentId],
        score: (confidence * 10).toFixed(1),
        analysis: analysis,
        keyFindings: result.keyFindings || ['模型推理完成', '请结合风控规则执行', '建议结合多信号交叉验证'],
        prediction,
        confidence: confidence,  // 保持0-1之间
        sourceStatus: result.sourceStatus || 'trained_model',
        modelFile: result.modelFile || null,
        modelVariant: result.modelVariant || result.model_variant || null
      });
    }

    // 如果没有成功的预测结果，直接抛错，避免静默伪造结果
    if (agentResults.length === 0) {
      throw this.createModelError(
        '模型推理未返回任何有效结果',
        'ML_PREDICT_EMPTY',
        { stockCode, predictions }
      );
    }

    const weights = this.getNormalizedAgentWeights(agentResults.map((item) => item.agentId));

    const weightedAgentResults = agentResults.map((item) => {
      const weight = weights[item.agentId] || 0;
      const vote = this.mapPredictionToVote(item.prediction);
      const weightedSupport = weight * item.confidence;
      return {
        ...item,
        weight: parseFloat(weight.toFixed(4)),
        vote,
        weightedSupport: parseFloat(weightedSupport.toFixed(4))
      };
    });

    const weightedDecision = this.aggregateWeightedDecision(weightedAgentResults);
    const finalConfidence = Math.min(
      Math.max(Math.round(weightedDecision.confidence * 100), 0),
      100
    );

    return {
      stockCode,
      recommendation: weightedDecision.recommendation,
      confidence: finalConfidence,  // 0-100的整数
      summary: `基于${weightedAgentResults.length}个ML智能体的加权投票，${stockCode}当前建议为${weightedDecision.recommendation}（共识度${(weightedDecision.consensus * 100).toFixed(1)}%）`,
      decisionDetail: {
        vote: weightedDecision.vote,
        scores: weightedDecision.decisionScores,
        consensus: parseFloat(weightedDecision.consensus.toFixed(4)),
        winnerProbability: parseFloat(weightedDecision.winnerProbability.toFixed(4))
      },
      agentResults: weightedAgentResults,
      isMLPowered: true,
      predictionSource: this.buildPredictionSourceStatus({
        mode: 'trained_model',
        hasFallback: false,
        trainedAgentCount: weightedAgentResults.length,
        fallbackAgentCount: 0,
        message: '本次结果全部来自真实训练模型'
      })
    };
  }

  /**
   * 格式化默认预测结果
   */
  formatDefaultPredictions(stockCode) {
    throw this.createModelError(
      '默认兜底预测已禁用。请先训练模型后重试。',
      'ML_DEFAULT_ANALYSIS_DISABLED',
      { stockCode }
    );

    const defaultAnalysis = this.getDefaultAnalysis({});
    const agentResults = [];

    const agentNames = {
      market_analyst: '市场分析师',
      technical_analyst: '技术分析师',
      fundamental_analyst: '基本面分析师',
      news_analyst: '新闻分析师',
      risk_analyst: '风险分析师',
      strategy_analyst: '策略分析师'
    };

    for (const [agentId, result] of Object.entries(defaultAnalysis)) {
      agentResults.push({
        agentId: agentId,
        agentName: agentNames[agentId] || agentId,
        score: (result.confidence * 10).toFixed(1),
        analysis: result.analysis,
        algorithm: result.algorithm,
        keyFindings: result.keyFindings || ['技术分析', '数据评估', '投资建议'],
        prediction: result.prediction,
        confidence: result.confidence,
        sourceStatus: 'fallback_rule',
        modelFile: null,
        modelVariant: null
      });
    }

    const weights = this.getNormalizedAgentWeights(agentResults.map((item) => item.agentId));
    const weightedAgentResults = agentResults.map((item) => {
      const weight = weights[item.agentId] || 0;
      const vote = this.mapPredictionToVote(item.prediction);
      const weightedSupport = weight * item.confidence;
      return {
        ...item,
        weight: parseFloat(weight.toFixed(4)),
        vote,
        weightedSupport: parseFloat(weightedSupport.toFixed(4))
      };
    });

    const weightedDecision = this.aggregateWeightedDecision(weightedAgentResults);
    const finalConfidence = Math.min(
      Math.max(Math.round(weightedDecision.confidence * 100), 0),
      100
    );

    return {
      stockCode,
      recommendation: weightedDecision.recommendation,
      confidence: finalConfidence,
      summary: `基于规则引擎的加权投票，${stockCode}当前建议为${weightedDecision.recommendation}`,
      decisionDetail: {
        vote: weightedDecision.vote,
        scores: weightedDecision.decisionScores,
        consensus: parseFloat(weightedDecision.consensus.toFixed(4)),
        winnerProbability: parseFloat(weightedDecision.winnerProbability.toFixed(4))
      },
      agentResults: weightedAgentResults,
      isMLPowered: false,
      predictionSource: this.buildPredictionSourceStatus({
        mode: 'fallback_rule',
        hasFallback: true,
        trainedAgentCount: 0,
        fallbackAgentCount: weightedAgentResults.length,
        message: '当前结果来自规则兜底，不是训练模型推理'
      })
    };
  }
}

module.exports = new MLAgentService();
