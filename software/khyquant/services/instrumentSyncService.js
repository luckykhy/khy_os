/**
 * 标的列表自动同步服务
 * 每隔5分钟自动从数据源获取最新标的列表并保存到数据库
 */

const Instrument = require('../models/Instrument');
const { spawn } = require('child_process');
const { safeKill } = require('../tools/platformUtils');
const path = require('path');

class InstrumentSyncService {
  constructor() {
    this.cronJob = null;
    this.isSyncing = false;
    this.lastSyncTime = null;
    this.syncCount = 0;
    this.newInstrumentsCount = 0;
    this._todaySynced = false;
  }

  /**
   * Start daily cron sync at 09:05 (after market pre-open)
   * Also runs once on first login of the day via onLogin().
   */
  start() {
    if (this.cronJob) return;

    const cron = require('node-cron');
    this.cronJob = cron.schedule('5 9 * * *', () => {
      this.syncInstruments().catch(err => {
        console.error('Scheduled instrument sync failed:', err.message);
      });
    });

    console.log('Instrument sync service started (daily 09:05 + login trigger)');

    // Delayed first sync on boot (30s)
    setTimeout(() => {
      this.syncInstruments().catch(() => {});
    }, 30000);
  }

  /**
   * Called on user login - syncs once per calendar day.
   */
  async onLogin() {
    const today = new Date().toDateString();
    if (this._todaySynced === today) return;
    this._todaySynced = today;
    await this.syncInstruments();
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
  }

