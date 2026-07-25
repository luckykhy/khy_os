/**
 * AKShare Auto-Update Service
 * Detects and upgrades to the latest AKShare version when network is available.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');
const fs = require('fs');
const https = require('https');

class AKShareUpdater {
  constructor() {
    this.checkInterval = 24 * 60 * 60 * 1000; // 24 hours
    this.lastCheckFile = path.join(__dirname, '../../temp/akshare_version_check.json');
    this.updateLogFile = path.join(__dirname, '../../temp/akshare_update.log');
    this.isUpdating = false;
    this.currentVersion = null;
    this.latestVersion = null;
    this.lastCheckTime = null;
    this.updateHistory = [];

    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    this.loadCheckRecord();
  }

  loadCheckRecord() {
    try {
      if (fs.existsSync(this.lastCheckFile)) {
        const data = JSON.parse(fs.readFileSync(this.lastCheckFile, 'utf-8'));
        this.lastCheckTime = data.lastCheckTime;
        this.currentVersion = data.currentVersion;
        this.updateHistory = data.updateHistory || [];
      }
    } catch (e) {
      // Ignore corrupt file
    }
  }

  saveCheckRecord() {
    try {
      fs.writeFileSync(this.lastCheckFile, JSON.stringify({
        lastCheckTime: this.lastCheckTime,
        currentVersion: this.currentVersion,
        latestVersion: this.latestVersion,
        updateHistory: this.updateHistory.slice(-20)
      }, null, 2));
    } catch (e) {
      // Non-critical
    }
  }

  getPythonCmd() {
    try {
      const { findPython } = require('../utils/pythonPath');
      return findPython();
    } catch (e) {
      return process.platform === 'win32' ? 'python' : 'python3';
    }
  }

  async checkNetwork() {
    return new Promise((resolve) => {
      const req = https.get('https://pypi.org/pypi/akshare/json', { timeout: 5000 }, (res) => {
        resolve(res.statusCode === 200);
        res.resume(); // drain response
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  async getCurrentVersion() {
    try {
      const pythonCmd = this.getPythonCmd();
      const { stdout } = await execAsync(
        `${pythonCmd} -c "import akshare; print(akshare.__version__)"`,
        { timeout: 10000 }
      );
      return stdout.trim();
    } catch (e) {
      try {
        const { stdout } = await execAsync('pip show akshare', { timeout: 10000 });
        const match = stdout.match(/Version:\s*(.+)/);
        return match ? match[1].trim() : null;
      } catch (e2) {
        return null;
      }
    }
  }

  async getLatestVersion() {
    return new Promise((resolve) => {
      const req = https.get('https://pypi.org/pypi/akshare/json', { timeout: 8000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.info.version);
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  isNewerVersion(latest, current) {
    if (!latest || !current) return false;
    const lp = latest.split('.').map(Number);
    const cp = current.split('.').map(Number);
    for (let i = 0; i < Math.max(lp.length, cp.length); i++) {
      const l = lp[i] || 0;
      const c = cp[i] || 0;
      if (l > c) return true;
      if (l < c) return false;
    }
    return false;
  }

  async performUpgrade() {
    if (this.isUpdating) {
      return { success: false, message: 'Upgrade already in progress' };
    }

    this.isUpdating = true;
    const startTime = Date.now();
    const fromVersion = this.currentVersion;

    console.log(`🔄 Upgrading AKShare: ${fromVersion} → ${this.latestVersion}`);

    try {
      // --break-system-packages needed for PEP 668 (externally-managed Python in containers)
      await execAsync(
        `pip install akshare==${this.latestVersion} --upgrade --quiet --break-system-packages`,
        { timeout: 120000 }
      );

      const newVersion = await this.getCurrentVersion();

      if (newVersion === this.latestVersion) {
        const record = {
          time: new Date().toISOString(),
          fromVersion,
          toVersion: this.latestVersion,
          duration: Math.round((Date.now() - startTime) / 1000) + 's',
          success: true
        };

        this.updateHistory.push(record);
        this.currentVersion = newVersion;
        this.saveCheckRecord();
        this.writeLog(`✅ Upgraded: ${record.fromVersion} → ${record.toVersion} (${record.duration})`);
        console.log(`✅ AKShare upgraded: ${record.fromVersion} → ${record.toVersion}`);
        return { success: true, ...record };
      } else {
        throw new Error(`Version mismatch after upgrade: expected ${this.latestVersion}, got ${newVersion}`);
      }
    } catch (error) {
      const record = {
        time: new Date().toISOString(),
        fromVersion,
        toVersion: this.latestVersion,
        error: error.message,
        success: false
      };

      this.updateHistory.push(record);
      this.saveCheckRecord();
      this.writeLog(`❌ Upgrade failed: ${error.message}`);
      console.error('❌ AKShare upgrade failed:', error.message);
      return { success: false, error: error.message };
    } finally {
      this.isUpdating = false;
    }
  }

  writeLog(message) {
    try {
      fs.appendFileSync(this.updateLogFile, `[${new Date().toISOString()}] ${message}\n`);
    } catch (e) { /* non-critical */ }
  }

  async checkAndUpdate(force = false) {
    if (!force && this.lastCheckTime) {
      const hoursSince = (Date.now() - new Date(this.lastCheckTime).getTime()) / (1000 * 60 * 60);
      if (hoursSince < 24) {
        return { skipped: true, reason: 'too_soon', hoursSinceLastCheck: +hoursSince.toFixed(1) };
      }
    }

    console.log('🔍 Checking AKShare version...');

    const networkOk = await this.checkNetwork();
    if (!networkOk) {
      console.log('⚠️ Network unavailable, skipping AKShare version check');
      return { skipped: true, reason: 'no_network' };
    }

    this.currentVersion = await this.getCurrentVersion();
    this.latestVersion = await this.getLatestVersion();
    this.lastCheckTime = new Date().toISOString();

    console.log(`📦 AKShare current: ${this.currentVersion}, PyPI latest: ${this.latestVersion}`);

    if (!this.currentVersion) {
      this.saveCheckRecord();
      return { skipped: true, reason: 'version_unknown' };
    }

    if (!this.latestVersion) {
      this.saveCheckRecord();
      return { skipped: true, reason: 'pypi_unavailable' };
    }

    this.saveCheckRecord();

    if (this.isNewerVersion(this.latestVersion, this.currentVersion)) {
      console.log(`🆕 New version ${this.latestVersion} available, upgrading...`);
      return await this.performUpgrade();
    }

    console.log(`✅ AKShare is up to date (${this.currentVersion})`);
    return { upToDate: true, version: this.currentVersion };
  }

  getStatus() {
    return {
      currentVersion: this.currentVersion,
      latestVersion: this.latestVersion,
      lastCheckTime: this.lastCheckTime,
      isUpdating: this.isUpdating,
      updateHistory: this.updateHistory.slice(-5),
      nextCheckIn: this.lastCheckTime
        ? Math.max(0, 24 - (Date.now() - new Date(this.lastCheckTime).getTime()) / (1000 * 60 * 60)).toFixed(1) + ' hours'
        : 'imminent'
    };
  }

  startScheduler() {
    console.log('⏰ AKShare auto-update scheduler started (checks every 24h)');

    // Delay first check by 30s to not slow down startup
    setTimeout(() => {
      this.checkAndUpdate().catch(e => console.error('AKShare initial check failed:', e.message));
    }, 30 * 1000);

    this._schedulerTimer = setInterval(() => {
      this.checkAndUpdate().catch(e => console.error('AKShare scheduled check failed:', e.message));
    }, this.checkInterval);
  }

  stopScheduler() {
    if (this._schedulerTimer) {
      clearInterval(this._schedulerTimer);
      this._schedulerTimer = null;
    }
  }
}

module.exports = new AKShareUpdater();
