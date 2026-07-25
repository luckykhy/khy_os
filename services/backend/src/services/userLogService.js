const UserLog = require('../models/UserLog');
const { Op } = require('sequelize');

class UserLogService {
  // 记录用户日志
  static async logUserAction(logData) {
    try {
      const {
        userId,
        username,
        action,
        actionDescription,
        ipAddress,
        userAgent,
        sessionId,
        status = 'success',
        details = {}
      } = logData;

      const log = await UserLog.create({
        userId,
        username,
        action,
        actionDescription,
        ipAddress,
        userAgent,
        sessionId,
        status,
        details,
        timestamp: new Date()
      });

      return log;
    } catch (error) {
      // 如果user_logs表不存在，只记录错误但不抛出异常
      // 这样不会影响注册和登录功能
      console.error('记录用户日志失败:', error.message);
      console.warn('提示：user_logs表可能不存在，但不影响系统功能');
      // 不抛出错误，让注册/登录继续
      return null;
    }
  }

  // 获取用户日志列表（管理员用）
  static async getUserLogs(options = {}) {
    try {
      const {
        page = 1,
        limit = 20,
        userId,
        action,
        status,
        startDate,
        endDate,
        search
      } = options;

      const offset = (page - 1) * limit;
      const where = {};

      // 筛选条件
      if (userId) {
        where.userId = userId;
      }

      if (action) {
        where.action = action;
      }

      if (status) {
        where.status = status;
      }

      if (startDate && endDate) {
        where.timestamp = {
          [Op.between]: [new Date(startDate), new Date(endDate)]
        };
      } else if (startDate) {
        where.timestamp = {
          [Op.gte]: new Date(startDate)
        };
      } else if (endDate) {
        where.timestamp = {
          [Op.lte]: new Date(endDate)
        };
      }

      if (search) {
        where[Op.or] = [
          { username: { [Op.iLike]: `%${search}%` } },
          { actionDescription: { [Op.iLike]: `%${search}%` } },
          { ipAddress: { [Op.iLike]: `%${search}%` } }
        ];
      }

      const { count, rows } = await UserLog.findAndCountAll({
        where,
        order: [['timestamp', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      return {
        logs: rows,
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(count / limit)
      };
    } catch (error) {
      console.error('获取用户日志失败:', error);
      throw error;
    }
  }

  // 获取用户活动统计
  static async getUserActivityStats(days = 30) {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      // 按日期统计登录次数
      const dailyLogins = await UserLog.findAll({
        attributes: [
          [UserLog.sequelize.fn('DATE', UserLog.sequelize.col('timestamp')), 'date'],
          [UserLog.sequelize.fn('COUNT', UserLog.sequelize.col('id')), 'count']
        ],
        where: {
          action: 'login',
          status: 'success',
          timestamp: {
            [Op.gte]: startDate
          }
        },
        group: [UserLog.sequelize.fn('DATE', UserLog.sequelize.col('timestamp'))],
        order: [[UserLog.sequelize.fn('DATE', UserLog.sequelize.col('timestamp')), 'ASC']]
      });

      // 按操作类型统计
      const actionStats = await UserLog.findAll({
        attributes: [
          'action',
          [UserLog.sequelize.fn('COUNT', UserLog.sequelize.col('id')), 'count']
        ],
        where: {
          timestamp: {
            [Op.gte]: startDate
          }
        },
        group: ['action'],
        order: [[UserLog.sequelize.fn('COUNT', UserLog.sequelize.col('id')), 'DESC']]
      });

      // 活跃用户统计
      const activeUsers = await UserLog.findAll({
        attributes: [
          'userId',
          'username',
          [UserLog.sequelize.fn('COUNT', UserLog.sequelize.col('id')), 'activityCount'],
          [UserLog.sequelize.fn('MAX', UserLog.sequelize.col('timestamp')), 'lastActivity']
        ],
        where: {
          timestamp: {
            [Op.gte]: startDate
          }
        },
        group: ['userId', 'username'],
        order: [[UserLog.sequelize.fn('COUNT', UserLog.sequelize.col('id')), 'DESC']],
        limit: 10
      });

      return {
        dailyLogins: dailyLogins.map(item => ({
          date: item.dataValues.date,
          count: parseInt(item.dataValues.count)
        })),
        actionStats: actionStats.map(item => ({
          action: item.action,
          count: parseInt(item.dataValues.count)
        })),
        activeUsers: activeUsers.map(item => ({
          userId: item.userId,
          username: item.username,
          activityCount: parseInt(item.dataValues.activityCount),
          lastActivity: item.dataValues.lastActivity
        }))
      };
    } catch (error) {
      console.error('获取用户活动统计失败:', error);
      throw error;
    }
  }

  // 清理旧日志
  static async cleanOldLogs(daysToKeep = 90) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const deletedCount = await UserLog.destroy({
        where: {
          timestamp: {
            [Op.lt]: cutoffDate
          }
        }
      });

      return deletedCount;
    } catch (error) {
      console.error('清理旧日志失败:', error);
      throw error;
    }
  }
}

module.exports = UserLogService;