  /**
   * 执行同步
   */
  async syncInstruments() {
    if (this.isSyncing) {
      console.log('⚠️  上一次同步还在进行中,跳过本次同步');
      return;
    }

    try {
      this.isSyncing = true;
      this.syncCount++;
      
      console.log(`\n📊 [同步 #${this.syncCount}] 开始同步标的列表... (${new Date().toLocaleString()})`);

      // 🔥 发送同步开始通知
      this.broadcastSyncStatus({
        type: 'sync_start',
        message: '正在同步标的列表...',
        syncCount: this.syncCount,
        timestamp: new Date().toISOString()
      });

      // 1. 从AData获取最新标的列表
      const instruments = await this.fetchInstrumentsFromAData();
      
      if (!instruments || instruments.length === 0) {
        console.log('⚠️  未获取到标的数据,跳过本次同步');
        
        // 🔥 发送同步失败通知
        this.broadcastSyncStatus({
          type: 'sync_warning',
          message: '未获取到标的数据',
          syncCount: this.syncCount,
          timestamp: new Date().toISOString()
        });
        
        return;
      }

      console.log(`📋 获取到 ${instruments.length} 个标的`);

      // 2. 查询数据库中已存在的标的
      const existingSymbols = await Instrument.findAll({
        attributes: ['symbol'],
        raw: true
      });
      const existingSymbolsSet = new Set(existingSymbols.map(item => item.symbol));

      // 3. 筛选出新标的(将code映射到symbol)
      const newInstruments = instruments
        .map(item => ({
          symbol: item.code,  // 将code映射到symbol
          name: item.name,
          type: item.type,
          market: item.market,
          category: item.category
        }))
        .filter(item => !existingSymbolsSet.has(item.symbol));

      if (newInstruments.length === 0) {
        console.log('✅ 没有新标的需要保存');
        this.lastSyncTime = new Date();
        
        // 🔥 发送同步完成通知(无新数据)
        this.broadcastSyncStatus({
          type: 'sync_complete',
          message: '同步完成,没有新标的',
          syncCount: this.syncCount,
          totalInstruments: instruments.length,
          newInstruments: 0,
          timestamp: new Date().toISOString()
        });
        
        return;
      }

      console.log(`🆕 发现 ${newInstruments.length} 个新标的`);

      // 4. 批量保存新标的到数据库
      const savedCount = await this.saveNewInstruments(newInstruments);

      this.newInstrumentsCount += savedCount;
      this.lastSyncTime = new Date();

      console.log(`✅ [同步 #${this.syncCount}] 同步完成: 保存了 ${savedCount} 个新标的`);
      console.log(`📊 累计新增标的: ${this.newInstrumentsCount} 个`);

      // 🔥 发送同步成功通知
      this.broadcastSyncStatus({
        type: 'sync_success',
        message: `同步完成,新增 ${savedCount} 个标的`,
        syncCount: this.syncCount,
        totalInstruments: instruments.length,
        newInstruments: savedCount,
        cumulativeNew: this.newInstrumentsCount,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ 同步标的列表失败:', error);
      
      // 🔥 发送同步错误通知
      this.broadcastSyncStatus({
        type: 'sync_error',
        message: '同步失败: ' + error.message,
        syncCount: this.syncCount,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 广播同步状态到所有WebSocket客户端
   */
  broadcastSyncStatus(data) {
    try {
      // 获取notificationService实例
      const notificationService = require('./notificationService');
      
      // 广播到所有已认证的客户端
      notificationService.broadcast({
        type: 'instrument_sync',
        data: data
      });
      
      console.log(`📡 已广播同步状态: ${data.type}`);
    } catch (error) {
      console.error('广播同步状态失败:', error);
    }
  }

  /**
   * 从AData获取标的列表
   */
  async fetchInstrumentsFromAData() {
    return new Promise((resolve, reject) => {
      // 🔥 优先使用缓存版本(速度快),如果失败再用网络版本
      const pythonScript = path.join(__dirname, 'get_all_instruments_from_cache.py');
      
      console.log('🐍 调用Python脚本获取标的列表...');
      
      // 根据操作系统选择Python命令，动态探测避免 PATH 问题
      const { findPython } = require('../utils/pythonPath');
      const pythonPath = findPython();
      
      // 🔥 修复: 设置正确的编码,避免中文乱码
      let pythonProcess;
      try {
        pythonProcess = spawn(pythonPath, [pythonScript], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8'  // 设置Python输出编码为UTF-8
          }
        });
      } catch (spawnError) {
        console.error('❌ 无法启动Python进程:', spawnError.message);
        console.warn('⚠️ Python未安装或不可用,跳过标的同步');
        resolve([]); // 返回空数组,不阻塞系统启动
        return;
      }
      
      // 🔥 添加错误事件监听器,防止进程崩溃
      pythonProcess.on('error', (error) => {
        console.error('❌ Python进程错误:', error.message);
        console.warn('⚠️ Python不可用,跳过标的同步');
        resolve([]); // 返回空数组,不阻塞系统启动
      });
      
      let dataString = '';
      let errorString = '';

      pythonProcess.stdout.setEncoding('utf8');  // 设置stdout编码
      pythonProcess.stderr.setEncoding('utf8');  // 设置stderr编码

      // Activity-aware idle timeout (resets on stdout/stderr data)
      let _idleTimer = null;
      const IDLE_MS = 60000; // 60s idle threshold (generous for large datasets)
      const _resetIdle = () => {
        if (_idleTimer) clearTimeout(_idleTimer);
        _idleTimer = setTimeout(() => {
          safeKill(pythonProcess);
          reject(new Error(`获取标的列表空闲超时（${IDLE_MS / 1000}s 内无输出）`));
        }, IDLE_MS);
      };
      _resetIdle();

      pythonProcess.stdout.on('data', (data) => {
        dataString += data.toString();
        _resetIdle();
      });

      pythonProcess.stderr.on('data', (data) => {
        errorString += data.toString();
        _resetIdle();
        // 只记录错误,不打印所有stderr输出(避免日志过多)
        if (errorString.includes('Error') || errorString.includes('错误')) {
          console.error('⚠️  Python stderr:', data.toString());
        }
      });

      pythonProcess.on('close', (code) => {
        if (_idleTimer) clearTimeout(_idleTimer);
        if (code !== 0) {
          console.error('❌ Python脚本执行失败:', errorString);
          reject(new Error(`Python脚本退出码: ${code}`));
          return;
        }

        try {
          const result = JSON.parse(dataString);

          if (result.success && result.data) {
            console.log(`✅ 成功获取 ${result.data.length} 个标的`);
            resolve(result.data);
          } else {
            console.error('❌ Python脚本返回失败:', result.message);
            resolve([]);
          }
        } catch (error) {
          console.error('❌ 解析Python脚本输出失败:', error);
          console.error('输出内容:', dataString.substring(0, 200)); // 只显示前200字符
          resolve([]);
        }
      });
    });
  }

  /**
   * 批量保存新标的到数据库
   */
  async saveNewInstruments(instruments) {
    try {
      // 使用bulkCreate批量插入
      const result = await Instrument.bulkCreate(instruments, {
        ignoreDuplicates: true, // 忽略重复的记录
        validate: true
      });

      console.log(`💾 成功保存 ${result.length} 个新标的到数据库`);
      
      // 显示部分新标的信息
      if (result.length > 0) {
        console.log('📝 新标的示例:');
        result.slice(0, 5).forEach(item => {
          console.log(`  - ${item.symbol} ${item.name} (${item.type})`);
        });
        if (result.length > 5) {
          console.log(`  ... 还有 ${result.length - 5} 个`);
        }
      }

      return result.length;
    } catch (error) {
      console.error('❌ 保存标的到数据库失败:', error);
      return 0;
    }
  }

  /**
   * 获取同步状态
   */
  getStatus() {
    return {
      isRunning: this.timer !== null,
      isSyncing: this.isSyncing,
      syncInterval: this.syncInterval,
      lastSyncTime: this.lastSyncTime,
      syncCount: this.syncCount,
      newInstrumentsCount: this.newInstrumentsCount,
      nextSyncTime: this.lastSyncTime 
        ? new Date(this.lastSyncTime.getTime() + this.syncInterval)
        : null
    };
  }

  /**
   * 手动触发同步
   */
  async triggerSync() {
    console.log('🔄 手动触发同步...');
    await this.syncInstruments();
  }
}

// 创建单例
const instrumentSyncService = new InstrumentSyncService();

module.exports = instrumentSyncService;
