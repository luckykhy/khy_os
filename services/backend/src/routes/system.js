const express = require('express');
const router = express.Router();
const os = require('os');

/**
 * 获取网络信息（局域网IP）
 * 优化：排除虚拟网卡，优先选择真实的局域网IP
 */
router.get('/network-info', (req, res) => {
  try {
    const networkInterfaces = os.networkInterfaces();
    let lanIp = null;
    let candidateIps = [];
    
    // 虚拟网卡关键词（用于排除）
    const virtualAdapterKeywords = [
      'vmware', 'virtualbox', 'vbox', 'virtual', 'vethernet',
      'docker', 'wsl', 'hyper-v', 'loopback', 'tunnel'
    ];
    
    // 遍历所有网络接口
    for (const interfaceName in networkInterfaces) {
      const interfaces = networkInterfaces[interfaceName];
      const lowerName = interfaceName.toLowerCase();
      
      // 检查是否是虚拟网卡
      const isVirtual = virtualAdapterKeywords.some(keyword => 
        lowerName.includes(keyword)
      );
      
      for (const iface of interfaces) {
        // 跳过内部（回环）地址和非IPv4地址
        if (iface.family === 'IPv4' && !iface.internal) {
          const ip = iface.address;
          
          // 跳过169.254开头的APIPA地址
          if (ip.startsWith('169.254')) {
            continue;
          }
          
          // 优先级1: 192.168开头的IP（最常见的家庭/办公室局域网）
          if (ip.startsWith('192.168') && !isVirtual) {
            candidateIps.push({ ip, priority: 1, name: interfaceName });
          }
          // 优先级2: 10.0开头的IP（企业网络）
          else if (ip.startsWith('10.') && !isVirtual) {
            candidateIps.push({ ip, priority: 2, name: interfaceName });
          }
          // 优先级3: 172.16-172.31的IP（但不是虚拟网卡）
          else if (ip.startsWith('172.') && !isVirtual) {
            const secondOctet = parseInt(ip.split('.')[1]);
            if (secondOctet >= 16 && secondOctet <= 31) {
              candidateIps.push({ ip, priority: 3, name: interfaceName });
            }
          }
          // 优先级4: 其他私有IP（虚拟网卡也收集，作为最后备选）
          else if (ip.startsWith('192.168') || ip.startsWith('10.') || ip.startsWith('172.')) {
            candidateIps.push({ ip, priority: 4, name: interfaceName });
          }
        }
      }
    }
    
    // 按优先级排序，选择最优IP
    if (candidateIps.length > 0) {
      candidateIps.sort((a, b) => a.priority - b.priority);
      lanIp = candidateIps[0].ip;
      console.log('✅ 选择局域网IP:', lanIp, '来自网卡:', candidateIps[0].name);
      console.log('📋 所有候选IP:', candidateIps.map(c => `${c.ip} (${c.name}, 优先级${c.priority})`).join(', '));
    }
    
    res.json({
      success: true,
      data: {
        lanIp: lanIp,
        hostname: os.hostname(),
        platform: os.platform(),
        allCandidates: candidateIps.map(c => ({ ip: c.ip, interface: c.name, priority: c.priority }))
      }
    });
  } catch (error) {
    console.error('获取网络信息失败:', error);
    res.status(500).json({
      success: false,
      message: '获取网络信息失败',
      error: error.message
    });
  }
});

/**
 * GET /api/system/data-status
 * Returns current network mode, data source availability, and cache stats.
 */
router.get('/data-status', async (req, res) => {
  try {
    const networkDetector = require('../services/networkDetector');
    const sqliteBackupService = require('../services/sqliteBackupService');
    const cacheService = require('../services/cacheService');

    let dbConnected = false;
    try {
      const { sequelize } = require('../config/database');
      await sequelize.authenticate();
      dbConnected = true;
    } catch { /* ignore */ }

    let cacheStats = { type: 'unknown' };
    try {
      cacheStats = await cacheService.getStats();
    } catch { /* ignore */ }

    res.json({
      success: true,
      data: {
        networkMode: networkDetector.getDataMode(),
        isOnline: networkDetector.isOnline(),
        networkDetail: networkDetector.getStatus(),
        database: {
          postgres: dbConnected ? 'connected' : 'disconnected',
          sqlite: sqliteBackupService.isAvailable() ? 'available' : 'unavailable',
          primaryMode: process.env.DB_TYPE === 'sqlite' ? 'sqlite' : 'postgres',
        },
        cache: cacheStats,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/system/data-sources/test
 * Tests connectivity to all alternative financial data APIs.
 */
router.get('/data-sources/test', async (req, res) => {
  try {
    const altDataService = require('../services/alternativeDataService');
    const results = await altDataService.testConnectivity();
    const accessible = Object.entries(results)
      .filter(([, v]) => v.accessible)
      .map(([k]) => k);

    res.json({
      success: true,
      data: {
        results,
        accessibleSources: accessible,
        totalTested: Object.keys(results).length,
        totalAccessible: accessible.length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
