/**
 * Model Registry & Entity Relationships
 *
 * Defines the six core entities described in the thesis E-R diagram
 * (Chapter 4, Tables 16-21): User, Strategy, Backtest, Trade,
 * KlineCache, and AISuggestion.  Plus auxiliary entities for
 * announcements, feedback, watchlists, and system settings.
 *
 * Relationship chain: User -> Strategy -> Backtest -> Trade
 *                     User -> AISuggestion
 *                     KlineCache (standalone, composite key on symbol+period+date)
 * @pattern Facade
 */
const { sequelize } = require('../config/database');
const User = require('./User');
const Strategy = require('./Strategy');
const Backtest = require('./Backtest');
const Trade = require('./Trade');
const AISuggestion = require('./AISuggestion');
const Announcement = require('./Announcement');
const AnnouncementRead = require('./AnnouncementRead');
const Feedback = require('./Feedback');
const UserLog = require('./UserLog');
const Watchlist = require('./Watchlist');
const MarketData = require('./MarketData');
const SystemSetting = require('./SystemSetting');
const KlineCache = require('./KlineCache');
const Instrument = require('./Instrument');
const KlineData = require('./KlineData');
const UserFavorite = require('./UserFavorite');
const BankTransfer = require('./BankTransfer');
const Signal = require('./Signal');
const ApiKey = require('./ApiKey');
const AIAccount = require('./AIAccount');
const UserGatewayConfig = require('./UserGatewayConfig');
const UserProvider = require('./UserProvider');
const UserProviderModel = require('./UserProviderModel');
const UserWorkflow = require('./UserWorkflow');
const WorkflowRun = require('./WorkflowRun');
const Conversation = require('./Conversation');
const UserProject = require('./UserProject');
const PromptTemplate = require('./PromptTemplate');
const MarketplacePlugin = require('./MarketplacePlugin');
const UserInstalledPlugin = require('./UserInstalledPlugin');

// 定义关联关系
User.hasMany(Strategy, { foreignKey: 'user_id', as: 'strategies' });
Strategy.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

User.hasMany(Backtest, { foreignKey: 'user_id', as: 'backtests' });
Backtest.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

Strategy.hasMany(Backtest, { foreignKey: 'strategy_id', as: 'backtests' });
Backtest.belongsTo(Strategy, { foreignKey: 'strategy_id', as: 'strategy' });

User.hasMany(Trade, { foreignKey: 'user_id', as: 'trades' });
Trade.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

Strategy.hasMany(Trade, { foreignKey: 'strategy_id', as: 'trades' });
Trade.belongsTo(Strategy, { foreignKey: 'strategy_id', as: 'strategy' });

User.hasMany(AISuggestion, { foreignKey: 'user_id', as: 'aiSuggestions' });
AISuggestion.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

User.hasMany(Announcement, { foreignKey: 'author_id', as: 'announcements' });
Announcement.belongsTo(User, { foreignKey: 'author_id', as: 'author' });

User.hasMany(AnnouncementRead, { foreignKey: 'user_id', as: 'announcementReads' });
AnnouncementRead.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

Announcement.hasMany(AnnouncementRead, { foreignKey: 'announcement_id', as: 'reads' });
AnnouncementRead.belongsTo(Announcement, { foreignKey: 'announcement_id', as: 'announcement' });

// Feedback 关联关系
User.hasMany(Feedback, { foreignKey: 'userId', as: 'feedbacks' });
Feedback.belongsTo(User, { foreignKey: 'userId', as: 'user' });

User.hasMany(Feedback, { foreignKey: 'adminId', as: 'adminFeedbacks' });
Feedback.belongsTo(User, { foreignKey: 'adminId', as: 'admin' });

// UserLog 关联关系
User.hasMany(UserLog, { foreignKey: 'userId', as: 'logs' });
UserLog.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Watchlist 关联关系
User.hasMany(Watchlist, { foreignKey: 'userId', as: 'watchlists' });
Watchlist.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// BankTransfer 关联关系
User.hasMany(BankTransfer, { foreignKey: 'userId', as: 'bankTransfers' });
BankTransfer.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Signal 关联关系
User.hasMany(Signal, { foreignKey: 'user_id', as: 'signals' });
Signal.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// ApiKey 关联关系
User.hasMany(ApiKey, { foreignKey: 'user_id', as: 'apiKeys' });
ApiKey.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// 多租户网关：每用户独立 relay 配置 + custom provider/key 池。
// constraints:false —— 与 Conversation / UserInstalledPlugin 同理（见下文 sentinel 0
// 说明）。本地单机 / 可信网络旁路模式下 user_id 为哨兵 0（无对应 users 行），若强制
// DB 级外键，则添加 / 替换 Key（UserProvider.create）会在 SQLite FK 检查下报
// "FOREIGN KEY constraint failed"，而读路径已由 .sync() 建表得以成功——表现为
// 「系统已经配置 sk 管理看不见，没法替换」（列表/总览看似为空，写入全部 500）。
// 隔离由各 service 的 where:{userId} 保证，逻辑关联仍保留用于 include 预加载。
User.hasOne(UserGatewayConfig, { foreignKey: 'user_id', as: 'gatewayConfig', constraints: false });
UserGatewayConfig.belongsTo(User, { foreignKey: 'user_id', as: 'user', constraints: false });

