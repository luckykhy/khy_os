/**
 * 创建K线数据缓存表
 * 用于缓存从数据源获取的历史K线数据，避免重复请求
 * @pattern Command
 */

const { Sequelize } = require('sequelize');

async function up(queryInterface) {
  await queryInterface.createTable('kline_cache', {
    id: {
      type: Sequelize.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    symbol: {
      type: Sequelize.STRING(20),
      allowNull: false,
      comment: '标的代码，如sh000300'
    },
    period: {
      type: Sequelize.STRING(10),
      allowNull: false,
      defaultValue: 'daily',
      comment: '周期：daily, weekly, monthly'
    },
    trade_date: {
      type: Sequelize.DATEONLY,
      allowNull: false,
      comment: '交易日期'
    },
    open: {
      type: Sequelize.DECIMAL(20, 4),
      allowNull: false,
      comment: '开盘价'
    },
    high: {
      type: Sequelize.DECIMAL(20, 4),
      allowNull: false,
      comment: '最高价'
    },
    low: {
      type: Sequelize.DECIMAL(20, 4),
      allowNull: false,
      comment: '最低价'
    },
    close: {
      type: Sequelize.DECIMAL(20, 4),
      allowNull: false,
      comment: '收盘价'
    },
    volume: {
      type: Sequelize.BIGINT,
      allowNull: true,
      comment: '成交量'
    },
    amount: {
      type: Sequelize.DECIMAL(30, 2),
      allowNull: true,
      comment: '成交额'
    },
    data_source: {
      type: Sequelize.STRING(50),
      allowNull: true,
      comment: '数据来源：adata, efinance, akshare等'
    },
    created_at: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
    },
    updated_at: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
    }
  });

  // 创建复合唯一索引：同一标的、同一周期、同一日期只能有一条记录
  await queryInterface.addIndex('kline_cache', ['symbol', 'period', 'trade_date'], {
    unique: true,
    name: 'idx_kline_unique'
  });

  // 创建查询索引：按标的和日期范围查询
  await queryInterface.addIndex('kline_cache', ['symbol', 'period', 'trade_date'], {
    name: 'idx_kline_query'
  });

  // 创建数据源索引
  await queryInterface.addIndex('kline_cache', ['data_source'], {
    name: 'idx_kline_source'
  });

  console.log('✅ K线缓存表创建成功');
}

async function down(queryInterface) {
  await queryInterface.dropTable('kline_cache');
  console.log('✅ K线缓存表已删除');
}

module.exports = { up, down };
