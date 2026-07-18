'use strict';

/**
 * winCommandTranslate.test.js — Windows 命令翻译安全网回归。
 *
 * 实测触发场景：Windows cmd.exe 下模型生成 `... | head -30` / `grep -E "a|b"`，
 * 旧规则未覆盖管道形式与带 flag 的 grep，命令原样下发 → cmd 报「不是内部或外部
 * 命令」退码 255。本套件锁定修复后的翻译，并守住既有规则零回归。
 */

const {
  patchWinCommand,
  patchGitBashCommand,
  grepFlagsToFindstr,
  pipesNonAsciiFindFilter,
  forceWindowsUtf8,
  patchPowerShellRecurse,
} = require('../src/tools/winCommandTranslate');

describe('patchWinCommand — piped head/tail (stdin, no file arg)', () => {
  test('`| head -30` → powershell Select-Object -First (the exit-255 case)', () => {
    const out = patchWinCommand('pip list --format=freeze 2>/dev/null | head -30');
    expect(out).toBe('pip list --format=freeze 2>NUL | powershell -NoProfile -c "$input | Select-Object -First 30"');
  });

  test('`| tail -n 5` → powershell Select-Object -Last', () => {
    const out = patchWinCommand('cat file | tail -n 5');
    expect(out).toBe('type file | powershell -NoProfile -c "$input | Select-Object -Last 5"');
  });

  test('head/tail WITH a file arg still maps to Get-Content (not the stdin form)', () => {
    expect(patchWinCommand('head -n 10 notes.txt'))
      .toBe('powershell -NoProfile -c "Get-Content notes.txt -TotalCount 10"');
    expect(patchWinCommand('tail -20 app.log'))
      .toBe('powershell -NoProfile -c "Get-Content app.log -Tail 20"');
  });

  test('file-arg form does not greedily swallow a following pipe', () => {
    // Regression for the latent greedy `.+`: the file token must stop before `|`.
    const out = patchWinCommand('head -n 3 a.txt | sort');
    expect(out).toBe('powershell -NoProfile -c "Get-Content a.txt -TotalCount 3" | sort');
  });
});

describe('patchWinCommand — grep flags & regex alternation', () => {
  test('`grep -E "a|b"` → findstr /R with alternation turned into space (the exit-255 case)', () => {
    const out = patchWinCommand('pip show pip 2>/dev/null | grep -E "Location|Version"');
    expect(out).toBe('pip show pip 2>NUL | findstr /R "Location Version"');
  });

  test('combined flags `-rn` map to /s /n', () => {
    expect(patchWinCommand('grep -rn "a|b" .')).toBe('findstr /s /n "a b" .');
  });

  test('legacy `-i` / `-r` still translate (zero regression)', () => {
    expect(patchWinCommand('grep -i foo bar.txt')).toBe('findstr /i foo bar.txt');
    expect(patchWinCommand('grep -r needle src')).toBe('findstr /s needle src');
  });

  test('plain `grep word` → `findstr word`', () => {
    expect(patchWinCommand('grep foo data.txt')).toBe('findstr foo data.txt');
  });

  test('a real downstream pipe after grep is preserved (not converted to OR)', () => {
    expect(patchWinCommand('grep foo | sort')).toBe('findstr foo | sort');
  });
});

describe('grepFlagsToFindstr — unit', () => {
  test('empty flags → bare findstr', () => {
    expect(grepFlagsToFindstr('')).toBe('findstr');
    expect(grepFlagsToFindstr(undefined)).toBe('findstr');
  });
  test('regex flags enable /R, dedupes options', () => {
    expect(grepFlagsToFindstr(' -E')).toBe('findstr /R');
    expect(grepFlagsToFindstr(' -ii')).toBe('findstr /i');
    expect(grepFlagsToFindstr(' -v')).toBe('findstr /v');
  });
  test('unknown flags are ignored safely', () => {
    expect(grepFlagsToFindstr(' -x')).toBe('findstr');
  });
});

