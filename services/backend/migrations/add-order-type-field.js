/**
 * @pattern Command
 */
const { sequelize } = require('../src/config/database');
const { QueryTypes } = require('sequelize');

async function addOrderTypeField() {
  try {
    console.log('🔧 开始添加 order_type 字段...');

    // 检查字段是否已存在
    const [columns] = await sequelize.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'trades' 
      AND column_name = 'order_type'
    `, { type: QueryTypes.SELECT });

    if (columns) {
      console.log('✅ order_type 字段已存在，跳过');
      return;
    }

    // 添加 order_type 字段（PostgreSQL 语法）
    await sequelize.query(`
      ALTER TABLE trades 
      ADD COLUMN order_type VARCHAR(20) DEFAULT 'limit'
    `);
    
    // 添加字段注释（PostgreSQL 使用 COMMENT ON COLUMN）
    await sequelize.query(`
      COMMENT ON COLUMN trades.order_type IS '订单类型：limit-限价单，market-市价单，counterparty-对手价，queue-排队价，best5-最优五档，bestOwn-最优本方，twap-TWAP算法，vwap-VWAP算法，strategy-策略下单'
    `);

    console.log('✅ order_type 字段添加成功');

    // 添加 is_futures 字段
    const [futuresColumn] = await sequelize.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'trades' 
      AND column_name = 'is_futures'
    `, { type: QueryTypes.SELECT });

    if (!futuresColumn) {
      await sequelize.query(`
        ALTER TABLE trades 
        ADD COLUMN is_futures BOOLEAN DEFAULT false
      `);
      
      await sequelize.query(`
        COMMENT ON COLUMN trades.is_futures IS '是否期货交易'
      `);
      
      console.log('✅ is_futures 字段添加成功');
    } else {
      console.log('✅ is_futures 字段已存在，跳过');
    }

    // 添加 offset 字段（期货开平仓方向）
    const [offsetColumn] = await sequelize.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'trades' 
      AND column_name = 'offset'
    `, { type: QueryTypes.SELECT });

    if (!offsetColumn) {
      await sequelize.query(`
        ALTER TABLE trades 
        ADD COLUMN "offset" VARCHAR(10)
      `);
      
      await sequelize.query(`
        COMMENT ON COLUMN trades."offset" IS '期货开平仓方向：open-开仓，close-平仓'
      `);
      
      console.log('✅ offset 字段添加成功');
    } else {
      console.log('✅ offset 字段已存在，跳过');
    }

    console.log('🎉 所有字段添加完成！');

  } catch (error) {
    console.error('❌ 添加字段失败:', error);
    throw error;
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  addOrderTypeField()
    .then(() => {
      console.log('✅ 迁移完成');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ 迁移失败:', error);
      process.exit(1);
    });
}

module.exports = addOrderTypeField;
