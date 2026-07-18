/**
 * Antivirus Service — ClamAV integration for Ubuntu server security.
 *
 * Provides virus scanning, definition updates, and quarantine
 * management for khy OS server deployments.
 *
 * Supports:
 *   - ClamAV (clamscan / clamdscan)
 *   - chkrootkit (rootkit detection)
 *   - rkhunter (rootkit hunter)
 */
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const QUARANTINE_DIR = path.join(os.homedir(), '.khyquant', 'quarantine');
const SCAN_LOG = path.join(os.homedir(), '.khyquant', 'scan.log');
const BACKEND_ROOT = process.env.KHYQUANT_ROOT || path.resolve(__dirname, '..', '..');

let _scanTimer = null;

/**
 * Detect which antivirus tools are available.
 */
function detectTools() {
  const tools = {
    clamscan: commandExists('clamscan'),
    clamdscan: commandExists('clamdscan'),
    freshclam: commandExists('freshclam'),
    chkrootkit: commandExists('chkrootkit'),
    rkhunter: commandExists('rkhunter'),
  };

  tools.hasClamAV = tools.clamscan || tools.clamdscan;
  tools.scanCommand = tools.clamdscan ? 'clamdscan' : tools.clamscan ? 'clamscan' : null;

  return tools;
}

function commandExists(cmd) {
  const { searchExecutable } = require('../tools/platformUtils');
  return !!searchExecutable(cmd);
}

/**
 * Get ClamAV install instructions for the current platform.
 */
function getInstallInstructions() {
  const platform = os.platform();
  if (platform === 'linux') {
    // Detect distro
    let distro = 'linux';
    try {
      const release = execSync('cat /etc/os-release 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
      if (/ubuntu|debian/i.test(release)) distro = 'debian';
      else if (/centos|rhel|fedora/i.test(release)) distro = 'rhel';
      else if (/arch/i.test(release)) distro = 'arch';
    } catch { /* ignore */ }

    switch (distro) {
      case 'debian':
        return {
          install: 'sudo apt update && sudo apt install -y clamav clamav-daemon chkrootkit rkhunter',
          update: 'sudo systemctl stop clamav-freshclam && sudo freshclam && sudo systemctl start clamav-freshclam',
          enable: 'sudo systemctl enable clamav-daemon && sudo systemctl start clamav-daemon',
        };
      case 'rhel':
        return {
          install: 'sudo yum install -y clamav clamd chkrootkit rkhunter',
          update: 'sudo freshclam',
          enable: 'sudo systemctl enable clamd && sudo systemctl start clamd',
        };
      case 'arch':
        return {
          install: 'sudo pacman -S clamav rkhunter',
          update: 'sudo freshclam',
          enable: 'sudo systemctl enable clamav-daemon && sudo systemctl start clamav-daemon',
        };
      default:
        return {
          install: 'Install ClamAV for your distribution',
          update: 'sudo freshclam',
          enable: 'Enable ClamAV daemon service',
        };
    }
  }

  if (platform === 'darwin') {
    return {
      install: 'brew install clamav',
      update: 'freshclam',
      enable: 'brew services start clamav',
    };
  }

  return {
    install: 'Download ClamAV from https://www.clamav.net/',
    update: 'freshclam',
    enable: 'Start ClamAV service',
  };
}

/**
 * Update ClamAV virus definitions.
 * @returns {{ success: boolean, message: string }}
 */
function updateDefinitions() {
  const tools = detectTools();
  if (!tools.freshclam) {
    return { success: false, message: 'freshclam not installed' };
  }

  try {
    // Try without sudo first (works if user has permissions)
    const output = execSync('freshclam 2>&1 || sudo freshclam 2>&1', {
      encoding: 'utf-8',
      timeout: 120_000, // 2 min for downloads
      stdio: 'pipe',
    });
    logScan({ type: 'definition_update', success: true, output: output.slice(0, 500) });
    return { success: true, message: output.trim() };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Scan a file or directory for viruses.
 * @param {string} targetPath - path to scan
 * @param {object} [opts]
 * @param {boolean} [opts.recursive=true]
 * @param {boolean} [opts.quarantine=true] - move infected to quarantine
 * @param {number} [opts.maxFileSize] - skip files larger than this (MB)
 * @returns {{ clean: boolean, infected: number, scanned: number, threats: Array, elapsed: number }}
 */
function scan(targetPath, opts = {}) {
  const tools = detectTools();
  if (!tools.scanCommand) {
    return { clean: true, infected: 0, scanned: 0, threats: [], elapsed: 0, error: 'ClamAV not installed' };
  }

  const startTime = Date.now();
  const recursive = opts.recursive !== false;
  const maxSize = opts.maxFileSize || 100; // 100MB default

  // Build scan command
  const args = [
    '--infected',                          // only show infected
    '--no-summary',                        // machine-parsable output
    `--max-filesize=${maxSize}M`,
    `--max-scansize=${maxSize * 2}M`,
  ];

  if (recursive) args.push('-r');

  // Use quarantine if requested
  if (opts.quarantine !== false) {
    ensureQuarantineDir();
    args.push(`--move=${QUARANTINE_DIR}`);
  }

  const cmd = `${tools.scanCommand} ${args.join(' ')} "${targetPath}" 2>&1`;

  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 300_000, // 5 min max
      stdio: 'pipe',
      maxBuffer: 10 * 1024 * 1024,
    });

    const threats = parseThreats(output);
    const elapsed = Date.now() - startTime;
    const result = {
      clean: threats.length === 0,
      infected: threats.length,
      scanned: countScanned(output),
      threats,
      elapsed,
    };

    logScan({ type: 'scan', target: targetPath, ...result });
    return result;
  } catch (err) {
    // ClamAV exits with code 1 if virus found (not an error)
    if (err.status === 1 && err.stdout) {
      const threats = parseThreats(err.stdout);
      const elapsed = Date.now() - startTime;
      const result = {
        clean: threats.length === 0,
        infected: threats.length,
        scanned: countScanned(err.stdout),
        threats,
        elapsed,
      };
      logScan({ type: 'scan', target: targetPath, ...result });
      return result;
    }

    return { clean: true, infected: 0, scanned: 0, threats: [], elapsed: Date.now() - startTime, error: err.message };
  }
}

