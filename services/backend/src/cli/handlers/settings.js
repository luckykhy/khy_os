/**
 * Settings & auth CLI handlers: cleanup, memory, login, register,
 * logout, whoami, passwd, forgot.
 */
const chalk = require('chalk').default || require('chalk');
const { printSuccess, printError, printInfo } = require('../formatters');

async function handleCleanup(subCommand) {
  const cleanup = require('../../services/cleanupService');
  if (subCommand === 'status') {
    const report = cleanup.getStorageReport();
    const last = typeof cleanup.getLastCleanupReport === 'function'
      ? cleanup.getLastCleanupReport()
      : null;
    console.log(chalk.bold('\n  🧹 存储空间使用\n'));
    console.log(`  安全日志:       ${chalk.white(cleanup.humanSize(report.securityLog.size))}`);
    console.log(`  日志归档:       ${chalk.white(cleanup.humanSize(report.securityLogArchives.size))}`);
    console.log(`  成长快照:       ${chalk.white(cleanup.humanSize(report.growthSnapshots.size))} (${report.growthSnapshots.count} 个)`);
    console.log(`  训练数据:       ${chalk.white(cleanup.humanSize(report.trainingData.size))}`);
    console.log(`  遥测导出:       ${chalk.white(cleanup.humanSize(report.telemetry.size))} (${report.telemetry.count} 个)`);
    console.log(`  对话记录:       ${chalk.white(cleanup.humanSize(report.conversations.size))} (${report.conversations.count} 个)`);
    console.log(chalk.dim('  ' + '─'.repeat(30)));
    console.log(`  总计:           ${chalk.bold(report.totalHuman)}`);
    if (last) {
      const triggerLabel = {
        manual: '手动执行',
        startup: '启动预取任务',
        periodic: '周期任务',
      }[String(last.trigger || '')] || String(last.trigger || 'unknown');
      console.log(chalk.bold('\n  最近一次清理\n'));
      console.log(`  触发来源:       ${chalk.white(triggerLabel)}`);
      console.log(`  处理目标:       ${chalk.white(`${last.targetCount || 0}/${last.targetCount || 0}`)} (失败 ${last.failureCount || 0})`);
      console.log(`  执行耗时:       ${chalk.white(`${last.elapsedMs || 0} ms`)}`);
      console.log(`  释放空间:       ${chalk.white(last.freedHuman || '0 B')}`);
      if (Array.isArray(last.targets) && last.targets.length > 0) {
        console.log(chalk.dim('\n  目标进度:'));
        last.targets.forEach((target, idx) => {
          const state = target.ok ? '成功' : '失败';
          const removed = typeof target.removed === 'number' ? `, 删除 ${target.removed} 项` : '';
          const reclaimed = typeof target.bytes === 'number' ? `, 释放 ${cleanup.humanSize(target.bytes)}` : '';
          const errText = target.ok ? '' : `, 错误 ${target.error || 'unknown'}`;
          console.log(`    ${idx + 1}/${last.targets.length} ${target.name}（${state}, ${target.elapsedMs || 0}ms${removed}${reclaimed}${errText}）`);
        });
      }
    }
    console.log(chalk.dim('\n  运行 cleanup 执行清理'));
    console.log('');
  } else {
    printInfo('执行存储清理（阶段 1/1，目标：安全日志、快照、训练数据、遥测、temp、logs、data/cache、ml/data/cache、系统临时目录）');
    const result = cleanup.runCleanup();
    if (result.summary.actions.length === 0) {
      printSuccess('所有数据在限额内，无需清理');
    } else {
      for (const action of result.summary.actions) {
        printSuccess(action);
      }
      printInfo(`释放空间: ${result.summary.freedHuman}`);
    }
    if (result.summary) {
      printInfo(`清理进度: ${result.summary.targetCount || 0}/${result.summary.targetCount || 0}，失败 ${result.summary.failureCount || 0}，耗时 ${result.summary.elapsedMs || 0}ms`);
    }
  }
}

