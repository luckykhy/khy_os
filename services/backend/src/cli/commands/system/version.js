'use strict';

/**
 * system/version.js — 显示版本号 handler
 */

module.exports = async function handleVersion(parsed, ctx) {
  const { printSuccess } = ctx || {};
  try {
    const v = process.env.KHYQUANT_PKG_VERSION || require('../../package.json').version;
    if (printSuccess) printSuccess(`Khy-OS v${v}`);
    else console.log(`Khy-OS v${v}`);
    return true;
  } catch {
    console.log('Khy-OS version unknown');
    return true;
  }
};
