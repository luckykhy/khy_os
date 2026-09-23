#!/usr/bin/env python3
"""校验「出厂客户端里没有明文内置密钥」——即 APK 里只有混淆后的字节数组。

为什么需要它
------------
`built_in_keys.dart` 里的密钥是 XOR 混淆的（`s[i] = bytes[i] ^ KEY[i % 4]`），
所以 **APK 里不应出现任何明文密钥**。这个脚本把 Dart 数组**解码**成明文候选，
再去源树与 APK 里搜，命中即失败。

与旧版 `check_keys.ps1` 的区别（旧版有三个坑，都已修）：
1. 旧版硬编码 6 个前缀 ⇒ 第 7 把 `_stepfun` 从未被检查；
2. 旧版路径写 `build/app/outputs/flutter-apk/app-release.apk`，实际发布件在 `release/*.apk`
   ⇒ 文件不存在时会直接抛异常，等于没检查；
3. 旧版每加一把钥匙就要手改 ⇒ 必然漂移。**本脚本从 Dart 数组自动派生，不需要维护清单。**

用法
----
    python scripts/check_builtin_keys.py              # 扫源树 + 所有 APK
    python scripts/check_builtin_keys.py --src-only   # 只扫源树（不依赖已构建 APK）
    python scripts/check_builtin_keys.py --changed    # 只扫本次暂存的改动文件（pre-commit 快档）
    python scripts/check_builtin_keys.py --gate       # 输出规则门约定的聚合 finding 行
    python scripts/check_builtin_keys.py --json       # 机器可读输出

退出码
------
    0  干净
    1  发现明文密钥
    2  用法 / 环境错误（如 Dart 文件缺失、解不出任何数组）

门集成（ruleguard）
-------------------
**本脚本不是 ruleguard 执行器**。规则 `SECURITY-001` 的 `exec.script` 是
`scripts/ci/check-change-safety.js`，由它 `--json` 调本脚本、再把命中重新表述成自己的
finding（id = `builtin-key-plaintext`）。那个 id 必须在 `SECURITY-001` 的 `exec.findings`
里被认领，否则会被记成 `checker-failure` 未认领错误。

`--gate` 是**手动/调试**出口：直接按 `scripts/ruleguard/lib/run.js` 的
`FINDING_LINE_AGGREGATE` 方言打印（`- [error] <说明> (id: builtin-key-plaintext)`），
**当前无任何调用者** —— 若哪天要把本脚本直接登记成执行器，这条才是入口。
`--changed` 隐含跳过 APK 扫描（APK 是构建产物，不存在于提交时刻）。
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLIENT = ROOT / 'apps' / 'khy-os-client-app'
DART = CLIENT / 'lib' / 'core' / 'config' / 'built_in_keys.dart'

# 与 built_in_keys.dart / gen_keys.py 保持一致
XOR_KEY = (0xA3, 0x5F, 0xC2, 0x1B)

# 作者侧生成器本身含明文，按项目决定豁免（不进 APK，不参与打包）
ALLOWLIST = {'scripts/gen_keys.py'}

# 供 ruleguard 认领的 finding id（与登记表 exec.findings 必须逐字一致）
FINDING_ID = 'builtin-key-plaintext'

SKIP_DIR_PARTS = {'build', '.dart_tool', '.git', 'node_modules', '__pycache__'}

_ARRAY_RE = re.compile(r'static const List<int> _(\w+)\s*=\s*\[(.*?)\];', re.S)
_NUM_RE = re.compile(r'\d+')


def decode_arrays(dart_path: Path = DART) -> dict[str, str]:
    """从 Dart 源里解出全部明文候选。键 = 数组名（去掉前导下划线）。"""
    if not dart_path.exists():
        raise FileNotFoundError(f'找不到 {dart_path}')
    txt = dart_path.read_text(encoding='utf-8')
    out: dict[str, str] = {}
    for m in _ARRAY_RE.finditer(txt):
        name = m.group(1)
        nums = [int(x) for x in _NUM_RE.findall(m.group(2))]
        if not nums:
            continue
        out[name] = ''.join(
            chr(b ^ XOR_KEY[i % 4]) for i, b in enumerate(nums)
        )
    return out


def iter_source_files():
    """遍历客户端源树。用 os.walk 就地剪枝，避免 rglob 下潜 build/ 之类的巨大目录。"""
    import os
    for dirpath, dirnames, filenames in os.walk(CLIENT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIR_PARTS]
        for fn in filenames:
            p = Path(dirpath) / fn
            if p.suffix == '.apk':
                continue
            yield p


def changed_paths() -> set[str] | None:
    """本次**暂存**的改动路径（repo 相对、正斜杠）。取不到 git 时返回 None = 不过滤。

    判改动集一律用 `--cached`：工作区里还混着别的会话的 WIP，
    只看工作区会把无关文件算进来。
    """
    try:
        proc = subprocess.run(
            ['git', 'diff', '--cached', '--name-only', '-z',
             '--diff-filter=ACMR'],
            cwd=str(ROOT), capture_output=True, check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return {p for p in proc.stdout.decode('utf-8', 'replace').split('\0') if p}


def find_apks() -> list[Path]:
    """已知的出厂件位置。用定点 glob 而不是 build/** 深挖（build/ 可能很大）。"""
    patterns = (
        'release/*.apk',
        'build/app/outputs/flutter-apk/*.apk',
        'build/app/outputs/apk/**/*.apk',
    )
    seen: list[Path] = []
    for pat in patterns:
        for p in CLIENT.glob(pat):
            # Shizuku 是第三方上游二进制，不含我们的内置密钥
            if 'shizuku' in p.name.lower():
                continue
            if p not in seen:
                seen.append(p)
    return sorted(seen)