async function handleMemory() {
  const instructionSvc = require('../../services/instructionFileService');
  const summary = instructionSvc.getInstructionSummary();
  const compatSummary = instructionSvc.getCompatInstructionSummary();
  const LEVEL_LABELS = { global: '全局', project: '项目', directory: '目录' };
  const TYPE_LABELS = { claude: 'CLAUDE', agents: 'AGENTS' };

  console.log(chalk.bold('\n  📋 协作指令文件\n'));
  console.log(chalk.dim('  冲突优先级: khy > claude > agents\n'));
  if (summary.length === 0 && compatSummary.length === 0) {
    printInfo('未找到任何指令文件');
    console.log(chalk.dim(`\n  创建指令文件以定制 AI 行为:`));
    console.log(chalk.dim(`    ~/.khyquant/khy.md    — 全局指令 (所有项目通用)`));
    console.log(chalk.dim(`    <项目>/khy.md         — 项目级指令`));
    console.log(chalk.dim(`    <当前目录>/khy.md     — 目录级指令`));
    console.log(chalk.dim(`    <项目>/CLAUDE.md      — Claude 兼容指令`));
    console.log(chalk.dim(`    <项目>/AGENTS.md      — Agent 兼容指令`));
  } else {
    if (summary.length > 0) {
      console.log(chalk.cyan('  [KHY]'));
      for (const file of summary) {
        const label = LEVEL_LABELS[file.level] || file.level;
        const truncWarning = file.truncated ? chalk.yellow(' (截断)') : '';
        console.log(`    ${chalk.cyan(`[${label}]`)} ${file.path} ${chalk.dim(`(${file.size} 字符)`)}${truncWarning}`);
      }
    }
    if (compatSummary.length > 0) {
      console.log(chalk.cyan('\n  [兼容指令]'));
      for (const file of compatSummary) {
        const label = TYPE_LABELS[file.type] || file.type;
        const truncWarning = file.truncated ? chalk.yellow(' (截断)') : '';
        console.log(`    ${chalk.magenta(`[${label}]`)} ${file.path} ${chalk.dim(`(${file.size} 字符)`)}` + `${truncWarning}`);
      }
    }
    console.log(chalk.dim(`\n  限制: 单文件 ${instructionSvc.MAX_FILE_CHARS} 字符, 合计 ${instructionSvc.MAX_TOTAL_CHARS} 字符`));
  }
  console.log('');
}

async function handleLogin() {
  const cliAuth = require('../../services/cliAuthService');
  const inquirer = require('inquirer');
  const session = cliAuth.checkSession();
  if (session.loggedIn) {
    printInfo(`已登录: ${session.username}`);
    return;
  }
  const answers = await inquirer.prompt([
    { type: 'input', name: 'username', message: '用户名:', validate: v => v.trim().length > 0 || '请输入用户名' },
    { type: 'password', name: 'password', message: '密码:', mask: '*', validate: v => v.length > 0 || '请输入密码' },
  ]);
  const result = await cliAuth.login(answers.username, answers.password);
  if (result.success) printSuccess(`登录成功! 欢迎回来, ${result.username}`);
  else printError(result.error);
}

async function handleRegister() {
  const cliAuth = require('../../services/cliAuthService');
  const inquirer = require('inquirer');
  if (cliAuth.isRegistered()) {
    printInfo('本机已有注册账号。如需重置请删除 ~/.khyquant/credentials.json');
    return;
  }
  const answers = await inquirer.prompt([
    { type: 'input', name: 'username', message: '用户名 (至少 2 字符):', validate: v => v.trim().length >= 2 || '至少 2 个字符' },
    { type: 'password', name: 'password', message: '设置密码 (至少 6 字符):', mask: '*', validate: v => v.length >= 6 || '至少 6 个字符' },
    { type: 'password', name: 'confirm', message: '确认密码:', mask: '*', validate: (v, a) => v === a.password || '两次密码不一致' },
    { type: 'input', name: 'email', message: '邮箱 (可选):', default: '' },
  ]);
  const result = await cliAuth.register(answers.username, answers.password, answers.email || undefined);
  if (result.success) printSuccess(`注册成功! 欢迎, ${result.username}`);
  else printError(result.error);
}

async function handleLogout() {
  const cliAuth = require('../../services/cliAuthService');
  cliAuth.logout();
  printSuccess('已退出登录');
  printInfo('下次启动时需要重新登录');
}

