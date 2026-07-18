/**
 * 标的列表服务
 * 管理金融标的数据的同步和查询
 */
const Instrument = require('../models/Instrument');
const pythonDataSourceService = require('./pythonDataSourceService');
const { Op } = require('sequelize');

class InstrumentService {
  /**
   * 从AData同步标的列表到数据库
   * 支持增量更新：只更新name,不删除已有标的
   */
  async syncInstrumentsFromAData() {
    try {
      console.log('🔄 开始从缓存同步标的列表...');

      // 直接复用 instrumentSyncService 的缓存脚本，避免依赖 adata
      const { spawn } = require('child_process');
      const path = require('path');
      const { findPython } = require('../utils/pythonPath');
      const { safeKill } = require('../tools/platformUtils');

      const result = await new Promise((resolve) => {
        const script = path.join(__dirname, 'get_all_instruments_from_cache.py');
        const proc = spawn(findPython(), [script], {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });
        let out = '';
        let settled = false;
        const done = (value) => {
          if (settled) return;
          settled = true;
          if (idleTimer) clearTimeout(idleTimer);
          resolve(value);
        };
        // Activity-aware idle timeout: a hung cache script (e.g. network
        // fallback) must not leave this Promise unsettled and the child alive.
        let idleTimer = null;
        const IDLE_MS = 120000;
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (proc && !proc.killed) safeKill(proc);
            done({ success: false, data: [] });
          }, IDLE_MS);
        };
        resetIdle();
        proc.stdout.on('data', d => { out += d; resetIdle(); });
        proc.stderr.on('data', () => { resetIdle(); });
        proc.on('close', (code) => {
          if (code !== 0) { done({ success: false, data: [] }); return; }
          try { done(JSON.parse(out)); } catch { done({ success: false, data: [] }); }
        });
        proc.on('error', () => done({ success: false, data: [] }));
      });

      if (!result.success || !result.data || result.data.length === 0) {
        return { successCount: 0, failCount: 1 };
      }

      const instruments = result.data.map(item => ({
        symbol: item.code || item.symbol,
        name: item.name,
        type: item.type || 'stock',
        market: item.market || 'SH',
        category: item.category || '股票',
        status: 'active'
      })).filter(i => i.symbol);

      console.log(`📋 获取到 ${instruments.length} 个标的，开始写入数据库...`);

      let successCount = 0, failCount = 0;
      const BATCH = 500;
      for (let i = 0; i < instruments.length; i += BATCH) {
        try {
          await Instrument.bulkCreate(instruments.slice(i, i + BATCH), {
            updateOnDuplicate: ['name', 'type', 'market', 'category', 'status', 'updatedAt']
          });
          successCount += Math.min(BATCH, instruments.length - i);
        } catch (e) {
          failCount++;
        }
      }

      console.log(`✅ 标的同步完成: ${successCount} 个成功, ${failCount} 个失败`);
      return { successCount, failCount };
    } catch (error) {
      console.error('❌ 同步标的列表失败:', error);
      throw error;
    }
  }

  /**
   * 智能保存标的：如果数据库中不存在则添加
   * 用于前端识别到新标的时自动保存
   */
  async saveInstrumentIfNotExists(symbol, name = null, type = 'unknown') {
    try {
      // 检查是否已存在
      const existing = await Instrument.findOne({ where: { symbol } });
      
      if (existing) {
        // 如果已存在但name为空,且传入了name,则更新
        if (!existing.name && name) {
          await existing.update({ name });
          console.log(`✅ 更新标的名称: ${symbol} -> ${name}`);
        }
        return existing;
      }
      
      // 不存在则创建
      const instrument = await Instrument.create({
        symbol,
        name: name || symbol,
        type,
        market: type === 'futures' ? 'CFFEX' : (symbol.startsWith('sh') || symbol.startsWith('6') ? 'SSE' : 'SZSE'),
        category: type === 'index' ? '指数' : type === 'stock' ? 'A股' : type === 'futures' ? '期货' : '未知',
        status: 'active'
      });
      
      console.log(`✅ 新增标的: ${symbol} ${name || ''}`);
      return instrument;
      
    } catch (error) {
      console.error(`❌ 保存标的失败 ${symbol}:`, error);
      throw error;
    }
  }
  
  /**
   * 批量保存标的列表
   * 用于前端一次性保存多个标的
   */
  async batchSaveInstruments(instruments) {
    try {
      console.log(`💾 批量保存 ${instruments.length} 个标的...`);
      
      let successCount = 0;
      let updateCount = 0;
      let skipCount = 0;
      
      for (const inst of instruments) {
        try {
          const existing = await Instrument.findOne({ 
            where: { symbol: inst.symbol } 
          });
          
          if (existing) {
            // 如果已存在但name为空,且传入了name,则更新
            if (!existing.name && inst.name) {
              await existing.update({ name: inst.name });
              updateCount++;
              console.log(`  ✅ 更新: ${inst.symbol} -> ${inst.name}`);
            } else {
              skipCount++;
            }
          } else {
            // 不存在则创建
            await Instrument.create({
              symbol: inst.symbol,
              name: inst.name || inst.symbol,
              type: inst.type || 'unknown',
              market: inst.market || (inst.type === 'futures' ? 'CFFEX' : (inst.symbol.startsWith('sh') || inst.symbol.startsWith('6') ? 'SSE' : 'SZSE')),
              category: inst.category || (inst.type === 'index' ? '指数' : inst.type === 'stock' ? 'A股' : inst.type === 'futures' ? '期货' : '未知'),
              status: 'active'
            });
            successCount++;
            console.log(`  ✅ 新增: ${inst.symbol} ${inst.name || ''}`);
          }
        } catch (error) {
          console.error(`  ❌ 保存失败 ${inst.symbol}:`, error.message);
        }
      }
      
      console.log(`✅ 批量保存完成: 新增 ${successCount}, 更新 ${updateCount}, 跳过 ${skipCount}`);
      
      return {
        success: true,
        successCount,
        updateCount,
        skipCount,
        total: instruments.length
      };
      
    } catch (error) {
      console.error('❌ 批量保存失败:', error);
      throw error;
    }
  }
  
  /**
   * 从数据库获取标的列表
   */
  async getInstruments(options = {}) {
    try {
      const {
        type = null,
        category = null,
        status = 'active',
        limit = 100,
        offset = 0,
        search = null
      } = options;
      
      const where = {};
      
      if (type) {
        where.type = type;
      }
      
      if (category) {
        where.category = category;
      }
      
      if (status) {
        where.status = status;
      }
      
      if (search) {
        where[Op.or] = [
          { symbol: { [Op.like]: `%${search}%` } },
          { name: { [Op.like]: `%${search}%` } }
        ];
      }
      
      const { count, rows } = await Instrument.findAndCountAll({
        where,
        limit,
        offset,
        order: [['symbol', 'ASC']]
      });
      
      return {
        total: count,
        instruments: rows,
        limit,
        offset
      };
      
    } catch (error) {
      console.error('❌ 获取标的列表失败:', error);
      throw error;
    }
  }
  
  /**
   * 根据symbol获取单个标的
   */
  async getInstrumentBySymbol(symbol) {
    try {
      const instrument = await Instrument.findOne({
        where: { symbol }
      });
      return instrument;
    } catch (error) {
      console.error(`❌ 获取标的失败 ${symbol}:`, error);
      throw error;
    }
  }
  
  /**
   * 更新标的信息
   */
  async updateInstrument(symbol, data) {
    try {
      const [updated] = await Instrument.update(data, {
        where: { symbol }
      });
      
      if (updated === 0) {
        throw new Error(`标的不存在: ${symbol}`);
      }
      
      return await this.getInstrumentBySymbol(symbol);
    } catch (error) {
      console.error(`❌ 更新标的失败 ${symbol}:`, error);
      throw error;
    }
  }
  
  /**
   * 删除标的
   */
  async deleteInstrument(symbol) {
    try {
      const deleted = await Instrument.destroy({
        where: { symbol }
      });
      
      if (deleted === 0) {
        throw new Error(`标的不存在: ${symbol}`);
      }
      
      return { success: true, message: '删除成功' };
    } catch (error) {
      console.error(`❌ 删除标的失败 ${symbol}:`, error);
      throw error;
    }
  }
  
  /**
   * 获取标的统计信息
   */
  async getStatistics() {
    try {
      const total = await Instrument.count();
      const byType = await Instrument.findAll({
        attributes: [
          'type',
          [sequelize.fn('COUNT', sequelize.col('id')), 'count']
        ],
        group: ['type']
      });
      
      const byStatus = await Instrument.findAll({
        attributes: [
          'status',
          [sequelize.fn('COUNT', sequelize.col('id')), 'count']
        ],
        group: ['status']
      });
      
      return {
        total,
        byType: byType.reduce((acc, item) => {
          acc[item.type] = parseInt(item.get('count'));
          return acc;
        }, {}),
        byStatus: byStatus.reduce((acc, item) => {
          acc[item.status] = parseInt(item.get('count'));
          return acc;
        }, {})
      };
    } catch (error) {
      console.error('❌ 获取统计信息失败:', error);
      throw error;
    }
  }
}

module.exports = new InstrumentService();
