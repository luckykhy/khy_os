/**
 * 修复 instruments 表的 name 字段，允许为 NULL
 * 
 * 问题：从AData获取的数据中没有name字段，导致插入失败
 * 解决：将name字段改为允许NULL
 * @pattern Command
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    console.log('🔧 开始修改 instruments 表的 name 字段...');
    
    try {
      // 修改 name 字段，允许为 NULL
      await queryInterface.changeColumn('instruments', 'name', {
        type: Sequelize.STRING(100),
        allowNull: true,  // 允许为空
        comment: '标的名称（可选）'
      });
      
      console.log('✅ name 字段已修改为允许 NULL');
    } catch (error) {
      console.error('❌ 修改失败:', error.message);
      throw error;
    }
  },

  down: async (queryInterface, Sequelize) => {
    console.log('🔧 回滚 instruments 表的 name 字段...');
    
    try {
      // 回滚：将 name 字段改回不允许 NULL
      await queryInterface.changeColumn('instruments', 'name', {
        type: Sequelize.STRING(100),
        allowNull: false,  // 不允许为空
        comment: '标的名称'
      });
      
      console.log('✅ name 字段已回滚为不允许 NULL');
    } catch (error) {
      console.error('❌ 回滚失败:', error.message);
      throw error;
    }
  }
};
