/**
 * cloudSync 存根 — ai-backend 不含云同步功能，
 * 提供安全默认行为防止 require 崩溃。
 */

function isLoggedIn() { return false; }
async function uploadDataset() { return { success: false, error: '云同步在 ai-backend 中不可用' }; }
async function downloadModel() { return { success: false, error: '云同步在 ai-backend 中不可用' }; }

module.exports = { isLoggedIn, uploadDataset, downloadModel };
