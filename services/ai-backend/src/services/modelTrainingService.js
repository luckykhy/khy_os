/**
 * modelTrainingService.js (ai-backend) — thin forwarding layer.
 *
 * 历史问题：ai-backend 各服务各自 `path.join(os.homedir(), '.khyquant')` 直写
 * legacy 目录，而主 backend 经 resolveTrainingDir() 已收敛到 dataHome
 * （KHY_TRAINING_DIR env → dataHome/training → legacy → tmpdir）。同一守护进程
 * 内两套 modelTrainingService 各写一份数据 → 训练数据分裂。ai-backend 版还是
 * 旧简化拷贝：写死 .khyquant、`spawn('python3')`、缺 backend 版 13 个能力
 * （curateDataset / evaluateModel / 自动回滚 / 配方快照 / 结构化日志 / 新模型
 * 通知 / abliterateModel 等）。
 *
 * 收敛方式：与 utils/dataHome.js、constants/serviceDefaults.js 的转发先例一致，
 * 整个模块直接 require 主 backend 的单一真源。ai-backend 侧生产代码此前零引用
 * 本实现（仅 test/modelTrainingService.fetch.test.js 引用，且它需要的 API
 * backend 版全有），故转发即可，无独有 API 需保留。
 *
 * 路径：services/ai-backend/src/services → ../../../backend/src/services
 *       = services/backend/src/services/modelTrainingService
 */
const path = require('path');

module.exports = require(path.resolve(__dirname, '../../../backend/src/services/modelTrainingService'));
