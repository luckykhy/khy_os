/**
 * 标的列表控制器
 * 提供标的数据的API接口
 */
const instrumentService = require('../services/instrumentService');

class InstrumentController {
  /**
   * 获取标的列表
   * GET /api/instruments
   */
  async getInstruments(req, res) {
    try {
      const {
        type,
        category,
        status = 'active',
        limit = 100,
        offset = 0,
        search
      } = req.query;
      
      console.log('📋 获取标的列表:', { type, category, status, limit, offset, search });
      
      const result = await instrumentService.getInstruments({
        type,
        category,
        status,
        limit: parseInt(limit),
        offset: parseInt(offset),
        search
      });
      
      res.json({
        success: true,
        data: result,
        message: '获取成功'
      });
      
    } catch (error) {
      console.error('❌ 获取标的列表失败:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: '获取标的列表失败'
      });
    }
  }
  
  /**
   * 获取单个标的
   * GET /api/instruments/:symbol
   */
  async getInstrument(req, res) {
    try {
      const { symbol } = req.params;
      
      const instrument = await instrumentService.getInstrumentBySymbol(symbol);
      
      if (!instrument) {
        return res.status(404).json({
          success: false,
          message: '标的不存在'
        });
      }
      
      res.json({
        success: true,
        data: instrument,
        message: '获取成功'
      });
      
    } catch (error) {
      console.error('❌ 获取标的失败:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: '获取标的失败'
      });
    }
  }
  
  /**
   * 手动同步标的列表
   * POST /api/instruments/sync
   */
  async syncInstruments(req, res) {
    try {
      console.log('🔄 开始手动同步标的列表...');
      
      const result = await instrumentService.syncInstrumentsFromAData();
      
      res.json({
        success: true,
        data: result,
        message: result.message
      });
      
    } catch (error) {
      console.error('❌ 同步标的列表失败:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: '同步标的列表失败'
      });
    }
  }
  
  /**
   * 更新标的信息
   * PUT /api/instruments/:symbol
   */
  async updateInstrument(req, res) {
    try {
      const { symbol } = req.params;
      const data = req.body;
      
      const instrument = await instrumentService.updateInstrument(symbol, data);
      
      res.json({
        success: true,
        data: instrument,
        message: '更新成功'
      });
      
    } catch (error) {
      console.error('❌ 更新标的失败:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: '更新标的失败'
      });
    }
  }
  
  /**
   * 删除标的
   * DELETE /api/instruments/:symbol
   */
  async deleteInstrument(req, res) {
    try {
      const { symbol } = req.params;
      
      const result = await instrumentService.deleteInstrument(symbol);
      
      res.json({
        success: true,
        data: result,
        message: '删除成功'
      });
      
    } catch (error) {
      console.error('❌ 删除标的失败:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: '删除标的失败'
      });
    }
  }
  
  /**
   * 获取统计信息
   * GET /api/instruments/statistics
   */
  async getStatistics(req, res) {
    try {
      const stats = await instrumentService.getStatistics();
      
      res.json({
        success: true,
        data: stats,
        message: '获取成功'
      });
      
    } catch (error) {
      console.error('❌ 获取统计信息失败:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: '获取统计信息失败'
      });
    }
  }
  
  /**
   * 批量保存标的
   * POST /api/instruments/batch
   */
  async batchSaveInstruments(req, res) {
    try {
      const { instruments } = req.body;
      
      if (!instruments || !Array.isArray(instruments) || instruments.length === 0) {
        return res.status(400).json({
          success: false,
          message: '标的列表不能为空'
        });
      }
      
      console.log(`📋 批量保存 ${instruments.length} 个标的...`);
      
      const result = await instrumentService.batchSaveInstruments(instruments);
      
      res.json({
        success: true,
        data: result,
        message: `批量保存完成: 新增 ${result.successCount}, 更新 ${result.updateCount}, 跳过 ${result.skipCount}`
      });
      
    } catch (error) {
      console.error('❌ 批量保存失败:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: '批量保存失败'
      });
    }
  }
}

module.exports = new InstrumentController();