describe('patchWinCommand — existing rules unchanged (zero regression)', () => {
  test('cat / ls / rm / mkdir -p / which / pwd', () => {
    expect(patchWinCommand('cat readme.md')).toBe('type readme.md');
    expect(patchWinCommand('ls -la')).toBe('dir /a ');
    expect(patchWinCommand('rm -rf build')).toBe('rmdir /s /q build');
    expect(patchWinCommand('mkdir -p a/b')).toBe('mkdir a/b');
    expect(patchWinCommand('which node')).toBe('where node');
    expect(patchWinCommand('pwd')).toBe('cd');
  });
  test('redirection /dev/null and ~ expansion', () => {
    expect(patchWinCommand('foo 2>/dev/null')).toBe('foo 2>NUL');
    expect(patchWinCommand('cd ~/proj')).toBe('cd %USERPROFILE%\\proj');
  });
  test('empty / falsy input passes through', () => {
    expect(patchWinCommand('')).toBe('');
    expect(patchWinCommand(null)).toBe(null);
  });
});

describe('patchGitBashCommand — drive paths & dir', () => {
  test('drive-absolute backslash path → MSYS form', () => {
    expect(patchGitBashCommand('cat D:\\proj\\a.txt')).toBe('cat /d/proj/a.txt');
  });
  test('`dir` → `ls -la` only at a command boundary', () => {
    expect(patchGitBashCommand('dir')).toBe('ls -la');
    expect(patchGitBashCommand('foo && dir')).toBe('foo && ls -la');
  });
});

// ── Fix B: 中文 find 过滤器检测 + chcp 跳过 ───────────────────────────
describe('pipesNonAsciiFindFilter — 把中文 needle 喂给 find/findstr 才命中', () => {
  test('`| find "文件"` → true(实测 exit-1 的根因场景)', () => {
    expect(pipesNonAsciiFindFilter('dir "C:\\x" 2>nul | find "文件"')).toBe(true);
  });
  test('`| findstr "状态"` → true', () => {
    expect(pipesNonAsciiFindFilter('tasklist | findstr "状态"')).toBe(true);
  });
  test('纯 ASCII `| find "txt"` → false(不跳 chcp,零行为改变)', () => {
    expect(pipesNonAsciiFindFilter('dir | find "txt"')).toBe(false);
  });
  test('无 find 的中文命令 → false(中文路径仍应走 UTF-8 强制)', () => {
    expect(pipesNonAsciiFindFilter('mkdir "D:\\测试"')).toBe(false);
  });
  test('空/假值安全', () => {
    expect(pipesNonAsciiFindFilter('')).toBe(false);
    expect(pipesNonAsciiFindFilter(null)).toBe(false);
  });
});

describe('forceWindowsUtf8 (Fix B) — cmd 中文 find 跳过 chcp', () => {
  const realPlatform = process.platform;
  const asWin = () => Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const restore = () => Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  afterEach(restore);

  test('cmd + ASCII find → 前缀 chcp 65001 + utf-8', () => {
    asWin();
    const r = forceWindowsUtf8({ shell: 'cmd' }, 'dir "X" | find "txt"', {});
    expect(r.command).toMatch(/^chcp 65001>nul & /);
    expect(r.outputEncoding).toBe('utf-8');
  });

  test('cmd + 中文 find → 跳过 chcp、encoding=null(根因修复)', () => {
    asWin();
    const cmd = 'dir "X" 2>nul | find "文件"';
    const r = forceWindowsUtf8({ shell: 'cmd' }, cmd, {});
    expect(r.command).toBe(cmd); // 命令逐字节不变,不加 chcp
    expect(r.outputEncoding).toBeNull();
  });

  test('cmd + 中文路径(无 find)→ 仍强制 UTF-8(不误伤场景①)', () => {
    asWin();
    const r = forceWindowsUtf8({ shell: 'cmd' }, 'mkdir "D:\\测试"', {});
    expect(r.command).toMatch(/^chcp 65001>nul & /);
    expect(r.outputEncoding).toBe('utf-8');
  });

  test('逃生阀 KHY_WIN_FORCE_UTF8=0 → 不强制', () => {
    asWin();
    const r = forceWindowsUtf8({ shell: 'cmd' }, 'dir "X"', { KHY_WIN_FORCE_UTF8: '0' });
    expect(r.command).toBe('dir "X"');
    expect(r.outputEncoding).toBeNull();
  });

  test('powershell → 设 OutputEncoding', () => {
    asWin();
    const r = forceWindowsUtf8({ shell: 'powershell' }, 'Get-Date', {});
    expect(r.command).toMatch(/OutputEncoding/);
    expect(r.outputEncoding).toBe('utf-8');
  });

  test('非 Windows → 原样透传', () => {
    restore();
    const r = forceWindowsUtf8({ shell: 'cmd' }, 'dir "X" | find "文件"', {});
    expect(r.command).toBe('dir "X" | find "文件"');
    expect(r.outputEncoding).toBeNull();
  });
});

