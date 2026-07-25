/**
 * 策略监控服务
 * 实时监控市场数据，根据策略生成交易信号并自动执行
 */
const EventEmitter = require('events');
const strategyEngine = require('./strategyEngine');

class StrategyMonitor extends EventEmitter {
  constructor() {
    super();
    this.activeStrategies = new Map(); // 活跃的策略监控
    this.marketDataCache = new Map(); // 市场数据缓存
    this.lastSignals = new Map(); // 上次信号缓存，避免重复触发
  }

  /**
   * 启动策略监控
   * @param {Object} config - 监控配置
   * @param {string} config.strategyId - 策略ID
   * @param {string} config.strategyCode - 策略代码
   * @param {string} config.strategyLanguage - 策略语言
   * @param {Object} config.strategyParams - 策略参数
   * @param {string} config.symbol - 交易标的
   * @param {number} config.quantity - 交易数量
   * @param {string} config.userId - 用户ID
   * @param {Function} config.onSignal - 信号回调函数
   */
  startMonitoring(config) {
    const {
      strategyId,
      strategyCode,
      strategyLanguage = 'javascript',
      strategyParams = {},
      symbol,
      quantity,
      userId,
      onSignal
    } = config;

    const monitorKey = `${userId}_${strategyId}_${symbol}`;

    // 如果已经在监控，先停止
    if (this.activeStrategies.has(monitorKey)) {
      this.stopMonitoring(monitorKey);
    }

    const monitor = {
      strategyId,
      strategyCode,
      strategyLanguage,
      strategyParams,
      symbol,
      quantity,
      userId,
      onSignal,
      lastCheckTime: Date.now(),
      position: 0, // 当前持仓
      lastSignalType: null, // 上次信号类型
      isActive: true
    };

    this.activeStrategies.set(monitorKey, monitor);

    console.log(`✅ 策略监控已启动: ${monitorKey}`);
    console.log(`   策略ID: ${strategyId}`);
    console.log(`   标的: ${symbol}`);
    console.log(`   数量: ${quantity}`);

    // 立即执行一次检查
    this.checkStrategy(monitorKey);

    // 触发启动事件
    this.emit('monitorStarted', { monitorKey, config });

    return monitorKey;
  }

  /**
   * 停止策略监控
   * @param {string} monitorKey - 监控键
   */
  stopMonitoring(monitorKey) {
    const monitor = this.activeStrategies.get(monitorKey);
    if (monitor) {
      monitor.isActive = false;
      this.activeStrategies.delete(monitorKey);
      this.lastSignals.delete(monitorKey);
      
      console.log(`🛑 策略监控已停止: ${monitorKey}`);
      
      // 触发停止事件
      this.emit('monitorStopped', { monitorKey });
    }
  }

  /**
   * 更新市场数据并检查所有活跃策略
   * @param {string} symbol - 标的代码
   * @param {Array} marketData - 市场数据（K线数据）
   */
  updateMarketData(symbol, marketData) {
    this.marketDataCache.set(symbol, {
      data: marketData,
      timestamp: Date.now()
    });

    // 检查所有监控该标的的策略
    for (const [monitorKey, monitor] of this.activeStrategies.entries()) {
      if (monitor.symbol === symbol && monitor.isActive) {
        this.checkStrategy(monitorKey);
      }
    }
  }