User.hasMany(UserProvider, { foreignKey: 'user_id', as: 'gatewayProviders', constraints: false });
UserProvider.belongsTo(User, { foreignKey: 'user_id', as: 'user', constraints: false });

// 每用户已探测/已添加的模型（自有上游 /v1/models 结果或手动录入的持久化家）
User.hasMany(UserProviderModel, { foreignKey: 'user_id', as: 'providerModels', constraints: false });
UserProviderModel.belongsTo(User, { foreignKey: 'user_id', as: 'user', constraints: false });

// 可视化工作流：每用户独立的拖拽工作流图
User.hasMany(UserWorkflow, { foreignKey: 'user_id', as: 'workflows' });
UserWorkflow.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// 工作流运行记录：跨进程执行队列（ai-backend 入队，backend 消费）
User.hasMany(WorkflowRun, { foreignKey: 'user_id', as: 'workflowRuns' });
WorkflowRun.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
UserWorkflow.hasMany(WorkflowRun, { foreignKey: 'workflow_id', as: 'runs' });
WorkflowRun.belongsTo(UserWorkflow, { foreignKey: 'workflow_id', as: 'workflow' });

// AI 对话历史：每用户独立的 Web 聊天会话（侧栏列表 + 全量转录持久化）。
// constraints:false —— 不生成 DB 级外键。本地单机/可信网络旁路模式下 user_id 为
// 哨兵 0（无对应 users 行），若强制外键会让单机「本机主人」场景持久化失败；隔离由
// conversationStore 的 where:{userId} 保证，逻辑关联仍保留（可用于 include 预加载）。
User.hasMany(Conversation, { foreignKey: 'user_id', as: 'conversations', constraints: false });
Conversation.belongsTo(User, { foreignKey: 'user_id', as: 'user', constraints: false });

// 编码项目工作区：每用户命名的多文件夹工作区（对齐 Hermes v0.18.0 桌面 coding projects）。
// 对话可经 Conversation.project_id 归属某项目；侧栏按当前项目过滤。constraints:false —— 与
// Conversation 同理，单机/可信网络旁路模式下 user_id 可能为哨兵 0（无对应 users 行），隔离
// 由 projectStore 的 where:{userId} 保证，逻辑关联保留用于 include 预加载。
User.hasMany(UserProject, { foreignKey: 'user_id', as: 'projects', constraints: false });
UserProject.belongsTo(User, { foreignKey: 'user_id', as: 'user', constraints: false });

// 提示词库：每用户独立的提示词集合（手动保存 + AI 自动发现待审核）。
// constraints:false —— 与 Conversation 同理，单机/可信网络旁路模式下 user_id 可能为
// 哨兵 0（无对应 users 行），若强制外键会让本机主人场景持久化失败；隔离由
// promptStore 的 where:{userId} 保证，逻辑关联保留用于 include 预加载。
User.hasMany(PromptTemplate, { foreignKey: 'user_id', as: 'promptTemplates', constraints: false });
PromptTemplate.belongsTo(User, { foreignKey: 'user_id', as: 'user', constraints: false });

// Coze 兼容插件市场：MarketplacePlugin = 共享目录（官方内置 + 用户上架）；
// UserInstalledPlugin = 每用户安装（轻量链接 + 加密鉴权配置）。插件无状态 HTTP
// 工具，安装不深拷贝目录行。constraints:false —— 与 Conversation 同理，单机/可
// 信网络旁路模式下 user_id 可能为哨兵 0（无对应 users 行），隔离由 where:{userId}
// 保证；逻辑关联保留用于 include 预加载。
User.hasMany(UserInstalledPlugin, { foreignKey: 'user_id', as: 'installedPlugins', constraints: false });
UserInstalledPlugin.belongsTo(User, { foreignKey: 'user_id', as: 'user', constraints: false });
MarketplacePlugin.hasMany(UserInstalledPlugin, { foreignKey: 'plugin_id', as: 'installations', constraints: false });
UserInstalledPlugin.belongsTo(MarketplacePlugin, { foreignKey: 'plugin_id', as: 'plugin', constraints: false });

module.exports = {
  sequelize,
  User,
  Strategy,
  Backtest,
  Trade,
  AISuggestion,
  Announcement,
  AnnouncementRead,
  Feedback,
  UserLog,
  Watchlist,
  MarketData,
  SystemSetting,
  KlineCache,
  Instrument,
  KlineData,
  UserFavorite,
  BankTransfer,
  Signal,
  ApiKey,
  AIAccount,
  UserGatewayConfig,
  UserProvider,
  UserProviderModel,
  UserWorkflow,
  WorkflowRun,
  Conversation,
  UserProject,
  PromptTemplate,
  MarketplacePlugin,
  UserInstalledPlugin
};