// ── Fix C: PowerShell -Recurse 无权限自动跳过 ─────────────────────────
describe('patchPowerShellRecurse (Fix C)', () => {
  test('Get-ChildItem -Recurse → 注入 -Force -ErrorAction SilentlyContinue', () => {
    const r = patchPowerShellRecurse(
      'powershell -Command "Get-ChildItem \'C:\\Temp\' -Recurse | Measure-Object"'
    );
    expect(r.patched).toBe(true);
    expect(r.command).toMatch(/-Recurse -Force -ErrorAction SilentlyContinue/);
  });

  test('已有 -Force → 只补 -ErrorAction(不重复 -Force,避免 PS 重复参数报错)', () => {
    const r = patchPowerShellRecurse('gci X -Recurse -Force');
    expect(r.patched).toBe(true);
    // -ErrorAction 注入在 -Recurse 后;原 -Force 保留在尾部 → 全程只有一个 -Force。
    expect(r.command).toBe('gci X -Recurse -ErrorAction SilentlyContinue -Force');
    expect((r.command.match(/-Force/g) || []).length).toBe(1);
  });

  test('已显式 -ErrorAction → 尊重用户,原样不动', () => {
    const cmd = 'Get-ChildItem X -Recurse -ErrorAction Stop';
    const r = patchPowerShellRecurse(cmd);
    expect(r.patched).toBe(false);
    expect(r.command).toBe(cmd);
  });

  test('幂等:对已注入结果再跑一次不叠加', () => {
    const once = patchPowerShellRecurse('Get-ChildItem X -Recurse').command;
    const twice = patchPowerShellRecurse(once);
    expect(twice.patched).toBe(false);
    expect(twice.command).toBe(once);
  });

  test('无 -Recurse → 不动(cmd `dir` 不被误伤)', () => {
    const r = patchPowerShellRecurse('dir "C:\\x"');
    expect(r.patched).toBe(false);
    expect(r.command).toBe('dir "C:\\x"');
  });

  test('有 -Recurse 但非 GCI → 不动', () => {
    const r = patchPowerShellRecurse('SomeCmdlet -Recurse');
    expect(r.patched).toBe(false);
  });

  test('逃生阀 KHY_WIN_RECURSE_GUARD=0 → 不修补', () => {
    const r = patchPowerShellRecurse('Get-ChildItem X -Recurse', { KHY_WIN_RECURSE_GUARD: '0' });
    expect(r.patched).toBe(false);
  });

  test('空/假值安全', () => {
    expect(patchPowerShellRecurse('').patched).toBe(false);
    expect(patchPowerShellRecurse(null).command).toBe(null);
  });
});

