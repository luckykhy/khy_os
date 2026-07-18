/**
 * Cloud sync and user profile CLI handlers.
 */
const chalk = (() => { const c = require('chalk'); return c.default || c; })();
const { printSuccess, printError, printInfo } = require('../formatters');

async function handleProfile(subCommand, args, options) {
  const userProfile = require('../../services/userProfile');

  if (subCommand === 'export') {
    const json = userProfile.exportProfile();
    const outPath = args[0] || 'khy-profile.json';
    require('fs').writeFileSync(outPath, json, 'utf-8');
    printSuccess(`画像已导出到: ${outPath}`);
  } else if (subCommand === 'import') {
    const filePath = args[0];
    if (!filePath) { printError('用法: profile import <file.json>'); return; }
    try {
      const json = require('fs').readFileSync(filePath, 'utf-8');
      userProfile.importProfile(json);
      printSuccess('画像已导入并合并');
    } catch (e) { printError(`导入失败: ${e.message}`); }
  } else if (subCommand === 'reset') {
    userProfile.resetProfile();
    printSuccess('画像已重置');
  } else {
    // Default: show profile summary
    const summary = userProfile.getProfileSummary();
    console.log('');
    console.log(chalk.cyan.bold('  📊 用户画像'));
    console.log(chalk.dim('  ' + '─'.repeat(40)));
    console.log(`  会话次数: ${chalk.bold(summary.sessions)}`);
    console.log(`  命令总数: ${chalk.bold(summary.totalCommands)}`);
    console.log(`  熟练度:   ${chalk.bold(summary.skillLevel === 'beginner' ? '新手' : summary.skillLevel === 'intermediate' ? '进阶' : '高级')}`);
    if (summary.topSymbols.length > 0)
      console.log(`  常用品种: ${chalk.green(summary.topSymbols.join(', '))}`);
    if (summary.topCommands.length > 0)
      console.log(`  常用命令: ${chalk.green(summary.topCommands.join(', '))}`);
    if (summary.favoriteSymbols.length > 0)
      console.log(`  收藏品种: ${chalk.yellow(summary.favoriteSymbols.join(', '))}`);
    console.log(chalk.dim(`  设备ID:   ${summary.deviceId}`));
    console.log('');
    printInfo('profile export — 导出画像 (跨设备同步)');
    printInfo('profile import <file> — 导入画像');
    console.log('');
  }
}

async function handleCloud(subCommand, args, options) {
  const cloud = require('../../services/cloudSync');

  if (subCommand === 'login') {
    const { promptCompat } = require('../uiPrompt');
    const { username, password } = await promptCompat([
      { type: 'input', name: 'username', message: '用户名:', validate: v => v.trim().length >= 3 || '至少3个字符' },
      { type: 'password', name: 'password', message: '密码:', mask: '*', validate: v => v.length >= 6 || '至少6个字符' },
    ]);
    if (!username || !password) { printInfo('已取消登录'); return; }
    printInfo('登录中...');
    try {
      const result = await cloud.login(username, password);
      if (result.success) printSuccess(`${result.message} — 欢迎回来, ${username}!`);
      else printError(result.message);
    } catch (e) { printError(`网络错误: ${e.message}`); }
  } else if (subCommand === 'register') {
    const { promptCompat } = require('../uiPrompt');
    const { username, password, confirm } = await promptCompat([
      { type: 'input', name: 'username', message: '设置用户名:', validate: v => v.trim().length >= 3 || '至少3个字符' },
      { type: 'password', name: 'password', message: '设置密码:', mask: '*', validate: v => v.length >= 6 || '至少6个字符' },
      { type: 'password', name: 'confirm', message: '确认密码:', mask: '*' },
    ]);
    if (!username || !password) { printInfo('已取消注册'); return; }
    if (password !== confirm) { printError('两次密码不一致'); return; }
    printInfo('注册中...');
    try {
      const result = await cloud.register(username, password);
      if (result.success) printSuccess(`${result.message} — 已自动登录`);
      else printError(result.message);
    } catch (e) { printError(`网络错误: ${e.message}`); }
  } else if (subCommand === 'logout') {
    cloud.logout();
    printSuccess('已退出登录');
  } else if (subCommand === 'on' || subCommand === 'enable') {
    if (!cloud.isLoggedIn()) {
      printError('请先登录: cloud login');
      return;
    }
    cloud.enableCloud();
    printSuccess('云同步已开启');
  } else if (subCommand === 'off' || subCommand === 'disable') {
    cloud.disableCloud();
    printSuccess('云同步已关闭');
  } else if (subCommand === 'sync') {
    if (!cloud.isLoggedIn()) { printError('请先登录: cloud login'); return; }
    printInfo('正在同步...');
    const up = await cloud.syncUpload();
    if (up.success) printSuccess('画像已上传到云端');
    else printError(`上传失败: ${up.reason}`);
  } else if (subCommand === 'pull') {
    if (!cloud.isLoggedIn()) { printError('请先登录: cloud login'); return; }
    printInfo('正在拉取...');
    const down = await cloud.syncDownload();
    if (down.success) printSuccess('已从云端合并画像');
    else printError(`拉取失败: ${down.reason}`);
  } else if (subCommand === 'endpoint') {
    if (args[0]) {
      cloud.setEndpoint(args[0]);
      printSuccess(`云端地址已设为: ${args[0]}`);
    } else {
      console.log(`  当前地址: ${chalk.cyan(cloud.getEndpoint())}`);
      printInfo('用法: cloud endpoint https://new-domain.com');
    }
  } else {
    // Show status
    const config = cloud.loadCloudConfig();
    console.log('');
    console.log(chalk.cyan.bold('  ☁️  云同步状态'));
    console.log(chalk.dim('  ' + '─'.repeat(40)));
    if (config.username) {
      console.log(`  账号:     ${chalk.green(config.username)} ✓`);
    } else {
      console.log(`  账号:     ${chalk.yellow('未登录')}`);
    }
    console.log(`  状态:     ${config.enabled ? chalk.green('已开启') : chalk.yellow('未开启')}`);
    console.log(`  统计上报: ${config.telemetryEnabled ? chalk.green('✓') : chalk.dim('✗')}`);
    console.log(`  画像同步: ${config.syncEnabled ? chalk.green('✓') : chalk.dim('✗')}`);
    console.log(`  端点:     ${chalk.dim(config.endpoint || require('../../constants/serviceDefaults').CLOUD_DEFAULT_ENDPOINT)}`);
    if (config.lastSync) console.log(`  上次同步: ${chalk.dim(config.lastSync)}`);
    console.log('');
    if (!config.username) {
      printInfo('cloud register — 注册新账号');
      printInfo('cloud login — 登录已有账号');
    } else {
      printInfo('cloud sync — 上传画像 · cloud pull — 拉取画像');
      printInfo('cloud logout — 退出登录');
    }
    printInfo('cloud endpoint <url> — 修改服务器地址');
    console.log('');
  }
}

module.exports = { handleProfile, handleCloud };