async function handleWhoami() {
  const cliAuth = require('../../services/cliAuthService');
  const user = cliAuth.getCurrentUser();
  if (!user) {
    printInfo('当前未登录');
  } else {
    console.log('');
    console.log(chalk.cyan.bold('  👤 当前用户'));
    console.log(chalk.dim('  ' + '─'.repeat(30)));
    console.log(`  用户名:   ${chalk.bold(user.username)}`);
    if (user.email) console.log(`  邮箱:     ${chalk.dim(user.email)}`);
    console.log(`  注册时间: ${chalk.dim(new Date(user.registeredAt).toLocaleString('zh-CN'))}`);
    console.log(`  登录时间: ${chalk.dim(new Date(user.loginAt).toLocaleString('zh-CN'))}`);
    console.log(`  会话到期: ${chalk.dim(new Date(user.sessionExpires).toLocaleString('zh-CN'))}`);
    console.log('');
  }
}

async function handlePasswd() {
  const cliAuth = require('../../services/cliAuthService');
  const inquirer = require('inquirer');
  const answers = await inquirer.prompt([
    { type: 'password', name: 'oldPassword', message: '当前密码:', mask: '*', validate: v => v.length > 0 || '请输入当前密码' },
    { type: 'password', name: 'newPassword', message: '新密码 (至少 6 字符):', mask: '*', validate: v => v.length >= 6 || '至少 6 个字符' },
    { type: 'password', name: 'confirm', message: '确认新密码:', mask: '*', validate: (v, a) => v === a.newPassword || '两次密码不一致' },
  ]);
  const result = await cliAuth.changePassword(answers.oldPassword, answers.newPassword);
  if (result.success) printSuccess('密码修改成功');
  else printError(result.error);
}

async function handleForgot() {
  const cliAuth = require('../../services/cliAuthService');
  const inquirer = require('inquirer');

  const { method } = await inquirer.prompt([{
    type: 'list',
    name: 'method',
    message: '选择找回方式:',
    choices: [
      { name: '密保问题找回', value: 'security_question' },
      { name: '邮箱验证码找回', value: 'email' },
      { name: '手机验证码找回', value: 'phone' },
    ],
  }]);

  if (method === 'security_question') {
    const { username } = await inquirer.prompt([
      { type: 'input', name: 'username', message: '用户名:', validate: v => v.trim().length > 0 || '请输入用户名' },
    ]);
    const qResult = await cliAuth.getSecurityQuestion(username);
    if (!qResult.success) { printError(qResult.error); return; }

    printInfo(`密保问题: ${qResult.question}`);
    const recovery = await inquirer.prompt([
      { type: 'input', name: 'answer', message: '密保答案:', validate: v => v.trim().length > 0 || '请输入答案' },
      { type: 'password', name: 'newPassword', message: '新密码 (至少 6 字符):', mask: '*', validate: v => v.length >= 6 || '至少 6 个字符' },
      { type: 'password', name: 'confirm', message: '确认新密码:', mask: '*', validate: (v, a) => v === a.newPassword || '两次密码不一致' },
    ]);
    const resetResult = await cliAuth.resetPasswordWithSecurityAnswer(username, recovery.answer, recovery.newPassword);
    if (resetResult.success) printSuccess('密码重置成功! 请使用新密码登录');
    else printError(resetResult.error);

  } else {
    const label = method === 'phone' ? '手机号' : '邮箱';
    const { target } = await inquirer.prompt([
      { type: 'input', name: 'target', message: `注册时的${label}:`, validate: v => v.trim().length >= 3 || `请输入有效${label}` },
    ]);
    printInfo('正在发送验证码...');
    const sendResult = await cliAuth.requestVerificationCode(method, target);
    if (!sendResult.success) { printError(sendResult.error); return; }
    printSuccess(sendResult.message);

    const recovery = await inquirer.prompt([
      { type: 'input', name: 'code', message: '验证码:', validate: v => v.trim().length >= 4 || '请输入验证码' },
      { type: 'password', name: 'newPassword', message: '新密码 (至少 6 字符):', mask: '*', validate: v => v.length >= 6 || '至少 6 个字符' },
      { type: 'password', name: 'confirm', message: '确认新密码:', mask: '*', validate: (v, a) => v === a.newPassword || '两次密码不一致' },
    ]);
    const resetResult = await cliAuth.resetPasswordWithVerificationCode(method, target, recovery.code, recovery.newPassword);
    if (resetResult.success) printSuccess('密码重置成功! 请使用新密码登录');
    else printError(resetResult.error);
  }
}

module.exports = {
  handleCleanup,
  handleMemory,
  handleLogin,
  handleRegister,
  handleLogout,
  handleWhoami,
  handlePasswd,
  handleForgot,
};
