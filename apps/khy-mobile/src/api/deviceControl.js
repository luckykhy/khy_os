// khy.deviceControl —— 设备控制层（无障碍服务 + Shizuku + execShell 三种能力来源）。
//
// 用法：所有方法在无障碍服务未授权时会 reject 一个明确错误，UI 端给出"去授权"引导。
//   - getCapability() → { accessibilityReady, shizukuInstalled }
//   - openAccessibilitySettings() → 跳系统设置授权无障碍
//   - inputTap / inputSwipe / inputText → 优先无障碍；fallback Shizuku shell
//   - findAndClick / findAndLongClick / dumpUi → 必须无障碍
//   - listApps / startActivity → 用 PackageManager（普通 App 权限）
//   - execShell → 白名单（input / am start / pm list 等允许；rm -rf / / shutdown 拒绝）

import { registerPlugin } from '@capacitor/core';

const DeviceControl = registerPlugin('DeviceControl', {
  web: () => ({
    getCapability: () => Promise.resolve({ accessibilityReady: false, shizukuInstalled: false }),
    openAccessibilitySettings: () => Promise.resolve({ opened: false }),
    isShizukuReady: () => Promise.resolve({ ready: false, reason: 'web' }),
    execShell: () => Promise.reject(new Error('仅 Android 设备可用')),
    startActivity: () => Promise.reject(new Error('仅 Android 设备可用')),
    listApps: () => Promise.reject(new Error('仅 Android 设备可用')),
    inputTap: () => Promise.reject(new Error('仅 Android 设备可用')),
    inputSwipe: () => Promise.reject(new Error('仅 Android 设备可用')),
    inputText: () => Promise.reject(new Error('仅 Android 设备可用')),
    findAndClick: () => Promise.reject(new Error('仅 Android 设备可用')),
    findAndLongClick: () => Promise.reject(new Error('仅 Android 设备可用')),
    findWithBounds: () => Promise.reject(new Error('仅 Android 设备可用')),
    listClickable: () => Promise.reject(new Error('仅 Android 设备可用')),
    dumpUi: () => Promise.reject(new Error('仅 Android 设备可用')),
    globalAction: () => Promise.reject(new Error('仅 Android 设备可用')),
  }),
});

export async function getCapability() {
  const r = await DeviceControl.getCapability();
  return {
    accessibilityReady: Boolean(r?.accessibilityReady),
    shizukuInstalled: Boolean(r?.shizukuInstalled),
  };
}

export async function openAccessibilitySettings() {
  return DeviceControl.openAccessibilitySettings();
}

export async function isShizukuReady() {
  const r = await DeviceControl.isShizukuReady();
  return { ready: Boolean(r?.ready), reason: r?.reason || '' };
}

export async function execShell(command) {
  const r = await DeviceControl.execShell({ command });
  return { stdout: r?.stdout || '', stderr: r?.stderr || '', exitCode: r?.exitCode ?? -1 };
}

export async function startActivity(target) {
  return DeviceControl.startActivity({ target });
}

export async function inputTap(x, y) {
  return DeviceControl.inputTap({ x, y });
}

export async function inputSwipe(x1, y1, x2, y2, durationMs = 300) {
  return DeviceControl.inputSwipe({ x1, y1, x2, y2, durationMs });
}

export async function inputText(text) {
  return DeviceControl.inputText({ text });
}

export async function findAndClick(query) {
  return DeviceControl.findAndClick({ query });
}

export async function findAndLongClick(query) {
  return DeviceControl.findAndLongClick({ query });
}

// 找元素 → 返回屏幕中心坐标 + 边界。Agent "混合模式" 桥。
export async function findWithBounds(query) {
  return DeviceControl.findWithBounds({ query });
}

// 列出当前所有可点击节点。供 Agent "我有哪些按钮可以点" 决策。
export async function listClickable() {
  const r = await DeviceControl.listClickable();
  return r?.items || [];
}

export async function dumpUi() {
  const r = await DeviceControl.dumpUi();
  return r?.dump || '';
}

export async function globalAction(action) {
  return DeviceControl.globalAction({ action });
}

export async function listApps(query = '') {
  return DeviceControl.listApps({ query });
}

