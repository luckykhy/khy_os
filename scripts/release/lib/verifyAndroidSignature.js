'use strict';
/**
 * 纯叶子 verifyAndroidSignature —— Android 发布包签名校验的判定逻辑(单一真源)。
 *
 * 本文件只包含纯函数:把「apksigner verify --print-certs 的输出 + release keystore
 * 的 keytool SHA256 指纹」这两个**已读好的文本输入**判定为 GO / NO-GO / SKIP。
 * 它不做任何 IO(不 require fs/child_process、不读文件、不跑 apksigner),因此可被
 * node --test 直接单测,也可被 release-gate 消费执行。
 *
 * 为什么是纯叶子:门禁(releaseGateStages.js 的 android-signature 阶段)负责真正去跑
 * apksigner / keytool、读 key.properties 这些副作用;判定「指纹是否一致 / 是否签错 key
 * / 缺工具链时如何降级」是纯逻辑,抽到这里便于确定性测试。
 *
 * 判定语义(fail-soft,工程红线):
 *   - 缺 apksigner / 缺 keystore / 无 release 凭据 => status='skip',不算 NO-GO
 *     (Android 工具链缺失不该阻断 pip/npm 双渠道发布,但须留痕 SKIP)。
 *   - 签名无效,或 APK 指纹与 release keystore 不一致 => status='fail'(NO-GO)。
 *   - 签名有效且(无 release 凭据时)或指纹一致 => status='pass'。
 *
 * 用法:
 *   const v = verifyAndroidSignature({ apksignerOutput, apkSha256, keystoreSha256, expectRelease });
 *   v.status  ∈ 'pass' | 'fail' | 'skip'
 *   v.reasons ∈ string[]
 *   v.message ∈ 人类可读结论(报告/CI 直接打)
 */

const REASONS = {
  MISSING_APKSIGNER: 'missing_apksigner',
  INVALID_SIG: 'invalid_signature',
  MISMATCH: 'signer_mismatch',
  NO_RELEASE_EXPECTED: 'debug_signing_expected',
  OK: 'signature_ok',
};

/** 归一化指纹:去冒号/空格/横线,转小写,便于 apksigner 与 keytool 两种格式比对。 */
function normSha(s) {
  return String(s || '')
    .replace(/[:\s-]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * 判定一次 Android 签名校验。
 * @param {object} input
 * @param {string} [input.apksignerOutput] apksigner verify --print-certs 的完整输出;缺省 = 无 apksigner。
 * @param {string} [input.apkSha256] 从 apksigner 输出里抠出的 APK 签名者证书 SHA-256。
 * @param {string} [input.keystoreSha256] 从 keytool 抠出的 release keystore 密钥 SHA-256;缺省 = 无 keystore 凭据。
 * @param {boolean} [input.expectRelease] 本次发布是否期望 release 签名(有 release 凭据)。
 * @returns {{ status: 'pass'|'fail'|'skip', reasons: string[], message: string }}
 */
function verifyAndroidSignature(input = {}) {
  const apksignerOutput = input.apksignerOutput || '';
  const apkSha = normSha(input.apkSha256);
  const keystoreSha = normSha(input.keystoreSha256);
  const expectRelease = Boolean(input.expectRelease);
  const reasons = [];

  // 无 apksigner 输出 => 工具链缺失,fail-soft 降级为 SKIP(不阻断双渠道)。
  // 但若调用方显式提供了 APK 指纹(apkSha256),说明工具链已离线跑过、只是把结果
  // 喂进来,此时不降级——继续走指纹判定。
  if (!apksignerOutput && !apkSha) {
    reasons.push(REASONS.MISSING_APKSIGNER);
    return {
      status: 'skip',
      reasons,
      message:
        'SKIP —— 未提供 apksigner 输出(缺 Android build-tools)。Android 签名校验跳过; ' +
        '本机可用时重跑,或 CI 里设 ANDROID_SDK_ROOT。',
    };
  }

  // 签名无效:apksigner 有输出、却既没有 signer 证书指纹、也没有 Verifies。
  // 显式提供了 apkSha 时视为指纹已由上游工具解析,不在此处判「无效」。
  const hasSignerCert = /Signer #1 certificate SHA-256 digest/i.test(apksignerOutput);
  const verifiesWord = /\bVerifies\b/.test(apksignerOutput);
  if (!apkSha && !hasSignerCert && !verifiesWord) {
    reasons.push(REASONS.INVALID_SIG);
    return {
      status: 'fail',
      reasons,
      message: 'NO-GO —— apksigner 未报告有效签名者(AAPK 可能未签名或 v1 方案缺失)。',
    };
  }

  // 期望 release 签名:必须能用 keystore 指纹交叉核对,且一致。
  if (expectRelease) {
    if (!keystoreSha) {
      reasons.push(REASONS.MISSING_APKSIGNER); // 复用:缺 keystore 凭据 => 降级 SKIP
      return {
        status: 'skip',
        reasons,
        message:
          'SKIP —— 期望 release 签名但没有可用的 release keystore 指纹(android/key.properties 或 KHY_ANDROID_* 缺失)。' +
          ' 本包可能是 DEBUG 签名,不可用于 Play 上架。',
      };
    }
    if (!apkSha) {
      reasons.push(REASONS.INVALID_SIG);
      return {
        status: 'fail',
        reasons,
        message: 'NO-GO —— 无法从 apksigner 输出解析 APK 签名者 SHA-256,无法核对 release keystore。',
      };
    }
    if (apkSha !== keystoreSha) {
      reasons.push(REASONS.MISMATCH);
      return {
        status: 'fail',
        reasons,
        message:
          `NO-GO —— APK 签名者与 release keystore 不一致(APK=${apkSha} keystore=${keystoreSha})。` +
          ' 该包由错误的 key 签名,禁止上传 Play。',
      };
    }
    reasons.push(REASONS.OK);
    return {
      status: 'pass',
      reasons,
      message: 'GO —— 签名有效且与 release keystore 一致,可用于 Play 上架。',
    };
  }

  // 不期望 release 签名(仅 DEBUG 凭据):只要签名有效即通过,留痕说明非上架可用。
  reasons.push(REASONS.NO_RELEASE_EXPECTED);
  return {
    status: 'pass',
    reasons,
    message:
      'PASS(降级) —— 签名有效,但本次无 release 凭据,产物为 DEBUG 签名,不可用于 Play 上架。' +
      ' 上架请先配 release keystore。',
  };
}

module.exports = { verifyAndroidSignature, REASONS };
