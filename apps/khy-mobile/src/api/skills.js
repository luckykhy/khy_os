// khy.skills —— Skills 层（用户意图映射）
//
// 架构：Tools + Skills 双层 Agent 框架
// - Tools 层：原子能力（search_apps, open_app, deep_link 等）
// - Skills 层：面向用户的任务层，将自然语言映射到具体操作
//
// 两种执行模式：
// 1. Delegation（委托）：高置信度匹配时，直接通过 DeepLink 打开有 AI 能力的 App
// 2. GUI 自动化：没有 AI 能力的 App，通过截图-分析-操作循环完成
//
// 参考：肉包 Roubao (https://github.com/Turbo1123/roubao)

import { scoreSkill, matchSkill } from './programRuntime.js';
import { executeLocalTool } from './localTools.js';
import { listApps } from './deviceControl.js';

/**
 * Skill 类型
 */
export const SkillType = {
  DELEGATION: 'delegation',   // 委托模式（DeepLink 直达）
  GUI: 'gui',                 // GUI 自动化模式
};

/**
 * 内置 Skills 定义
 */
export const BUILT_IN_SKILLS = [
  // 外卖类
  {
    name: 'order-meituan',
    label: '点外卖（美团）',
    description: '在美团 App 上点外卖',
    keywords: ['美团', '外卖', '点餐', '饿了么', '吃', '饭', '餐'],
    type: SkillType.GUI,
    steps: [
      '打开美团 App',
      '搜索或选择餐厅',
      '选择菜品并加入购物车',
      '确认订单并支付',
    ],
  },
  {
    name: 'order-eleme',
    label: '点外卖（饿了么）',
    description: '在饿了么 App 上点外卖',
    keywords: ['饿了么', '外卖', '点餐', '吃', '饭'],
    type: SkillType.GUI,
    steps: [
      '打开饿了么 App',
      '搜索或选择餐厅',
      '选择菜品并加入购物车',
      '确认订单并支付',
    ],
  },
  // 导航类
  {
    name: 'navigate-amap',
    label: '导航（高德）',
    description: '使用高德地图导航到目的地',
    keywords: ['高德', '导航', '去', '到', '路', '怎么走'],
    type: SkillType.DELEGATION,
    app: 'amap',
    deepLink: 'androidamap://poi?sourceApplication=Khy&dev=0',
  },
  {
    name: 'navigate-baidu',
    label: '导航（百度地图）',
    description: '使用百度地图导航到目的地',
    keywords: ['百度', '导航', '去', '到', '路', '地图'],
    type: SkillType.DELEGATION,
    app: 'baidu',
    deepLink: 'baidumap://',
  },
  // 打车类
  {
    name: 'taxi-didi',
    label: '打车（滴滴）',
    description: '使用滴滴出行叫车',
    keywords: ['滴滴', '打车', '叫车', '出租车', '网约车', '出行'],
    type: SkillType.DELEGATION,
    app: 'didi',
    deepLink: 'diditaxi://x.open',
  },
  // 社交类
  {
    name: 'chat-wechat',
    label: '发微信',
    description: '打开微信发消息',
    keywords: ['微信', '发消息', '聊天', '给', '发'],
    type: SkillType.GUI,
    steps: [
      '打开微信',
      '搜索联系人',
      '发送消息',
    ],
  },
  // 娱乐类
  {
    name: 'video-bilibili',
    label: '看视频（B站）',
    description: '打开 B 站看视频',
    keywords: ['b站', '哔哩哔哩', 'bilibili', '视频', '动画', '番剧'],
    type: SkillType.DELEGATION,
    app: 'bilibili',
    deepLink: 'bilibili://pegasus/channel/hot',
  },
  {
    name: 'music-netease',
    label: '听音乐（网易云）',
    description: '打开网易云音乐',
    keywords: ['网易云', '音乐', '听歌', '歌曲', '播放'],
    type: SkillType.DELEGATION,
    app: 'netease',
    deepLink: 'orpheus://',
  },
  // AI 工具类
  {
    name: 'ai-draw',
    label: 'AI 画图',
    description: '使用 AI 生成图片',
    keywords: ['画图', '生成图片', 'AI', '绘画', '作图', '生图'],
    type: SkillType.DELEGATION,
    app: 'dream',
    deepLink: 'dreamina://',
  },
  // 购物类
  {
    name: 'shop-taobao',
    label: '淘宝购物',
    description: '打开淘宝购物',
    keywords: ['淘宝', '天猫', '购物', '买', '商品', '下单'],
    type: SkillType.DELEGATION,
    app: 'taobao',
    deepLink: 'taobao://s.taobao.com',
  },
  // 知乎
  {
    name: 'browse-zhihu',
    label: '知乎',
    description: '打开知乎浏览内容',
    keywords: ['知乎', '知识', '问答', '阅读'],
    type: SkillType.DELEGATION,
    app: 'zhihu',
    deepLink: 'zhihu://',
  },
];

