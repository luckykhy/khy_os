// stores/errorNotify.js — khy-mobile 错误通知层（结构化、按 severity 分级）。
//
// 设计目标：
//   1. 单一入口：所有 API 调用、后台事件、Vue 错误都进这里；
//   2. 结构化：每条通知带 category / severity / code / hint，与后端 KhyError 对齐；
//   3. 按 severity 分级渲染：
//        silent → 不渲染（仅审计）
//        info   → 浅色顶栏条，3s 自动消失
//        warn   → 黄色顶栏条，6s 自动消失
//        error  → 红色顶栏条，10s 自动消失，可手动关
//        fatal  → 红色 modal，全屏阻塞，用户必须点 OK 关闭
//   4. 同 code 3s 窗口内去重，避免网络抖动刷屏。
//
// 不直接依赖第三方 toast —— khy-mobile 体量小，加一个本地 banner
// 比带一个完整 UI 库更轻。
import { defineStore } from 'pinia';
import { classifyKhyError } from '../utils/classifyKhyError.mjs';

const DEDUPE_WINDOW_MS = 3000;
const recentCodes = new Map();
let nextId = 1;

function shouldSuppress(code) {
  const now = Date.now();
  const last = recentCodes.get(code);
  for (const [k, t] of recentCodes) {
    if (now - t > DEDUPE_WINDOW_MS) recentCodes.delete(k);
  }
  if (last && now - last < DEDUPE_WINDOW_MS) return true;
  recentCodes.set(code, now);
  return false;
}

export const useErrorNotifyStore = defineStore('error-notify', {
  state: () => ({
    banners: [],
    fatalModal: null,
  }),
  actions: {
    /**
     * 推送一条结构化通知。
     * @param {string|Error|KhyErrorShape} input - 任意错误值
     * @param {{ action?: string, target?: string, progress?: string }} [ctx]
     */
    notify(input, ctx = {}) {
      const env = _ensureKhy(input);
      if (!env) return;
      if (env.severity === 'silent') return;

      const code = env.code || 'UNKNOWN';
      if (shouldSuppress(code)) return;

      const ttl = env.severity === 'fatal' ? 0
        : env.severity === 'error' ? 10000
        : env.severity === 'warn' ? 6000
        : 3000;

      const id = nextId++;
      const banner = {
        id,
        code,
        category: env.category || 'unknown',
        severity: env.severity || 'error',
        title: _categoryLabel(env.category),
        message: env.message || code,
        hint: env.hint || '',
        ctx,
        createdAt: Date.now(),
        ttl,
      };

      if (env.severity === 'fatal') {
        this.fatalModal = banner;
        return;
      }
      this.banners.push(banner);
      if (ttl > 0) {
        setTimeout(() => this.dismiss(id), ttl);
      }
    },

    dismiss(id) {
      this.banners = this.banners.filter((b) => b.id !== id);
    },
    dismissFatal() {
      this.fatalModal = null;
    },
  },
});

function _ensureKhy(input) {
  if (!input) return null;
  if (input && input.isKhyError === true && typeof input.code === 'string') return input;
  if (input && typeof input.code === 'string' && (input.category || input.severity)) return input;
  return classifyKhyError(input, { fallbackCode: 'UNKNOWN' });
}

function _categoryLabel(category) {
  const map = {
    user: '操作提示',
    config: '配置问题',
    auth: '鉴权失败',
    network: '网络异常',
    upstream: '上游服务',
    io: '本地异常',
    resource: '系统资源',
    internal: '内部错误',
    unknown: '提示',
  };
  return map[category] || '提示';
}