'use strict';

const { version } = require('../../../services/backend/package.json');

function handleStandaloneInfo(moduleName, description, usage, args = process.argv.slice(2)) {
  if (args.includes('--version') || args.includes('-v') || args.includes('-V')) {
    console.log(version);
    return true;
  }

  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log(`${moduleName} ${version}`);
    console.log(description);
    console.log(`Usage: ${usage}`);
    return true;
  }

  return false;
}

module.exports = { handleStandaloneInfo };
