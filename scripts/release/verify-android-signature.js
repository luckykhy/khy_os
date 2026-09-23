#!/usr/bin/env node
'use strict';
/**
 * Android 签名校验执行器(薄壳)。做副作用:跑 apksigner / keytool、读 key.properties
 * 与 KHY_ANDROID_* 环境变量、定位 dist/android 产物;判定逻辑全部委托纯叶子
 * scripts/release/lib/verifyAndroidSignature.js(可单测、无 IO)。
 *
 * 作为 release-gate 的一个可选 recommended 阶段消费:
 *   node scripts/release/verify-android-signature.js [--release]
 * 缺 Android 工具链 / 缺产物时 fail-soft 退出 0 并打印 SKIP(不阻断 pip/npm 双渠道);
 * 只有「签名无效」或「签错 key」才退出 1(NO-GO)。
 *
 * 参数:
 *   (无)          默认期望 release 签名:用 release keystore 指纹交叉核对,
 *                 一致 => GO(退出 0);不一致或无 release 凭据 => NO-GO(退出 1)。
 *   --no-release  不期望 release 签名(仅校验签名有效性),用于本地 DEBUG 包自检。
 *   --apk <p>     指定 APK 路径(默认 dist/android/app-release.apk)
 *
 * 注意(Windows):apksigner.bat / keytool.bat 是 Java 批处理包装器。Node 的
 * execFileSync 直接 spawn .bat 会 EINVAL,必须走 shell;而 shell:true 在 Windows
 * 上会以 `cmd /s /c` 强拆模式解析,对「带引号路径 + 引号参数」会出错。所以这里
 * 显式调 `cmd /d /c "<exe>" <args>`,exe 用原生路径(反斜杠),整体加引号。
 */

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { verifyAndroidSignature } = require('./lib/verifyAndroidSignature');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'khy-os-client-app');
const ANDROID_DIR = path.join(APP_DIR, 'android');
const KEY_PROPS = path.join(ANDROID_DIR, 'key.properties');
const DEFAULT_APK = path.join(REPO_ROOT, 'dist', 'android', 'app-release.apk');

const IS_WIN = process.platform === 'win32';
const BT_LIST = ['36.0.0', '35.0.0', '34.0.0'];

function parseArgs(argv) {
  const a = { release: true, allowDebug: false, apk: DEFAULT_APK };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--release') a.release = true;
    else if (x === '--no-release') a.release = false;
    else if (x === '--allow-debug') a.allowDebug = true;
    else if (x === '--apk') a.apk = argv[++i] || a.apk;
  }
  return a;
}

/**
 * 在候选 SDK 根里按 build-tools 版本从高到低找 apksigner 可执行文件。
 * 找不到返回 null(上层据此降级为 SKIP,而非 fail)。
 */
