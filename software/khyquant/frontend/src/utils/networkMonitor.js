/**
 * 网络监控和错误处理工具
 * 用于检测前后端连接状态,网络错误时自动返回启动界面
 */

class NetworkMonitor {
  constructor() {
    this.isMonitoring = false;
    this.failureCount = 0;
    this.maxFailures = 3; // 连续失败3次后返回启动界面
    this.checkInterval = 30000; // 每30秒检查一次
    this.intervalId = null;
    this.lastSuccessTime = Date.now();
  }

  /**
   * 开始监控网络状态
   */
  startMonitoring() {
    if (this.isMonitoring) {
      console.log('⚠️ 网络监控已在运行');
      return;
    }

    console.log('🔍 启动网络监控...');
    this.isMonitoring = true;
    this.failureCount = 0;
    this.lastSuccessTime = Date.now();

    // 立即执行一次检查
    this.checkConnection();

    // 定期检查
    this.intervalId = setInterval(() => {
      this.checkConnection();
    }, this.checkInterval);

    // 监听在线/离线事件
    window.addEventListener('online', this.handleOnline.bind(this));
    window.addEventListener('offline', this.handleOffline.bind(this));
  }

  /**
   * 停止监控
   */
  stopMonitoring() {
    if (!this.isMonitoring) {
      return;
    }

    console.log('🛑 停止网络监控');
    this.isMonitoring = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    window.removeEventListener('online', this.handleOnline.bind(this));
    window.removeEventListener('offline', this.handleOffline.bind(this));
  }

  /**
   * 检查后端连接状态
   */
  async checkConnection() {
    try {
      console.log('🔍 检查后端连接状态...');
      
      // 检查后端健康状态
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时

      const response = await fetch('/api/health', {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        console.log('✅ 后端连接正常');
        this.failureCount = 0;
        this.lastSuccessTime = Date.now();
        return true;
      } else {
        console.warn(`⚠️ 后端返回异常状态码: ${response.status}`);
        this.handleConnectionFailure('后端服务返回错误状态');
        return false;
      }
    } catch (error) {
      console.error('❌ 后端连接失败:', error.message);
      this.handleConnectionFailure(error.message);
      return false;
    }
  }

  /**
   * 处理连接失败
   */
  handleConnectionFailure(reason) {
    this.failureCount++;
    console.warn(`⚠️ 连接失败次数: ${this.failureCount}/${this.maxFailures}`);
    console.warn(`⚠️ 失败原因: ${reason}`);

    if (this.failureCount >= this.maxFailures) {
      console.error('❌ 连续失败次数过多,返回启动界面');
      this.returnToSplash('网络连接失败,请检查后端服务是否正常运行');
    }
  }

  /**
   * 处理在线事件
   */
  handleOnline() {
    console.log('✅ 网络已恢复在线');
    this.failureCount = 0;
    this.checkConnection();
  }

  /**
   * 处理离线事件
   */
  handleOffline() {
    console.warn('⚠️ 网络已离线');
    this.handleConnectionFailure('网络离线');
  }

  /**
   * 返回启动界面
   */
  returnToSplash(message) {
    console.log('🔄 准备返回启动界面...');
    
    // 停止监控
    this.stopMonitoring();

    // 显示错误提示
    if (window.$message) {
      window.$message.error({
        message: '连接失败',
        description: message,
        duration: 3000
      });
    }

    // 延迟返回,给用户看到错误信息的时间
    setTimeout(() => {
      // 检查是否在Electron环境中
      if (window.location.protocol === 'file:' || window.location.hostname === 'localhost') {
        // 在Electron或本地开发环境中,返回启动界面
        const splashUrl = this.getSplashUrl();
        console.log('🔄 返回启动界面:', splashUrl);
        window.location.href = splashUrl;
      } else {
        // 在生产环境中,刷新页面
        console.log('🔄 刷新页面重新连接');
        window.location.reload();
      }
    }, 2000);
  }

  /**
   * 获取启动界面URL
   */
  getSplashUrl() {
    // 尝试多个可能的启动界面路径
    const possiblePaths = [
      '/splash-beautiful.html',
      '/splash.html',
      '../splash-beautiful.html',
      '../../app/resources/app/splash-beautiful.html'
    ];

    // 在Electron环境中,使用file协议
    if (window.location.protocol === 'file:') {
      return 'splash-beautiful.html';
    }

    // 在开发环境中,返回根路径让用户重新启动
    return '/';
  }

  /**
   * 获取监控状态
   */
  getStatus() {
    return {
      isMonitoring: this.isMonitoring,
      failureCount: this.failureCount,
      maxFailures: this.maxFailures,
      lastSuccessTime: this.lastSuccessTime,
      timeSinceLastSuccess: Date.now() - this.lastSuccessTime
    };
  }
}

// 创建全局单例
const networkMonitor = new NetworkMonitor();

export default networkMonitor;
