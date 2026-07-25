/**
 * Compatibility shim — delegates to akshareDataService.
 * The original freeStockDataService was removed in the S9 cleanup.
 * This file exists so that existing require() calls continue to work.
 */
const akshareDataService = require('./akshareDataService');

module.exports = {
  getStockData:              (symbol, opts) => akshareDataService.getStockData(symbol, opts),
  clearExpiredCache:         ()             => akshareDataService.clearExpiredCache(),
  checkAKShareEnvironment:   ()             => akshareDataService.checkEnvironment(),
  installAKShareDependencies:()             => akshareDataService.installDependencies(),
  setAKShareEnabled:         (_enabled)     => { /* no-op — akshare is always the backend now */ },
  getDataSourceStatus:       ()             => ({
    akshare: { enabled: true, status: 'active' },
    source: 'akshareDataService (shim)'
  })
};