function findApksigner() {
  const bases = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
  ];
  if (IS_WIN) {
    bases.push('D:\\Portable\\Tools\\android-sdk'); // 便携布局兜底,与 build-android.ps1 对齐
  }
  for (const bt of BT_LIST) {
    for (const base of bases) {
      if (!base) continue;
      const ext = IS_WIN ? '.bat' : '';
      const p = path.join(base, 'build-tools', bt, 'apksigner' + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function findKeytool() {
  if (process.env.JAVA_HOME) {
    const bin = IS_WIN ? 'keytool.exe' : 'keytool';
    const p = path.join(process.env.JAVA_HOME, 'bin', bin);
    if (fs.existsSync(p)) return p;
  }
  return 'keytool'; // 裸命令名,靠 PATH;经 cmd/sh 解释
}

function readKeyProp(key) {
  if (!fs.existsSync(KEY_PROPS)) return '';
  const line = fs.readFileSync(KEY_PROPS, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith(key + '='));
  return line ? line.split('=')[1].trim() : '';
}

/** 解析 apksigner verify --print-certs 输出里的 SHA-256 指纹行。 */
function extractSha(line) {
  if (!line) return '';
  const m = line.match(/Signer #1 certificate SHA-256 digest:\s*(\S+)/i);
  return m ? m[1] : '';
}

/**
 * 跑一个外部命令,始终返回 stdout+stderr 文本。
 * Windows 上 apksigner.bat / keytool.bat 必须经 `cmd /d /c` 解释;exe 路径保留
 * 原生反斜杠并整体加引号,避免 cmd 把 `\` 当转义吃掉。unix 经 `sh -c`。
 * exit 码不影响返回文本:工具即便报错也会把原因写进输出,文本足够判定。
 */
function runTool(exe, args) {
  // apksigner.bat / keytool.bat are Java batch wrappers. Node must NOT
  // spawn them directly (EINVAL) and `shell:'cmd'` triggers the
  // `cmd /s /c` split-mode which mangles quoted paths. The proven form is a
  // bare `cmd /d /c "exe args"` string via execSync's default shell.
  const cmdLine = '"' + exe + '" ' + args.join(' ');
  let stdout = '';
  let stderr = '';
  try {
    stdout = cp.execSync(cmdLine, {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // 非零退出时 execSync 抛错,但把 stdout/stderr 挂在 e 上。
    stdout = e.stdout ? e.stdout.toString() : '';
    stderr = e.stderr ? e.stderr.toString() : '';
  }
  return (stdout + (stderr ? '\n' + stderr : '')).trim();
}

function main() {
  const a = parseArgs(process.argv);
  const apk = path.resolve(a.apk);

  if (!fs.existsSync(apk)) {
    console.log('SKIP —— 找不到 APK 产物 ' + apk);
    console.log('       先跑: npm run android:release 生成 dist/android/app-release.apk');
    process.exit(0); // fail-soft:缺产物不阻断双渠道
  }

  const apksigner = findApksigner();
  let apksignerOutput = '';
  let apkSha = '';
  if (apksigner) {
    apksignerOutput = runTool(apksigner, ['verify', '--print-certs', apk]);
    const shaLine = apksignerOutput.split('\n').find((l) => /Signer #1 certificate SHA-256 digest/i.test(l));
    apkSha = extractSha(shaLine);
  }

  // release keystore 指纹(仅在期望 release 时需要)。
  let keystoreSha = '';
  if (a.release) {
    const storeFileRaw = process.env.KHY_ANDROID_STORE_FILE || readKeyProp('storeFile');
    const storePass = process.env.KHY_ANDROID_STORE_PASSWORD || readKeyProp('storePassword');
    if (storeFileRaw && storePass) {
      const storePath = path.isAbsolute(storeFileRaw) ? storeFileRaw : path.join(ANDROID_DIR, storeFileRaw);
      if (fs.existsSync(storePath)) {
        const keytool = findKeytool();
        const ktOut = runTool(keytool, ['-list', '-v', '-keystore', storePath, '-storepass', storePass]);
        const shaLine = ktOut.split('\n').find((l) => /SHA256:\s*\S/.test(l));
        keystoreSha = shaLine ? shaLine.replace(/^.*SHA256:\s*/, '').trim() : '';
      }
    }
  }

  const result = verifyAndroidSignature({
    apksignerOutput,
    apkSha256: apkSha,
    keystoreSha256: keystoreSha,
    expectRelease: a.release,
  });

  console.log('[' + result.status.toUpperCase() + '] ' + result.message);
  if (result.reasons.length) {
    console.log('  reasons: ' + result.reasons.join(', '));
  }

  // 发布产物默认期望 release 签名;若判定为「降级(非 release 凭据)」而 --allow-debug
  // 未给,视同 fail —— 防止 DEBUG 签名的包被误当 release 上传 Play。
  const isDebugOnly = result.status === 'pass' && result.reasons.includes('debug_signing_expected');
  if (isDebugOnly && !a.allowDebug) {
    console.log('  (加 --allow-debug 可放行 DEBUG 签名;默认拒绝,防止误上传 Play)');
    process.exit(1);
  }

  process.exit(result.status === 'fail' ? 1 : 0);
}

main();