/**
 * Skill 管理器
 */
class SkillManager {
  constructor() {
    this.skills = [...BUILT_IN_SKILLS];
    this.customSkills = [];
  }

  /**
   * 注册自定义 Skill
   */
  registerSkill(skill) {
    this.customSkills.push(skill);
  }

  /**
   * 获取所有 Skills
   */
  getAllSkills() {
    return [...this.skills, ...this.customSkills];
  }

  /**
   * 意图识别：匹配用户输入到最合适的 Skill
   */
  matchIntent(userInput) {
    const allSkills = this.getAllSkills();
    const ranked = allSkills
      .map((skill) => ({ skill, score: scoreSkill(skill, userInput) }))
      .filter((x) => x.score >= 3)
      .sort((a, b) => b.score - a.score);

    return ranked[0] || null;
  }

  /**
   * 执行 Skill
   */
  async execute(skillName, userInput, options = {}) {
    const skill = this.getAllSkills().find((s) => s.name === skillName);
    if (!skill) throw new Error(`未找到 Skill: ${skillName}`);

    if (skill.type === SkillType.DELEGATION) {
      return this.executeDelegation(skill, userInput, options);
    } else {
      return this.executeGUI(skill, userInput, options);
    }
  }

  /**
   * Delegation 模式：直接 DeepLink 跳转
   */
  async executeDelegation(skill, userInput, options = {}) {
    const { onProgress } = options;

    // 查找对应应用
    const appResult = await listApps(skill.app || skill.label);
    const apps = appResult?.apps || [];

    if (apps.length === 0) {
      return {
        success: false,
        mode: SkillType.DELEGATION,
        message: `未安装 ${skill.label} 相关应用`,
      };
    }

    const target = apps[0];
    onProgress?.({ phase: 'open_app', app: target.label, package: target.package });

    // 尝试 DeepLink
    if (skill.deepLink) {
      try {
        const { App } = await import('@capacitor/app');
        await App.openUrl({ url: skill.deepLink });
        return {
          success: true,
          mode: SkillType.DELEGATION,
          message: `已通过 DeepLink 跳转到 ${target.label}`,
          app: target,
        };
      } catch {
        // DeepLink 失败，尝试直接启动
      }
    }

    // 直接启动应用
    try {
      const { startActivity } = await import('./deviceControl.js');
      await startActivity(target.package);
      return {
        success: true,
        mode: SkillType.DELEGATION,
        message: `已启动 ${target.label}`,
        app: target,
      };
    } catch (error) {
      return {
        success: false,
        mode: SkillType.DELEGATION,
        message: `启动失败: ${error.message}`,
      };
    }
  }

  /**
   * GUI 自动化模式
   */
  async executeGUI(skill, userInput, options = {}) {
    const { onProgress, baseUrl, apiKey, model } = options;

    onProgress?.({
      phase: 'start',
      skill: skill.name,
      type: SkillType.GUI,
      steps: skill.steps,
    });

    // GUI 自动化通过 Agent 循环完成
    // 返回 Skill 信息，由 Agent 执行具体操作
    return {
      success: true,
      mode: SkillType.GUI,
      skill,
      message: `使用 GUI 自动化执行: ${skill.label}`,
    };
  }

  /**
   * 获取 Skill 列表（供 UI 显示）
   */
  getSkillList() {
    return this.getAllSkills().map((s) => ({
      name: s.name,
      label: s.label,
      description: s.description,
      type: s.type,
      keywords: s.keywords,
    }));
  }
}

// 单例
let skillManagerInstance = null;

export function getSkillManager() {
  if (!skillManagerInstance) {
    skillManagerInstance = new SkillManager();
  }
  return skillManagerInstance;
}

export { SkillManager, BUILT_IN_SKILLS };