// R5 (/goal「做5轮khyos最值得治理的地方」):rm→rmdir 翻译的 flag 簇归一化。
// 历史两条 `rm -r[f]*` / `rm -f[r]*` 只认纯 r/f 且区分大小写的簇 → `rm -rfv logs`(额外
// flag)、`rm -Rf x`(大写)落空未翻译,又因带 `-` 被后面的 `rm (?!-)` 拒 → 原样 `rm -Rf` 漏给
// cmd.exe(无 rm 命令直接报错)。门控 KHY_WIN_RM_TRANSLATE_FLAGS(default-on):开 → 单条
// case-insensitive、含任一 r/f 的簇统一翻成 rmdir(原两条严格超集);关 → 逐字节回退历史两条。
describe('R5: patchWinCommand rm→rmdir flag-cluster normalization', () => {
  function withEnv(key, value, fn) {
    const had = Object.prototype.hasOwnProperty.call(process.env, key);
    const prev = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try { return fn(); } finally {
      if (had) process.env[key] = prev; else delete process.env[key];
    }
  }
  const ON = (fn) => withEnv('KHY_WIN_RM_TRANSLATE_FLAGS', undefined, fn);
  const OFF = (fn) => withEnv('KHY_WIN_RM_TRANSLATE_FLAGS', '0', fn);

  test('ON: canonical + reversed/uppercase/extra-flag clusters all → rmdir /s /q', () => {
    ON(() => {
      expect(patchWinCommand('rm -rf logs')).toBe('rmdir /s /q logs');
      expect(patchWinCommand('rm -fr logs')).toBe('rmdir /s /q logs');   // reversed — was untranslated
      expect(patchWinCommand('rm -Rf logs')).toBe('rmdir /s /q logs');   // uppercase — was untranslated
      expect(patchWinCommand('rm -rfv logs')).toBe('rmdir /s /q logs');  // extra flag — was untranslated
      expect(patchWinCommand('rm -r dir')).toBe('rmdir /s /q dir');
      expect(patchWinCommand('rm -f file')).toBe('rmdir /s /q file');    // superset of legacy 2nd line
    });
  });

  test('ON: single-file rm (no flags) still → del', () => {
    ON(() => expect(patchWinCommand('rm notes.txt')).toBe('del notes.txt'));
  });

  test('OFF byte-revert: uppercase/extra-flag clusters stay untranslated (documents pre-fix gap)', () => {
    OFF(() => {
      // legacy still handles the two canonical spellings
      expect(patchWinCommand('rm -rf logs')).toBe('rmdir /s /q logs');
      expect(patchWinCommand('rm -fr logs')).toBe('rmdir /s /q logs');
      // but uppercase / extra-flag clusters were missed — and NOT del'd either (leading `-`)
      expect(patchWinCommand('rm -Rf logs')).toBe('rm -Rf logs');
      expect(patchWinCommand('rm -rfv logs')).toBe('rm -rfv logs');
    });
  });

  test('fail-soft: empty / falsy input unchanged', () => {
    ON(() => {
      expect(patchWinCommand('')).toBe('');
      expect(patchWinCommand(null)).toBe(null);
    });
  });
});

