/**
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const isSqlite = sequelize.getDialect && sequelize.getDialect() === 'sqlite';
const jsonType = isSqlite ? DataTypes.JSON : DataTypes.JSONB;

const Backtest = sequelize.define('Backtest', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: '用户ID'
  },
  strategy_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: '策略ID'
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
    comment: '回测名称'
  },
  startDate: {
    type: DataTypes.DATE,
    allowNull: false,
    comment: '回测开始日期'
  },
  endDate: {
    type: DataTypes.DATE,
    allowNull: false,
    comment: '回测结束日期'
  },
  initialCapital: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 100000,
    comment: '初始资金'
  },
  finalCapital: {
    type: DataTypes.DECIMAL(15, 2),
    comment: '最终资金'
  },
  totalReturn: {
    type: DataTypes.DECIMAL(10, 4),
    comment: '总收益率'
  },
  annualizedReturn: {
    type: DataTypes.DECIMAL(10, 4),
    comment: '年化收益率'
  },
  maxDrawdown: {
    type: DataTypes.DECIMAL(10, 4),
    comment: '最大回撤'
  },
  totalTrades: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    comment: '总交易次数'
  },
  winningTrades: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    comment: '盈利交易次数'
  },
  losingTrades: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    comment: '亏损交易次数'
  },
  winRate: {
    type: DataTypes.DECIMAL(5, 2),
    comment: '胜率'
  },
  symbols: isSqlite ? {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: '[]',
    comment: '交易标的（股票代码数组，SQLite 以 JSON 字符串存储）',
    get() {
      const raw = this.getDataValue('symbols');
      if (Array.isArray(raw)) return raw;
      try {
        return JSON.parse(raw || '[]');
      } catch (error) {
        return [];
      }
    },
    set(value) {
      const normalized = Array.isArray(value) ? value : [];
      this.setDataValue('symbols', JSON.stringify(normalized));
    }
  } : {
    type: DataTypes.ARRAY(DataTypes.STRING),
    allowNull: false,
    comment: '交易标的（股票代码数组）'
  },
  trades: {
    type: jsonType,
    defaultValue: [],
    comment: '交易记录'
  },
  signals: {
    type: jsonType,
    defaultValue: [],
    comment: '信号记录'
  },
  parameters: {
    type: jsonType,
    defaultValue: {},
    comment: '策略参数'
  },
  results: {
    type: jsonType,
    defaultValue: {},
    comment: '回测结果（JSON格式）'
  },
  status: {
    type: DataTypes.ENUM('pending', 'running', 'completed', 'failed'),
    defaultValue: 'pending',
    comment: '状态：pending-待执行，running-运行中，completed-已完成，failed-失败'
  },
  errorMessage: {
    type: DataTypes.TEXT,
    comment: '错误信息'
  }
}, {
  tableName: 'backtests',
  timestamps: true,
  underscored: true
});

module.exports = Backtest;