  /**
   * 检查策略并生成信号
   * @param {string} monitorKey - 监控键
   */
  async checkStrategy(monitorKey) {
    const monitor = this.activeStrategies.get(monitorKey);
    if (!monitor || !monitor.isActive) {
      return;
    }

    try {
      // 获取市场数据
      const cachedData = this.marketDataCache.get(monitor.symbol);
      if (!cachedData || !cachedData.data || cachedData.data.length === 0) {
        console.log(`⚠️ 暂无市场数据: ${monitor.symbol}`);
        return;
      }

      const marketData = cachedData.data;
      
      // 执行策略
      const result = await strategyEngine.executeStrategy(
        monitor.strategyCode,
        marketData,
        monitor.strategyParams,
        monitor.strategyLanguage
      );

      // 提取信号
      let signals = [];
      if (Array.isArray(result)) {
        signals = result;
      } else if (result && result.signals) {
        signals = result.signals;
      }

      if (signals.length === 0) {
        return;
      }

      // 获取最新信号（最后一个非hold信号）
      const latestSignal = this.getLatestTradeSignal(signals);
      
      if (!latestSignal) {
        return;
      }

      // 检查是否是新信号（避免重复触发）
      const lastSignal = this.lastSignals.get(monitorKey);
      if (lastSignal && 
          lastSignal.type === latestSignal.type && 
          lastSignal.index === latestSignal.index) {
        return; // 相同信号，不重复触发
      }

      // 保存最新信号
      this.lastSignals.set(monitorKey, latestSignal);

      // 根据信号类型和当前持仓决定是否执行
      const shouldExecute = this.shouldExecuteSignal(monitor, latestSignal);
      
      if (shouldExecute) {
        console.log(`📊 策略信号: ${monitorKey}`);
        console.log(`   类型: ${latestSignal.type}`);
        console.log(`   价格: ${latestSignal.price}`);
        console.log(`   原因: ${latestSignal.reason}`);

        // 更新持仓状态
        if (latestSignal.type === 'buy' || latestSignal.type === 'open_long') {
          monitor.position = monitor.quantity;
        } else if (latestSignal.type === 'sell' || latestSignal.type === 'close_long') {
          monitor.position = 0;
        }

        monitor.lastSignalType = latestSignal.type;

        // 调用信号回调
        if (monitor.onSignal) {
          monitor.onSignal({
            signal: latestSignal,
            symbol: monitor.symbol,
            quantity: monitor.quantity,
            strategyId: monitor.strategyId
          });
        }

        // 触发信号事件
        this.emit('signal', {
          monitorKey,
          signal: latestSignal,
          symbol: monitor.symbol,
          quantity: monitor.quantity,
          strategyId: monitor.strategyId
        });
      }

    } catch (error) {
      console.error(`❌ 策略检查失败: ${monitorKey}`, error);
      this.emit('error', { monitorKey, error });
    }
  }

  /**
   * 获取最新的交易信号（非hold）
   * @param {Array} signals - 信号数组
   * @returns {Object|null} 最新交易信号
   */
  getLatestTradeSignal(signals) {
    // 从后往前找第一个非hold信号
    for (let i = signals.length - 1; i >= 0; i--) {
      const signal = signals[i];
      if (signal.type !== 'hold') {
        return signal;
      }
    }
    return null;
  }

  /**
   * 判断是否应该执行信号
   * @param {Object} monitor - 监控对象
   * @param {Object} signal - 信号
   * @returns {boolean} 是否执行
   */
  shouldExecuteSignal(monitor, signal) {
    const isBuySignal = signal.type === 'buy' || signal.type === 'open_long';
    const isSellSignal = signal.type === 'sell' || signal.type === 'close_long' || signal.type === 'close_short';

    // 买入信号：只有在没有持仓时才执行
    if (isBuySignal && monitor.position === 0) {
      return true;
    }

    // 卖出信号：只有在有持仓时才执行
    if (isSellSignal && monitor.position > 0) {
      return true;
    }

    return false;
  }

  /**
   * 获取所有活跃的监控
   * @returns {Array} 监控列表
   */
  getActiveMonitors() {
    const monitors = [];
    for (const [key, monitor] of this.activeStrategies.entries()) {
      monitors.push({
        key,
        strategyId: monitor.strategyId,
        symbol: monitor.symbol,
        quantity: monitor.quantity,
        position: monitor.position,
        lastSignalType: monitor.lastSignalType,
        isActive: monitor.isActive
      });
    }
    return monitors;
  }

  /**
   * 获取特定用户的监控
   * @param {string} userId - 用户ID
   * @returns {Array} 监控列表
   */
  getUserMonitors(userId) {
    const monitors = [];
    for (const [key, monitor] of this.activeStrategies.entries()) {
      if (monitor.userId === userId) {
        monitors.push({
          key,
          strategyId: monitor.strategyId,
          symbol: monitor.symbol,
          quantity: monitor.quantity,
          position: monitor.position,
          lastSignalType: monitor.lastSignalType,
          isActive: monitor.isActive
        });
      }
    }
    return monitors;
  }

  /**
   * 停止用户的所有监控
   * @param {string} userId - 用户ID
   */
  stopUserMonitors(userId) {
    const keysToStop = [];
    for (const [key, monitor] of this.activeStrategies.entries()) {
      if (monitor.userId === userId) {
        keysToStop.push(key);
      }
    }
    
    keysToStop.forEach(key => this.stopMonitoring(key));
    
    console.log(`🛑 已停止用户 ${userId} 的 ${keysToStop.length} 个策略监控`);
  }
}

module.exports = new StrategyMonitor();
