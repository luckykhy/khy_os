class NotificationService {
  constructor() {
    this.connections = new Map(); // userId -> Set of WebSocket connections
    this.adminConnections = new Set(); // Admin WebSocket connections
  }

  /**
   * 注册用户连接
   * @param {WebSocket} ws - WebSocket连接
   * @param {number} userId - 用户ID
   * @param {string} role - 用户角色
   */
  registerConnection(ws, userId, role) {
    // 为连接添加用户信息
    ws.userId = userId;
    ws.role = role;

    // 管理员连接单独管理
    if (role === 'admin') {
      this.adminConnections.add(ws);
      console.log(`管理员连接注册: ${userId}`);
    }

    // 普通用户连接按用户ID管理
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
    }
    this.connections.get(userId).add(ws);

    console.log(`用户连接注册: ${userId} (${role}), 总连接数: ${this.getTotalConnections()}`);

    // 连接关闭时清理
    ws.on('close', () => {
      this.removeConnection(ws, userId, role);
    });

    ws.on('error', (error) => {
      console.error(`WebSocket错误 (用户${userId}):`, error);
      this.removeConnection(ws, userId, role);
    });
  }

  /**
   * 移除连接
   * @param {WebSocket} ws - WebSocket连接
   * @param {number} userId - 用户ID
   * @param {string} role - 用户角色
   */
  removeConnection(ws, userId, role) {
    if (role === 'admin') {
      this.adminConnections.delete(ws);
    }

    if (this.connections.has(userId)) {
      this.connections.get(userId).delete(ws);
      if (this.connections.get(userId).size === 0) {
        this.connections.delete(userId);
      }
    }

    console.log(`用户连接移除: ${userId} (${role}), 剩余连接数: ${this.getTotalConnections()}`);
  }

  /**
   * 向所有用户广播公告通知
   * @param {Object} announcement - 公告对象
   */
  broadcastAnnouncement(announcement) {
    const notification = {
      type: 'announcement',
      action: 'new',
      data: {
        id: announcement.id,
        title: announcement.title,
        content: announcement.content,
        type: announcement.type,
        priority: announcement.priority,
        isSticky: announcement.isSticky,
        isPopup: announcement.isPopup,
        publishAt: announcement.publishAt,
        author: announcement.author
      },
      timestamp: new Date().toISOString()
    };

    let sentCount = 0;

    // 向所有连接的用户发送通知
    this.connections.forEach((wsSet, userId) => {
      wsSet.forEach(ws => {
        if (ws.readyState === ws.OPEN) {
          try {
            ws.send(JSON.stringify(notification));
            sentCount++;
          } catch (error) {
            console.error(`发送通知失败 (用户${userId}):`, error);
          }
        }
      });
    });

    console.log(`📢 公告通知已广播: "${announcement.title}", 发送给 ${sentCount} 个连接`);
    return sentCount;
  }

  /**
   * 向特定用户发送通知
   * @param {number} userId - 用户ID
   * @param {Object} notification - 通知对象
   */
  sendToUser(userId, notification) {
    if (!this.connections.has(userId)) {
      console.log(`用户 ${userId} 未连接，无法发送通知`);
      return false;
    }

    let sent = false;
    this.connections.get(userId).forEach(ws => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify({
            ...notification,
            timestamp: new Date().toISOString()
          }));
          sent = true;
        } catch (error) {
          console.error(`发送个人通知失败 (用户${userId}):`, error);
        }
      }
    });

    return sent;
  }

  /**
   * 向管理员发送通知
   * @param {Object} notification - 通知对象
   */
  sendToAdmins(notification) {
    let sentCount = 0;

    this.adminConnections.forEach(ws => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify({
            ...notification,
            timestamp: new Date().toISOString()
          }));
          sentCount++;
        } catch (error) {
          console.error('发送管理员通知失败:', error);
        }
      }
    });

    console.log(`📢 管理员通知已发送给 ${sentCount} 个管理员连接`);
    return sentCount;
  }

  /**
   * 获取连接统计信息
   */
  getStats() {
    const userConnections = Array.from(this.connections.entries()).reduce((total, [userId, wsSet]) => {
      return total + wsSet.size;
    }, 0);

    return {
      totalUsers: this.connections.size,
      totalConnections: userConnections,
      adminConnections: this.adminConnections.size,
      totalAll: userConnections + this.adminConnections.size
    };
  }

  /**
   * 获取总连接数
   */
  getTotalConnections() {
    const stats = this.getStats();
    return stats.totalAll;
  }

  /**
   * 清理所有连接
   */
  cleanup() {
    this.connections.clear();
    this.adminConnections.clear();
    console.log('通知服务已清理所有连接');
  }

  /**
   * 发送系统通知
   * @param {string} message - 通知消息
   * @param {string} type - 通知类型
   */
  broadcastSystemNotification(message, type = 'info') {
    const notification = {
      type: 'system',
      action: 'notification',
      data: {
        message,
        type,
        title: '系统通知'
      },
      timestamp: new Date().toISOString()
    };

    let sentCount = 0;

    // 向所有连接发送系统通知
    this.connections.forEach((wsSet) => {
      wsSet.forEach(ws => {
        if (ws.readyState === ws.OPEN) {
          try {
            ws.send(JSON.stringify(notification));
            sentCount++;
          } catch (error) {
            console.error('发送系统通知失败:', error);
          }
        }
      });
    });

    // 也向管理员发送
    this.adminConnections.forEach(ws => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify(notification));
          sentCount++;
        } catch (error) {
          console.error('发送管理员系统通知失败:', error);
        }
      }
    });

    console.log(`📢 系统通知已广播: "${message}", 发送给 ${sentCount} 个连接`);
    return sentCount;
  }

  /**
   * 广播消息到所有连接的客户端
   * @param {Object} message - 要广播的消息对象
   */
  broadcast(message) {
    const notification = {
      ...message,
      timestamp: new Date().toISOString()
    };

    let sentCount = 0;

    // 向所有用户连接广播
    this.connections.forEach((wsSet) => {
      wsSet.forEach(ws => {
        if (ws.readyState === ws.OPEN) {
          try {
            ws.send(JSON.stringify(notification));
            sentCount++;
          } catch (error) {
            console.error('广播消息失败:', error);
          }
        }
      });
    });

    // 也向管理员广播
    this.adminConnections.forEach(ws => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify(notification));
          sentCount++;
        } catch (error) {
          console.error('向管理员广播消息失败:', error);
        }
      }
    });

    console.log(`📡 消息已广播给 ${sentCount} 个连接`);
    return sentCount;
  }
}

// 创建单例实例
const notificationService = new NotificationService();

module.exports = notificationService;