/**
 * Quick scan of khy OS project files.
 */
function scanProject() {
  return scan(BACKEND_ROOT, { recursive: true, maxFileSize: 50 });
}

/**
 * Scan home directory (common target for malware).
 */
function scanHome() {
  return scan(os.homedir(), { recursive: true, maxFileSize: 100 });
}

/**
 * Run rootkit check (requires chkrootkit or rkhunter).
 * @returns {{ clean: boolean, tool: string, output: string }}
 */
function checkRootkit() {
  const tools = detectTools();

  if (tools.chkrootkit) {
    try {
      const output = execSync('sudo chkrootkit 2>&1 | grep -i "INFECTED\\|vulnerable\\|suspicious" || echo "CLEAN"', {
        encoding: 'utf-8',
        timeout: 120_000,
        stdio: 'pipe',
      });

      const clean = output.trim() === 'CLEAN' || !output.includes('INFECTED');
      logScan({ type: 'rootkit', tool: 'chkrootkit', clean });
      return { clean, tool: 'chkrootkit', output: output.trim() };
    } catch (err) {
      return { clean: true, tool: 'chkrootkit', output: err.message };
    }
  }

  if (tools.rkhunter) {
    try {
      const output = execSync('sudo rkhunter --check --skip-keypress --report-warnings-only 2>&1 || true', {
        encoding: 'utf-8',
        timeout: 300_000,
        stdio: 'pipe',
      });

      const clean = !output.includes('Warning:') && !output.includes('infected');
      logScan({ type: 'rootkit', tool: 'rkhunter', clean });
      return { clean, tool: 'rkhunter', output: output.trim() };
    } catch (err) {
      return { clean: true, tool: 'rkhunter', output: err.message };
    }
  }

  return { clean: true, tool: 'none', output: 'No rootkit scanner installed (chkrootkit / rkhunter)' };
}

/**
 * List quarantined files.
 */
function listQuarantine() {
  ensureQuarantineDir();
  try {
    const files = fs.readdirSync(QUARANTINE_DIR);
    return files.map(f => {
      const fp = path.join(QUARANTINE_DIR, f);
      const stat = fs.statSync(fp);
      return {
        name: f,
        path: fp,
        size: stat.size,
        quarantinedAt: stat.mtime.toISOString(),
      };
    });
  } catch { return []; }
}

/**
 * Delete a quarantined file permanently.
 */
function deleteQuarantined(filename) {
  const fp = path.join(QUARANTINE_DIR, filename);
  if (!fp.startsWith(QUARANTINE_DIR)) return false; // path traversal guard
  try {
    fs.unlinkSync(fp);
    return true;
  } catch { return false; }
}

/**
 * Start periodic background scanning.
 * @param {number} [intervalMs=21600000] - default 6 hours
 */
function startPeriodicScan(intervalMs = 6 * 3600_000) {
  if (_scanTimer) return;

  // Skip on lightweight/server-minimal
  if (process.env.KHY_LIGHTWEIGHT === 'true') return;

  const tools = detectTools();
  if (!tools.hasClamAV) return;

  _scanTimer = setInterval(() => {
    try {
      const result = scanProject();
      if (!result.clean) {
        // Log warning — in REPL context this would show a notification
        logScan({ type: 'periodic_scan', threats: result.threats.length, infected: result.infected });
      }
    } catch { /* periodic scan must never crash */ }
  }, intervalMs);

  _scanTimer.unref();
}

function stopPeriodicScan() {
  if (_scanTimer) {
    clearInterval(_scanTimer);
    _scanTimer = null;
  }
}

/**
 * Get overall security status (combined scan + integrity + threats).
 */
function getSecurityStatus() {
  const tools = detectTools();
  const quarantine = listQuarantine();

  return {
    clamavInstalled: tools.hasClamAV,
    scanCommand: tools.scanCommand,
    rootkitScanner: tools.chkrootkit ? 'chkrootkit' : tools.rkhunter ? 'rkhunter' : null,
    quarantinedFiles: quarantine.length,
    installInstructions: tools.hasClamAV ? null : getInstallInstructions(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function ensureQuarantineDir() {
  if (!fs.existsSync(QUARANTINE_DIR)) {
    fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
  }
}

function parseThreats(output) {
  if (!output) return [];
  const threats = [];
  const lines = output.split('\n');
  for (const line of lines) {
    // ClamAV format: /path/to/file: VirusName FOUND
    const match = line.match(/^(.+?):\s+(.+?)\s+FOUND\s*$/);
    if (match) {
      threats.push({ file: match[1].trim(), virus: match[2].trim() });
    }
  }
  return threats;
}

function countScanned(output) {
  // Try to extract from summary line
  const match = (output || '').match(/Scanned files:\s*(\d+)/i);
  return match ? parseInt(match[1]) : 0;
}

function logScan(entry) {
  try {
    const dir = path.dirname(SCAN_LOG);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(SCAN_LOG, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* best effort */ }
}

module.exports = {
  detectTools,
  getInstallInstructions,
  updateDefinitions,
  scan,
  scanProject,
  scanHome,
  checkRootkit,
  listQuarantine,
  deleteQuarantined,
  startPeriodicScan,
  stopPeriodicScan,
  getSecurityStatus,
};
