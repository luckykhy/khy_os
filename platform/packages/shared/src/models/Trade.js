/**
 * 交易模型（Trade） —— 交易记录实体
 *
 * 数据库表：trades（对应论文表19）
 * E-R 关系（论文图4/图8）：
 *   Trade N:1 User（交易归属于用户）
 *   Trade N:1 Strategy（交易可关联到策略，支持可追溯性）
 *
 * 字段说明：
 *   side: 'buy' | 'sell' —— 交易方向
 *   type: 'backtest' | 'paper' | 'live' —— 交易类型（回测/模拟/实盘）
 *   profit: 实际盈亏金额
 *
 * 可追溯性：通过 strategy_id 外键，可以从交易记录反查到策略代码、
 *   回测数据和AI建议，实现论文第3.3节所述的"数据同源"链路。
 *
 * 对应论文：第4.6节（数据库设计），表19
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Trade = sequelize.define('Trade', {
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
    comment: '策略ID（可选）'
  },
  symbol: {
    type: DataTypes.STRING(20),
    allowNull: false,
    comment: '交易标的代码'
  },
  side: {
    type: DataTypes.ENUM('buy', 'sell'),
    allowNull: false,
    comment: '交易方向：buy-买入，sell-卖出'
  },
  quantity: {
    type: DataTypes.DECIMAL(15, 4),
    allowNull: false,
    comment: '交易数量'
  },
  price: {
    type: DataTypes.DECIMAL(15, 4),
    allowNull: false,
    comment: '交易价格'
  },
  amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    comment: '交易金额'
  },
  status: {
    type: DataTypes.ENUM('pending', 'filled', 'cancelled', 'rejected'),
    defaultValue: 'pending',
    comment: '状态：pending-待成交，filled-已成交，cancelled-已取消，rejected-已拒绝'
  },
  type: {
    type: DataTypes.ENUM('backtest', 'paper', 'live'),
    defaultValue: 'paper',
    comment: '交易类型：backtest-回测，paper-模拟，live-实盘'
  },
  orderType: {
    type: DataTypes.STRING(20),
    defaultValue: 'limit',
    field: 'order_type',
    comment: '订单类型：limit-限价单，market-市价单，counterparty-对手价，queue-排队价，best5-最优五档，bestOwn-最优本方，twap-TWAP算法，vwap-VWAP算法，strategy-策略下单'
  },
  isFutures: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    field: 'is_futures',
    comment: '是否期货交易'
  },
  offset: {
    type: DataTypes.STRING(10),
    comment: '期货开平仓方向：open-开仓，close-平仓'
  },
  filledAt: {
    type: DataTypes.DATE,
    field: 'filled_at', // 映射到数据库中的实际字段名
    comment: '成交时间'
  },
  isClosed: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    field: 'is_closed',
    comment: '是否已平仓'
  },
  closedAt: {
    type: DataTypes.DATE,
    field: 'closed_at',
    comment: '平仓时间'
  },
  closedQuantity: {
    type: DataTypes.DECIMAL(15, 4),
    field: 'closed_quantity',
    comment: '平仓数量'
  },
  relatedTradeId: {
    type: DataTypes.INTEGER,
    field: 'related_trade_id',
    comment: '关联交易ID（用于部分平仓）'
  },
  profit: {
    type: DataTypes.DECIMAL(15, 2),
    comment: '实际盈亏（平仓后）'
  }
}, {
  tableName: 'trades',
  timestamps: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['symbol'] },
    { fields: ['status'] },
    { fields: ['user_id', 'status'] },
    { fields: ['user_id', 'symbol'] }
  ]
});

module.exports = Trade;
