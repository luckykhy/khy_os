/**
 * growthService 存根 — ai-backend 不含成长型学习引擎，
 * 提供安全默认行为防止 require 崩溃。
 */

function recordInteraction() {}
function getGrowthLevel() { return { level: 0, label: '未启用' }; }
function getGrowthStats() { return { interactions: 0, level: 0 }; }
async function suggestLearning() { return []; }

module.exports = { recordInteraction, getGrowthLevel, getGrowthStats, suggestLearning };
