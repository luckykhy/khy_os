const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const UserFavorite = require('../models/UserFavorite');

/**
 * 获取用户自选标的列表
 * GET /api/favorites
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    console.log(`📂 获取用户 ${userId} 的自选标的列表`);
    
    const favorites = await UserFavorite.findAll({
      where: { user_id: userId },
      order: [['added_at', 'DESC']]
    });
    
    console.log(`✅ 找到 ${favorites.length} 个自选标的`);
    
    res.json({
      success: true,
      data: favorites.map(f => ({
        symbol: f.symbol,
        name: f.name,
        type: f.type,
        addedAt: f.added_at
      }))
    });
  } catch (error) {
    console.error('获取自选标的失败:', error);
    res.status(500).json({
      success: false,
      message: '获取自选标的失败',
      error: error.message
    });
  }
});

/**
 * 添加自选标的
 * POST /api/favorites
 */
router.post('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { symbol, name, type } = req.body;
    
    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: '标的代码不能为空'
      });
    }
    
    console.log(`➕ 用户 ${userId} 添加自选标的: ${symbol} (${name})`);
    
    // 使用upsert避免重复
    const [favorite, created] = await UserFavorite.findOrCreate({
      where: {
        user_id: userId,
        symbol: symbol
      },
      defaults: {
        name: name,
        type: type
      }
    });
    
    console.log(created ? '✅ 添加成功' : 'ℹ️  已存在');
    
    res.json({
      success: true,
      message: created ? '添加成功' : '已存在',
      data: {
        symbol: favorite.symbol,
        name: favorite.name,
        type: favorite.type,
        addedAt: favorite.added_at
      }
    });
  } catch (error) {
    console.error('添加自选标的失败:', error);
    res.status(500).json({
      success: false,
      message: '添加自选标的失败',
      error: error.message
    });
  }
});

/**
 * 删除自选标的
 * DELETE /api/favorites/:symbol
 */
router.delete('/:symbol', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { symbol } = req.params;
    
    console.log(`➖ 用户 ${userId} 删除自选标的: ${symbol}`);
    
    const deleted = await UserFavorite.destroy({
      where: {
        user_id: userId,
        symbol: symbol
      }
    });
    
    if (deleted > 0) {
      console.log('✅ 删除成功');
      res.json({
        success: true,
        message: '删除成功'
      });
    } else {
      console.log('⚠️  未找到该自选标的');
      res.status(404).json({
        success: false,
        message: '未找到该自选标的'
      });
    }
  } catch (error) {
    console.error('删除自选标的失败:', error);
    res.status(500).json({
      success: false,
      message: '删除自选标的失败',
      error: error.message
    });
  }
});

/**
 * 批量添加自选标的
 * POST /api/favorites/batch
 */
router.post('/batch', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { favorites } = req.body; // [{ symbol, name, type }, ...]
    
    if (!Array.isArray(favorites)) {
      return res.status(400).json({
        success: false,
        message: '自选标的列表格式错误,必须是数组'
      });
    }
    
    // 允许空数组(用于清空自选标的)
    if (favorites.length === 0) {
      console.log(`📦 用户 ${userId} 清空自选标的`);
      return res.json({
        success: true,
        message: '自选标的列表为空',
        data: {
          total: 0,
          successCount: 0,
          failCount: 0
        }
      });
    }
    
    console.log(`📦 用户 ${userId} 批量添加 ${favorites.length} 个自选标的`);
    
    const results = await Promise.allSettled(
      favorites.map(item => 
        UserFavorite.findOrCreate({
          where: {
            user_id: userId,
            symbol: item.symbol
          },
          defaults: {
            name: item.name,
            type: item.type
          }
        })
      )
    );
    
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const failCount = results.filter(r => r.status === 'rejected').length;
    
    console.log(`✅ 批量添加完成: 成功${successCount}个, 失败${failCount}个`);
    
    res.json({
      success: true,
      message: `批量添加完成: 成功${successCount}个, 失败${failCount}个`,
      data: {
        total: favorites.length,
        successCount,
        failCount
      }
    });
  } catch (error) {
    console.error('批量添加自选标的失败:', error);
    res.status(500).json({
      success: false,
      message: '批量添加自选标的失败',
      error: error.message
    });
  }
});

/**
 * 清空用户所有自选标的
 * DELETE /api/favorites
 */
router.delete('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    console.log(`🗑️  用户 ${userId} 清空所有自选标的`);
    
    const deleted = await UserFavorite.destroy({
      where: { user_id: userId }
    });
    
    console.log(`✅ 已删除 ${deleted} 个自选标的`);
    
    res.json({
      success: true,
      message: `已删除 ${deleted} 个自选标的`,
      data: { deletedCount: deleted }
    });
  } catch (error) {
    console.error('清空自选标的失败:', error);
    res.status(500).json({
      success: false,
      message: '清空自选标的失败',
      error: error.message
    });
  }
});

module.exports = router;
