/**
 * Training & model management CLI handlers:
 *   compute, train, models (Ollama), khymodel.
 */
const path = require('path');
const chalk = (() => { const c = require('chalk'); return c.default || c; })();
const { printError, printInfo, printSuccess, printWarn, printTable } = require('../formatters');

// ────────────────────────────────────────────────
// compute — show local hardware / compute status
// ────────────────────────────────────────────────
async function handleCompute() {
  const training = require('../../services/modelTrainingService');
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
}

// ────────────────────────────────────────────────
// train — model training lifecycle
// ────────────────────────────────────────────────
async function handleTrain(subCommand, args, options) {
  const training = require('../../services/modelTrainingService');

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
      return;
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
      return;
    }
    printInfo(`学生模型: ${studentBase}, 使用已记录的对话作为蒸馏素材`);
    printInfo('蒸馏过程较长，请耐心等待...');
    // Extract prompts from saved interactions for distillation
    printInfo('功能就绪，需要 Python 环境支持。详见: compute');

  } else if (subCommand === 'export') {
    const modelName = args[0];
    if (!modelName) { printError('用法: train export <模型名> [--format gguf|safetensors]'); return; }
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
    if (!modelName) { printError('用法: train upload <模型名> --platform github|gitee --repo <仓库名> [--token xxx]'); return; }
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
}

// ────────────────────────────────────────────────
// models — Ollama model management
// ────────────────────────────────────────────────
async function handleModels(subCommand, args, options) {
  const mgr = require('../../services/ollamaModelManager');
  const fs = require('fs');
  const envPath = path.resolve(__dirname, '../../../.env');

  const setEnvVar = (key, value) => {
    let envContent = '';
    try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch { /* no .env */ }
    const regex = new RegExp(`^${key}=.*$`, 'm');
    const line = `${key}=${value}`;
    if (regex.test(envContent)) envContent = envContent.replace(regex, line);
    else envContent = envContent.trimEnd() + '\n' + line + '\n';
    fs.writeFileSync(envPath, envContent);
    process.env[key] = String(value);
  };

  if (subCommand === 'list' || !subCommand) {
    const running = await mgr.isOllamaRunning();
    if (!running) { printError('Ollama 未运行。请先执行: ollama serve'); return; }
    const models = await mgr.listModels();
    if (!models.length) { printInfo('暂无已安装模型'); return; }
    printTable(
      ['模型', '大小', '参数量', '量化'],
      models.map(m => [m.name, m.size, m.paramSize || '-', m.quantization || '-'])
    );
    return;
  }

  if (subCommand === 'pull') {
    const modelId = args[0];
    if (!modelId) { printError('用法: models pull <model-id>'); return; }
    const running = await mgr.isOllamaRunning();
    if (!running) { printError('Ollama 未运行。请先执行: ollama serve'); return; }
    printInfo(`开始下载: ${modelId}`);
    await mgr.pullModel(modelId, (progress) => {
      if (progress.total > 0 && process.stdout.isTTY) {
        process.stdout.write(`\r  ⟳ ${progress.status} ${progress.percent}%`);
      }
    });
    console.log('');
    printSuccess(`下载完成: ${modelId}`);
    return;
  }

  if (subCommand === 'import') {
    const sourcePath = args[0];
    const modelName = args[1] || options.name || '';
    if (!sourcePath) {
      printError('用法: models import <path> [model-name] [--base qwen2.5:7b]');
      printInfo('支持: .gguf 文件 / safetensors 模型目录 / .safetensors adapter');
      return;
    }
    const running = await mgr.isOllamaRunning();
    if (!running) { printError('Ollama 未运行。请先执行: ollama serve'); return; }
    const result = await mgr.importModel(sourcePath, modelName, {
      base: options.base,
      systemPrompt: options.system,
      temperature: options.temperature,
      topP: options.top_p || options.topP,
      numCtx: options.num_ctx || options.numCtx,
    });
    if (!result.success) {
      printError(`导入失败: ${result.error}`);
      if (result.sourceKind === 'adapter') {
        printInfo('adapter 导入需要 --base，例如: models import ./adapter.safetensors mymodel --base qwen2.5:7b');
      }
      return;
    }
    printSuccess(`导入成功: ${result.model} (${result.sourceKind})`);
    if (options.use || options.select) {
      setEnvVar('GATEWAY_PREFERRED_ADAPTER', 'ollama');
      setEnvVar('GATEWAY_PREFERRED_STRICT', 'true');
      setEnvVar('OLLAMA_MODEL', result.model);
      try {
        const gateway = require('../../services/gateway/aiGateway');
        await gateway.refreshAdapters();
      } catch { /* best effort */ }
      printSuccess(`已切换为默认模型: ollama/${result.model}`);
    } else {
      printInfo(`可运行: models set ${result.model}`);
    }
    return;
  }

  if (subCommand === 'set') {
    const modelId = args[0];
    if (!modelId) { printError('用法: models set <model-id>'); return; }
    setEnvVar('GATEWAY_PREFERRED_ADAPTER', 'ollama');
    setEnvVar('GATEWAY_PREFERRED_STRICT', 'true');
    setEnvVar('OLLAMA_MODEL', modelId);
    try {
      const gateway = require('../../services/gateway/aiGateway');
      await gateway.refreshAdapters();
    } catch { /* best effort */ }
    printSuccess(`已设置默认模型: ollama/${modelId}`);
    return;
  }

  if (subCommand === 'delete') {
    const modelId = args[0];
    if (!modelId) { printError('用法: models delete <model-id>'); return; }
    const running = await mgr.isOllamaRunning();
    if (!running) { printError('Ollama 未运行。请先执行: ollama serve'); return; }
    const ok = await mgr.deleteModel(modelId);
    if (ok) printSuccess(`已删除模型: ${modelId}`);
    else printError(`删除失败: ${modelId}`);
    return;
  }

  printError(`未知子命令: ${subCommand}`);
  printInfo('可用: models list|pull|import|delete|set');
}

