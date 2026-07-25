'use strict';

/**
 * envFingerprintScanner.js — 环境刺探与指纹提取器（§3.1）。
 *
 * Khyos 落地某环境的第一件事不是加载通用配置，而是物理刺探：精确识别内核运行时、清点可用
 * 的高特权接口、画出资源画像。这份指纹是后续一切原生亲和路由与平台特异性调用的**唯一前提**
 * ——没有指纹，绝不允许盲目触碰任何平台特异性 API（防呆③）。
 *
 * 探针（probe）全部注入式：真实运行读 process/os，单测注入假探针即可确定性复现任意环境
 * （Windows/Android/HarmonyOS 都能在一台 Linux CI 上被精确模拟）。扫描本身纯函数式、无副作用，
 * 不缓存可变状态，契合「核心状态机无状态跨平台一致」（防呆④）。
 */

const {
  PLATFORM, KERNEL_SIGNATURES, topologyFor, isPlatform,
} = require('./platformIds');

/** 各环境「高特权接口」候选清单（§3.1 能力清单）——探针逐项验证可用性。 */
const PRIVILEGED_CAPABILITIES = Object.freeze({
  [PLATFORM.LINUX]: ['root', 'cgroup', 'ebpf', 'ptrace'],
  [PLATFORM.WINDOWS]: ['com', 'wmi', 'registry', 'admin'],
  [PLATFORM.MACOS]: ['automation', 'appleEvents', 'fullDiskAccess'],
  [PLATFORM.ANDROID]: ['accessibility', 'intent', 'sensors', 'backgroundKeepAlive'],
  [PLATFORM.HARMONY]: ['softbus', 'metaService', 'distributedTask'],
});

const COMPUTE_MODES = Object.freeze(['server', 'desktop', 'mobile', 'unknown']);

class EnvFingerprintScanner {
  /**
   * @param {object} [opts]
   * @param {object} [opts.probe]  注入探针，覆盖默认真实探测：
   *   nodePlatform():string        process.platform
   *   osType():string / runtime():string
   *   isAndroid():boolean
   *   hasCapability(plat, cap):boolean   高特权接口可用性
   *   computeMode():string         server/desktop/mobile
   *   battery():{level,charging}|null
   *   network():{type,topology}|null
   */
  constructor(opts = {}) {
    this.probe = Object.assign({}, EnvFingerprintScanner._defaultProbe(), opts.probe || {});
  }

  /**
   * 执行一次完整刺探，返回不可变指纹。永不抛——探测失败时各字段降级为安全缺省，
   * 但绝不臆造平台身份（识别不出 → unknown，路由器据此拒绝盲调）。
   * @returns {{
   *   platform:string, kernel:string, recognized:boolean,
   *   capabilities:string[], compute:string,
   *   battery:object|null, network:object|null, topology:string[]
   * }}
   */
  scan() {
    const probe = this.probe;
    const ctx = {
      nodePlatform: _safeCall(probe.nodePlatform, ''),
      osType: _safeCall(probe.osType, ''),
      runtime: _safeCall(probe.runtime, ''),
      isAndroid: _safeCall(probe.isAndroid, false),
    };

    const sig = KERNEL_SIGNATURES.find((s) => { try { return s.match(ctx); } catch { return false; } });
    const platform = sig ? sig.platform : 'unknown';
    const recognized = !!sig && isPlatform(platform);

    const capabilities = recognized ? this._probeCapabilities(platform) : [];
    const compute = _coerceMode(_safeCall(probe.computeMode, 'unknown'));

    return Object.freeze({
      platform,
      kernel: sig ? sig.kernel : 'unknown',
      recognized,
      capabilities: Object.freeze(capabilities),
      compute,
      battery: _safeCall(probe.battery, null),
      network: _safeCall(probe.network, null),
      topology: topologyFor(platform),
    });
  }

  /** 逐项验证该环境的高特权接口可用性（§3.1 能力清单）。 */
  _probeCapabilities(platform) {
    const candidates = PRIVILEGED_CAPABILITIES[platform] || [];
    const out = [];
    for (const cap of candidates) {
      let ok = false;
      try { ok = !!this.probe.hasCapability(platform, cap); } catch { ok = false; }
      if (ok) out.push(cap);
    }
    return out;
  }

  /** 真实探针：仅读运行时本地信息，无网络、无重操作。 */
  static _defaultProbe() {
    return {
      nodePlatform: () => (typeof process !== 'undefined' && process.platform) || '',
      osType: () => { try { return require('os').type(); } catch { return ''; } },
      runtime: () => (typeof process !== 'undefined' && process.versions && process.versions.node ? `node/${process.versions.node}` : ''),
      isAndroid: () => {
        try { return /android/i.test(require('os').release()) || !!process.env.ANDROID_ROOT; } catch { return false; }
      },
      // 默认保守：真实高特权探测涉及系统调用，缺省一律 false，由具体环境覆写为真探测。
      hasCapability: () => false,
      computeMode: () => {
        try {
          const os = require('os');
          const cpus = os.cpus() ? os.cpus().length : 1;
          if (process.env.ANDROID_ROOT) return 'mobile';
          return cpus >= 16 ? 'server' : 'desktop';
        } catch { return 'unknown'; }
      },
      battery: () => null,
      network: () => null,
    };
  }
}

function _safeCall(fn, dflt) {
  try { return typeof fn === 'function' ? fn() : dflt; } catch { return dflt; }
}

function _coerceMode(m) {
  return COMPUTE_MODES.includes(m) ? m : 'unknown';
}

module.exports = { EnvFingerprintScanner, PRIVILEGED_CAPABILITIES, COMPUTE_MODES };
