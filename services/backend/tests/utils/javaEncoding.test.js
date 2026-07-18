/**
 * Unit tests for javaEncoding — the UTF-8 pinning helper that fixes Java
 * environment mojibake on legacy-locale (GBK) Windows hosts.
 *
 * The helper has a single behavioural axis: enabled (default) vs disabled via
 * KHY_WIN_FORCE_UTF8. When enabled it must hand back the exact JVM `-D` flags /
 * `-J` forwarding flags / env overlay that make both the emit side (Java writes
 * UTF-8) and the decode side (pipe read as UTF-8) agree. When disabled every
 * accessor must degrade to a no-op so callers fall back to autodetect.
 */

const javaEncoding = require('../../src/utils/javaEncoding');

const FORCE_KEY = 'KHY_WIN_FORCE_UTF8';

describe('javaEncoding', () => {
  let savedFlag;
  beforeEach(() => { savedFlag = process.env[FORCE_KEY]; delete process.env[FORCE_KEY]; });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FORCE_KEY];
    else process.env[FORCE_KEY] = savedFlag;
  });

  describe('enabled (default)', () => {
    test('isDisabled() is false by default', () => {
      expect(javaEncoding.isDisabled()).toBe(false);
    });

    test('javaRunFlags() pins file/stdout/stderr encoding to UTF-8', () => {
      expect(javaEncoding.javaRunFlags()).toEqual([
        '-Dfile.encoding=UTF-8',
        '-Dsun.stdout.encoding=UTF-8',
        '-Dsun.stderr.encoding=UTF-8',
      ]);
    });

    test('javacFlags() declares source charset and forwards UTF-8 to the compiler JVM', () => {
      expect(javaEncoding.javacFlags()).toEqual([
        '-encoding', 'UTF-8',
        '-J-Dfile.encoding=UTF-8',
        '-J-Dsun.stdout.encoding=UTF-8',
        '-J-Dsun.stderr.encoding=UTF-8',
      ]);
    });

    test('jdkToolFlags() uses only the -J forwarding form (valid for javap/jar)', () => {
      expect(javaEncoding.jdkToolFlags()).toEqual([
        '-J-Dfile.encoding=UTF-8',
        '-J-Dsun.stdout.encoding=UTF-8',
        '-J-Dsun.stderr.encoding=UTF-8',
      ]);
    });

    test('buildToolEnv() sets GRADLE_OPTS / MAVEN_OPTS to the UTF-8 props', () => {
      const env = javaEncoding.buildToolEnv({});
      expect(env.GRADLE_OPTS).toBe('-Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8');
      expect(env.MAVEN_OPTS).toBe(env.GRADLE_OPTS);
    });

    test('buildToolEnv() merges onto an existing value rather than clobbering it', () => {
      const env = javaEncoding.buildToolEnv({ GRADLE_OPTS: '-Xmx512m', MAVEN_OPTS: '-Xms64m' });
      expect(env.GRADLE_OPTS).toBe('-Xmx512m -Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8');
      expect(env.MAVEN_OPTS.startsWith('-Xms64m ')).toBe(true);
    });

    test('outputEncoding() asks the pipe to be decoded as utf-8', () => {
      expect(javaEncoding.outputEncoding()).toBe('utf-8');
    });
  });

  describe('disabled via KHY_WIN_FORCE_UTF8', () => {
    for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
      test(`"${off}" makes every accessor a no-op`, () => {
        process.env[FORCE_KEY] = off;
        expect(javaEncoding.isDisabled()).toBe(true);
        expect(javaEncoding.javaRunFlags()).toEqual([]);
        expect(javaEncoding.javacFlags()).toEqual([]);
        expect(javaEncoding.jdkToolFlags()).toEqual([]);
        expect(javaEncoding.buildToolEnv({ GRADLE_OPTS: '-Xmx1g' })).toEqual({});
        expect(javaEncoding.outputEncoding()).toBeNull();
      });
    }

    test('an unrelated truthy value keeps it ENABLED (only explicit off-words disable)', () => {
      process.env[FORCE_KEY] = '1';
      expect(javaEncoding.isDisabled()).toBe(false);
      process.env[FORCE_KEY] = 'yes';
      expect(javaEncoding.isDisabled()).toBe(false);
    });
  });
});