// ────────────────────────────────────────────────
// khymodel — unified model discovery & import
// ────────────────────────────────────────────────
async function handleKhyModel(subCommand, args, options) {
  const modelImport = require('../../services/modelImportService');

  if (subCommand === 'list' || !subCommand) {
    printInfo('正在扫描所有模型...');
    const all = await modelImport.listAllModels();

    // KHY/Ollama imported models
    if (all.khyModels.length) {
      printSuccess(`KHY/Ollama 已导入模型 (${all.khyModels.length})`);
      printTable(
        ['模型', '大小', '架构', '量化', '来源'],
        all.khyModels.map(m => [m.name, m.size, m.family || '-', m.quantization || '-', m.source || 'ollama'])
      );
    } else {
      printInfo('KHY/Ollama 已导入模型: 无');
    }

    // Local model files
    if (all.localModels.length) {
      console.log('');
      printInfo(`本地模型文件 (${all.localModels.length})`);
      printTable(
        ['名称', '大小', '格式', '位置', '状态'],
        all.localModels.map(m => [
          m.name,
          m.sizeStr,
          m.format,
          m.location,
          m.imported ? '✓ 已导入' : '✗ 未导入',
        ])
      );
      const unimported = all.localModels.filter(m => !m.imported);
      if (unimported.length) {
        printInfo(`提示: ${unimported.length} 个模型未导入，可使用 khymodel import <序号> 或 models import <path> 导入`);
      }
    } else {
      printInfo('未发现本地模型文件');
    }

    // IDE models
    if (all.ideModels && all.ideModels.length) {
      console.log('');
      printInfo(`IDE 可用模型 (${all.ideModels.length})`);
      printTable(
        ['模型', '来源IDE', '路由地址'],
        all.ideModels.map(m => [m.name, m.source, m.route])
      );
      const { resolveLocalProxyOpenAiBaseUrl } = require('../../utils/proxyBaseUrl');
      printInfo(`提示: 可通过 gateway proxy 将这些模型伪装为 OpenAI API (${resolveLocalProxyOpenAiBaseUrl()})`);
    }

    return;
  }

  if (subCommand === 'import') {
    const sourcePath = args[0];
    if (!sourcePath) {
      printError('用法: khymodel import <path|url> [model-name]');
      printInfo('支持: .gguf / .safetensors / .zip / 模型目录 / 下载URL');
      return;
    }
    printInfo(`正在导入: ${sourcePath}`);
    const result = await modelImport.importModel(sourcePath, { name: args[1] || '' });
    if (result.success) {
      printSuccess(`导入成功: ${result.model} (${result.sourceKind})`);
      if (result.steps) printInfo(`步骤: ${result.steps.join(' → ')}`);
    } else {
      printError(`导入失败: ${result.error}`);
      if (result.steps) printInfo(`步骤: ${result.steps.join(' → ')}`);
    }
    return;
  }

  if (subCommand === 'export') {
    const modelName = args[0];
    if (!modelName) {
      printError('用法: khymodel export <ollama-model-name> [dest-dir]');
      printInfo('从 Ollama 导出模型到 KHY 本地模型目录');
      return;
    }
    printInfo(`正在从 Ollama 导出: ${modelName}`);
    const result = await modelImport.exportFromOllama(modelName, args[1]);
    if (result.success) {
      printSuccess(`导出成功: ${result.path} (${result.sizeMB} MB)`);
    } else {
      printError(`导出失败: ${result.error}`);
    }
    return;
  }

  if (subCommand === 'scan') {
    printInfo('正在扫描本地模型文件...');
    const localFiles = modelImport.discoverLocalModels();
    if (!localFiles.length) { printInfo('未发现模型文件'); return; }
    printTable(
      ['名称', '大小', '格式', '位置', '路径'],
      localFiles.map(m => [
        m.name,
        m.sizeMB > 1024 ? `${(m.sizeMB / 1024).toFixed(1)} GB` : `${m.sizeMB} MB`,
        m.format,
        m.location,
        m.path.length > 60 ? '...' + m.path.slice(-57) : m.path,
      ])
    );
    return;
  }

  printError(`未知子命令: ${subCommand}`);
  printInfo('可用: khymodel list|import|export|scan');
}

module.exports = { handleCompute, handleTrain, handleModels, handleKhyModel };
