'use strict';

/**
 * javaEncoding.js — force Java / JVM toolchains to read and write UTF-8.
 *
 * Root cause of the "Java environment mojibake" on Windows: javac/java/gradle pick
 * their stdout/stderr charset from the JVM's `file.encoding`, which on a CN Windows
 * defaults to the legacy system locale (GBK / MS936) — independently of the console
 * code page. khy decodes subprocess output by the *console* code page, so when Java
 * emits GBK while the pipe is decoded as UTF-8 (or vice-versa) every non-ASCII byte
 * turns into garbage (compiler diagnostics, exception messages, System.out.println).
 *
 * The durable fix makes both sides agree on UTF-8:
 *   - emit side: pin the JVM with `-Dfile.encoding=UTF-8` (+ sun.stdout/stderr) so
 *     Java *writes* UTF-8 regardless of host locale;
 *   - decode side: hand `outputEncoding: 'utf-8'` to spawnWithIdleTimeout so the pipe
 *     is decoded as UTF-8 instead of guessing the code page.
 *
 * We pass the flags directly as JVM `-D` arguments rather than via JAVA_TOOL_OPTIONS,
 * because the latter prints a noisy `Picked up JAVA_TOOL_OPTIONS: ...` banner to
 * stderr that would itself pollute the captured output. UTF-8 is a correct default on
 * every platform, so this is applied unconditionally — set KHY_WIN_FORCE_UTF8=0 (or
 * off/false/no) to opt out, matching the shellCommand UTF-8 escape hatch.
 */

const ENCODING = 'UTF-8';

// The three JVM system properties that pin charset + stream encoding to UTF-8.
const JVM_UTF8_PROPS = [
  `-Dfile.encoding=${ENCODING}`,
  `-Dsun.stdout.encoding=${ENCODING}`,
  `-Dsun.stderr.encoding=${ENCODING}`,
];

function isDisabled() {
  const flag = String(process.env.KHY_WIN_FORCE_UTF8 || '').trim().toLowerCase();
  return flag === '0' || flag === 'false' || flag === 'off' || flag === 'no';
}

/**
 * Flags to prepend to a `java <program>` invocation (before -cp / main class).
 * @returns {string[]}
 */
function javaRunFlags() {
  return isDisabled() ? [] : JVM_UTF8_PROPS.slice();
}

/**
 * Flags to prepend to a `javac ...` invocation. `-encoding UTF-8` declares the
 * SOURCE file charset; the `-J`-prefixed flags forward UTF-8 to the compiler's own
 * JVM so its diagnostics print UTF-8.
 * @returns {string[]}
 */
function javacFlags() {
  return isDisabled() ? [] : ['-encoding', ENCODING, ...JVM_UTF8_PROPS.map((p) => `-J${p}`)];
}

/**
 * Flags to prepend to any other JDK launcher tool (javap, jar, jstack, ...).
 * Only the `-J` JVM forwarding form is valid for these.
 * @returns {string[]}
 */
function jdkToolFlags() {
  return isDisabled() ? [] : JVM_UTF8_PROPS.map((p) => `-J${p}`);
}

/**
 * Environment overlay for shell-launched build tools (gradle/mvn) that read
 * `GRADLE_OPTS` / `MAVEN_OPTS` for their launcher JVM. Merges onto any existing
 * value rather than clobbering it.
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {Record<string,string>}
 */
function buildToolEnv(baseEnv = process.env) {
  if (isDisabled()) return {};
  const add = JVM_UTF8_PROPS.join(' ');
  const merge = (key) => {
    const prev = baseEnv && baseEnv[key];
    return prev ? `${prev} ${add}` : add;
  };
  return { GRADLE_OPTS: merge('GRADLE_OPTS'), MAVEN_OPTS: merge('MAVEN_OPTS') };
}

/**
 * The decode encoding to hand to spawnWithIdleTimeout so the pipe is read as UTF-8
 * (agreeing with the emit-side flags above). Returns null when disabled so callers
 * fall back to the default console-code-page autodetect.
 * @returns {string|null}
 */
function outputEncoding() {
  return isDisabled() ? null : 'utf-8';
}

module.exports = {
  ENCODING,
  isDisabled,
  javaRunFlags,
  javacFlags,
  jdkToolFlags,
  buildToolEnv,
  outputEncoding,
};