/**
 * 智能应用搜索（支持拼音、语义匹配）
 * 参考：肉包 Roubao 的智能应用搜索
 *
 * @param {string} query - 搜索关键字
 * @returns {Promise<{apps: Array, matchType: string}>}
 */
export async function searchApps(query = '') {
  const result = await DeviceControl.listApps({ query });
  const apps = result?.apps || [];

  if (!query || !apps.length) {
    return { apps, matchType: 'none' };
  }

  const lowerQuery = query.toLowerCase();

  // 1. 精确匹配（包名或标签完全包含）
  const exactMatches = apps.filter(
    (a) =>
      a.label?.toLowerCase().includes(lowerQuery) ||
      a.package?.toLowerCase().includes(lowerQuery)
  );

  if (exactMatches.length > 0) {
    return { apps: exactMatches, matchType: 'exact' };
  }

  // 2. 拼音匹配（简单的首字母匹配）
  const pinyinMatches = apps.filter((a) => {
    const label = a.label || '';
    // 获取首字母缩写
    const initials = label
      .split('')
      .filter((c, i, arr) => i === 0 || /[\s]/.test(arr[i - 1]))
      .map((c) => c.toLowerCase())
      .join('');
    return initials.includes(lowerQuery);
  });

  if (pinyinMatches.length > 0) {
    return { apps: pinyinMatches, matchType: 'pinyin' };
  }

  // 3. 语义匹配（基于关键词）
  const semanticMap = {
    // 社交
    微信: ['weixin', 'wechat', 'com.tencent.mm'],
    qq: ['qq', 'com.tencent.mobileqq'],
    微博: ['weibo', 'com.sina.weibo'],
    // 购物
    淘宝: ['taobao', 'com.taobao.taobao'],
    京东: ['jd', 'com.jingdong.app.mall'],
    拼多多: ['pdd', 'com.xunmeng.pinduoduo'],
    // 外卖
    美团: ['meituan', 'com.sankuai.meituan'],
    饿了么: ['eleme', 'com.ele.me'],
    // 视频
    抖音: ['douyin', 'com.ss.android.ugc.aweme'],
    b站: ['bilibili', 'tv.danmaku.bili'],
    哔哩哔哩: ['bilibili', 'tv.danmaku.bili'],
    // 音乐
    网易云: ['netease', 'com.netease.cloudmusic'],
    qq音乐: ['qqmusic', 'com.tencent.qqmusic'],
    // 导航
    高德: ['amap', 'com.autonavi.minimap'],
    百度地图: ['baidu', 'com.baidu.BaiduMap'],
    // 出行
    滴滴: ['didi', 'com.sdu.didi.psnger'],
    // AI
    豆包: ['doubao', 'com.larus.nova'],
    即梦: ['dream', 'com.bytedance.dreamina'],
  };

  for (const [keyword, keywords] of Object.entries(semanticMap)) {
    if (lowerQuery.includes(keyword)) {
      const semanticMatches = apps.filter((a) =>
        keywords.some(
          (k) =>
            a.label?.toLowerCase().includes(k) ||
            a.package?.toLowerCase().includes(k)
        )
      );
      if (semanticMatches.length > 0) {
        return { apps: semanticMatches, matchType: 'semantic' };
      }
    }
  }

  // 4. 模糊匹配（部分字符匹配）
  const fuzzyMatches = apps.filter((a) => {
    const label = (a.label || '').toLowerCase();
    let matchCount = 0;
    for (const char of lowerQuery) {
      if (label.includes(char)) matchCount++;
    }
    return matchCount >= lowerQuery.length * 0.5;
  });

  return { apps: fuzzyMatches, matchType: 'fuzzy' };
}

/**
 * 获取 Root 状态
 */
export async function isRootAvailable() {
  try {
    const { execShell } = await import('./deviceControl.js');
    const result = await execShell('which su 2>/dev/null && echo "ROOT" || echo "NO_ROOT"');
    return result.output.includes('ROOT');
  } catch {
    return false;
  }
}

/**
 * 执行 Root 命令（需要 Shizuku Root 权限）
 */
export async function execRootCommand(command) {
  try {
    const { execShell } = await import('./deviceControl.js');
    const result = await execShell(`su -c "${command}"`);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || 'Root 命令执行失败');
    }
    return result;
  } catch (error) {
    throw new Error(`Root 命令失败: ${error.message}`);
  }
}