// R3/R4/R5 (/goal「做5轮khyos最值得治理的地方」fourth batch, shared gate
// KHY_WIN_TRANSLATE_FLAG_NORMALIZE):
//   R3 `wc -l` — legacy greedy `.+` swallowed a following pipe; the stdin-pipe form
//      `cat f | wc -l` (no file arg) was untranslated → cmd.exe error.
//   R4 `ls -al`/`ls -a` (a-before-l / a-only) fell to the bareword rule (→ `dir -al`);
//      `ps -ef`/`ps -e` (dashed) were untranslated.
//   R5 chmod symbolic who-selectors (u/g/o/a), `=` and s/t/X were outside the char
//      class → `chmod u+x`/`chmod a+rwx`/`chmod o=r` passed through untranslated.
// OFF byte-reverts each to its legacy rule.
describe('R3/R4/R5: patchWinCommand flag-normalization (KHY_WIN_TRANSLATE_FLAG_NORMALIZE)', () => {
  function withEnv(key, value, fn) {
    const had = Object.prototype.hasOwnProperty.call(process.env, key);
    const prev = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try { return fn(); } finally {
      if (had) process.env[key] = prev; else delete process.env[key];
    }
  }
  const ON = (fn) => withEnv('KHY_WIN_TRANSLATE_FLAG_NORMALIZE', undefined, fn);
  const OFF = (fn) => withEnv('KHY_WIN_TRANSLATE_FLAG_NORMALIZE', '0', fn);

  describe('R3: wc -l', () => {
    test('ON: file form stops before a following pipe (no greedy swallow)', () => {
      ON(() => expect(patchWinCommand('wc -l a.txt | sort')).toBe('find /c /v "" a.txt | sort'));
    });
    test('ON: stdin-pipe form (no file arg) → find /c /v "" (was untranslated)', () => {
      ON(() => expect(patchWinCommand('cat f | wc -l')).toBe('type f | find /c /v ""'));
    });
    test('ON: plain file form still translates', () => {
      ON(() => expect(patchWinCommand('wc -l notes.txt')).toBe('find /c /v "" notes.txt'));
    });
    test('OFF: greedy legacy swallows the pipe; no stdin form', () => {
      OFF(() => {
        expect(patchWinCommand('wc -l a.txt | sort')).toBe('find /c /v "" a.txt | sort');
        // legacy required a file after -l → the stdin pipe form is left as `wc -l`
        expect(patchWinCommand('cat f | wc -l')).toBe('type f | wc -l');
      });
    });
  });

  describe('R4: ls ordering + ps dashed', () => {
    test('ON: -la / -al / -a all → dir /a ', () => {
      ON(() => {
        expect(patchWinCommand('ls -la')).toBe('dir /a ');
        expect(patchWinCommand('ls -al')).toBe('dir /a '); // a-before-l — was mistranslated
        expect(patchWinCommand('ls -a')).toBe('dir /a ');   // a-only — was mistranslated
        expect(patchWinCommand('ls -lart')).toBe('dir /a ');
      });
    });
    test('ON: -l → dir ; bareword / bare ls unchanged', () => {
      ON(() => {
        expect(patchWinCommand('ls -l')).toBe('dir ');
        expect(patchWinCommand('ls foo')).toBe('dir foo');
        expect(patchWinCommand('ls')).toBe('dir');
      });
    });
    test('ON: ps aux / -ef / -e / a → tasklist', () => {
      ON(() => {
        expect(patchWinCommand('ps aux')).toBe('tasklist');
        expect(patchWinCommand('ps -ef')).toBe('tasklist'); // dashed — was untranslated
        expect(patchWinCommand('ps -e')).toBe('tasklist');
        expect(patchWinCommand('ps a')).toBe('tasklist');
      });
    });
    test('OFF: -al/-a fall through untranslated; ps -ef untranslated', () => {
      OFF(() => {
        expect(patchWinCommand('ls -la')).toBe('dir /a '); // legacy still handles -la
        expect(patchWinCommand('ls -al')).toBe('ls -al');   // legacy: l-not-first + leading `-` → untranslated
        expect(patchWinCommand('ls -a')).toBe('ls -a');     // legacy: only -la?/-l → untranslated
        expect(patchWinCommand('ps -ef')).toBe('ps -ef');   // legacy no-dash only → untranslated
      });
    });
  });

  describe('R5: chmod symbolic who-selectors', () => {
    test('ON: symbolic forms neutralized', () => {
      ON(() => {
        expect(patchWinCommand('chmod u+x f')).toBe('echo [skip chmod] & rem f');
        expect(patchWinCommand('chmod a+rwx f')).toBe('echo [skip chmod] & rem f');
        expect(patchWinCommand('chmod g-w f')).toBe('echo [skip chmod] & rem f');
        expect(patchWinCommand('chmod o=r f')).toBe('echo [skip chmod] & rem f');
      });
    });
    test('ON: octal + bare +x still neutralized (superset)', () => {
      ON(() => {
        expect(patchWinCommand('chmod 777 f')).toBe('echo [skip chmod] & rem f');
        expect(patchWinCommand('chmod +x f')).toBe('echo [skip chmod] & rem f');
      });
    });
    test('OFF: who-selector forms revert to untranslated', () => {
      OFF(() => {
        expect(patchWinCommand('chmod 777 f')).toBe('echo [skip chmod] & rem f'); // octal still caught
        expect(patchWinCommand('chmod u+x f')).toBe('chmod u+x f');               // hole reopens
        expect(patchWinCommand('chmod o=r f')).toBe('chmod o=r f');
      });
    });
  });

  test('fail-soft: empty / falsy input unchanged (both gate states)', () => {
    ON(() => { expect(patchWinCommand('')).toBe(''); expect(patchWinCommand(null)).toBe(null); });
    OFF(() => { expect(patchWinCommand('')).toBe(''); expect(patchWinCommand(null)).toBe(null); });
  });
});