def scan_blob(data: bytes, plains: dict[str, str]) -> list[str]:
    return [name for name, val in plains.items() if val and val.encode() in data]


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    out = ap.add_mutually_exclusive_group()
    out.add_argument('--json', action='store_true', help='机器可读输出')
    out.add_argument('--gate', action='store_true',
                     help='输出 ruleguard 聚合 finding 行（- [error] … (id: …)）')
    ap.add_argument('--src-only', action='store_true', help='只扫源树，跳过 APK')
    ap.add_argument('--changed', action='store_true',
                    help='只扫本次暂存的改动文件（隐含 --src-only）')
    args = ap.parse_args()

    try:
        plains = decode_arrays()
    except Exception as exc:  # noqa: BLE001
        print(f'ERROR: {exc}', file=sys.stderr)
        return 2
    plains = {k: v for k, v in plains.items() if v and v != 'public'}
    if not plains:
        print(f'ERROR: 从 {DART.name} 解不出任何密钥数组', file=sys.stderr)
        return 2

    # --changed 只看暂存改动；APK 是构建产物，提交时刻不存在 ⇒ 一并跳过
    src_only = args.src_only or args.changed
    only = changed_paths() if args.changed else None

    findings: list[dict] = []
    scanned_src = 0
    for p in iter_source_files():
        rel = p.relative_to(ROOT).as_posix()
        if rel in ALLOWLIST:
            continue
        if only is not None and rel not in only:
            continue
        scanned_src += 1
        try:
            data = p.read_bytes()
        except OSError:
            continue
        for name in scan_blob(data, plains):
            findings.append({'where': rel, 'kind': 'source', 'key': name})

    scanned_apk: list[dict] = []
    if not src_only:
        for apk in find_apks():
            entry = {'apk': apk.relative_to(ROOT).as_posix(),
                     'bytes': apk.stat().st_size, 'leaks': []}
            try:
                with zipfile.ZipFile(apk) as z:
                    for nm in z.namelist():
                        try:
                            data = z.read(nm)
                        except (OSError, zipfile.BadZipFile):
                            continue
                        for name in scan_blob(data, plains):
                            entry['leaks'].append({'entry': nm, 'key': name})
            except (OSError, zipfile.BadZipFile) as exc:
                entry['error'] = str(exc)
            scanned_apk.append(entry)
            for leak in entry['leaks']:
                findings.append({'where': f"{entry['apk']}!{leak['entry']}",
                                 'kind': 'apk', 'key': leak['key']})

    ok = not findings

    if args.json:
        print(json.dumps({
            'ok': ok,
            'keys': sorted(plains),
            'scannedSourceFiles': scanned_src,
            'apks': scanned_apk,
            'findings': findings,
        }, ensure_ascii=False, indent=2))
        print(f"Summary: {len(findings)} plaintext hit(s) / {len(plains)} key(s) / {scanned_src} file(s)")
        return 0 if ok else 1

    if args.gate:
        # 只输出聚合 finding 行，保持 stdout 对 ruleguard 解析器干净。
        for f in findings:
            print(f'- [error] 出厂件出现明文内置密钥 [{f["key"]}] @ {f["where"]} '
                  f'(id: {FINDING_ID})')
        return 0 if ok else 1

    print(f'内置密钥 {len(plains)} 把（从 {DART.name} 解码，自动派生）')
    for name in sorted(plains):
        v = plains[name]
        print(f'  _{name:<12} {v[:6]}…(len={len(v)})')

    scope = '（仅本次暂存改动）' if only is not None else ''
    print(f'\n[源树] 扫描 {scanned_src} 个文件{scope}'
          f'（豁免: {", ".join(sorted(ALLOWLIST))}）')
    src_hits = [f for f in findings if f['kind'] == 'source']
    if src_hits:
        for f in src_hits:
            print(f'  ❌ [明文] {f["where"]}  <- {f["key"]}')
    else:
        print('  ✅ 源树无明文密钥')

    if src_only:
        print('\n[APK] 已跳过（' + ('--changed' if args.changed else '--src-only') + '）')
    else:
        print('\n[APK]')
        if not scanned_apk:
            print('  ⚠ 未找到 APK（先构建，或用 --src-only 只查源树）')
        for entry in scanned_apk:
            if entry.get('error'):
                print(f'  ⚠ {entry["apk"]}: 读取失败 {entry["error"]}')
            elif entry['leaks']:
                print(f'  ❌ {entry["apk"]} ({entry["bytes"]:,}B) 发现明文:')
                for leak in entry['leaks']:
                    print(f'      [{leak["key"]}] in {leak["entry"]}')
            else:
                print(f'  ✅ {entry["apk"]} ({entry["bytes"]:,}B) 无明文密钥')

    print('\n结论: ' + ('✅ 通过 —— 出厂客户端只有混淆密钥' if ok
                      else f'❌ 失败 —— {len(findings)} 处明文'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
