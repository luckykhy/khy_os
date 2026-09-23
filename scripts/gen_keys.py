#!/usr/bin/env python3
"""内置 API 密钥 -> Dart XOR 字节数组。

用法
----
    python scripts/gen_keys.py            # 打印 Dart 数组块（贴回 built_in_keys.dart）
    python scripts/gen_keys.py --check    # 校验 built_in_keys.dart 与本文件 keys 是否一致

真源说明
--------
**出厂二进制里唯一的真源是 `apps/khy-os-client-app/lib/core/config/built_in_keys.dart`。**
本文件是「作者侧」输入：改钥匙 → 跑一次 → 把输出贴回 Dart。`--check` 用来防止两边漂移
（历史上曾漂移过一次：Dart 有 7 个数组，本文件只有 6 把，重跑会静默丢掉 stepfun）。

⚠ 本文件含明文密钥。按项目决定，这些是免费额度钥匙，**提交暴露可接受**；
   但**打包进 APK 的必须只有混淆后的字节数组**（用 `scripts/check_builtin_keys.py` 验）。
"""
import re
import sys
from pathlib import Path

# XOR key: 4 bytes, rotated per position
XK = [0xA3, 0x5F, 0xC2, 0x1B]

DART = (Path(__file__).resolve().parent.parent
        / 'apps/khy-os-client-app/lib/core/config/built_in_keys.dart')


def encode(s):
    return [ord(c) ^ XK[i % 4] for i, c in enumerate(s)]


def decode(b):
    return ''.join(chr(x ^ XK[i % 4]) for i, x in enumerate(b))


# 键名必须与 built_in_keys.dart 里的数组名（去掉前导下划线）逐字一致
keys = {
    'supxh': 'sk-kxfDu1UuUz4na6gNnoTy9SXrfqBvC5a6xlLWOmcgxvGSyP8y',
    'commandcode': 'user_QduohLPx5gneWbdfWEwdjuTgtJ7bEUAfSEJ2urouYdnfUM9xQZaUAoFMgd9GU4KNcfNGk41Dr6ZWMFZweBV7PdU',
    'glm': '844986c572bf414489be6f7d06fc0d95.p0lOiYflTGXjoury',
    'opencodego': 'sk-GfGfEeMHAP9OqViis7N6yFQtzVBTQIalFbWAEdH5MMpUwAXgVToUpX5mzRxxIrCX',
    'sensenova': 'sk-ZqZmy6xPoGTJhAiAVe7RdRCbHQyrXRfo',
    'agnes': 'sk-TDyXYtuXXCUrw42bDqtz0PigooeOtb5Oh4HUUvr47hxHrgDG',
    'stepfun': 'eVS60W082wadUzOs3ja29LLSKeKmadx8JoADks1HH5yd0eH9O1yGvMurtxUjuvjI',
}


def dart_arrays():
    """从 built_in_keys.dart 读出所有 `static const List<int> _name = [...]`。"""
    if not DART.exists():
        return {}
    txt = DART.read_text(encoding='utf-8')
    out = {}
    for m in re.finditer(r'static const List<int> _(\w+)\s*=\s*\[(.*?)\];', txt, re.S):
        out[m.group(1)] = [int(x) for x in re.findall(r'\d+', m.group(2))]
    return out


def render():
    lines = []
    for name, key in keys.items():
        enc = encode(key)
        assert decode(enc) == key, f'XOR 往返失败: {name}'
        lines.append(f'  static const List<int> _{name} = [')
        for i in range(0, len(enc), 12):
            lines.append('    ' + ', '.join(str(x) for x in enc[i:i + 12]) + ',')
        lines.append('  ];')
        lines.append('')
    head = [
        '// XOR key: 0xA3, 0x5F, 0xC2, 0x1B',
        '// Decode: s[i] = bytes[i] ^ KEY[i % 4]',
        '',
    ]
    return '\n'.join(head + lines)


def check():
    actual = dart_arrays()
    bad = 0
    for name, key in keys.items():
        if name not in actual:
            print(f'  ❌ {name}: Dart 里没有 _{name} 数组')
            bad += 1
        elif actual[name] != encode(key):
            print(f'  ❌ {name}: Dart 数组与本文件不一致（需重跑生成器）')
            bad += 1
        else:
            print(f'  ✅ {name}: 一致')
    for name in actual:
        if name not in keys:
            print(f'  ⚠ {name}: 只存在于 Dart，本文件没有 -> 重跑生成器会丢掉它')
            bad += 1
    if bad:
        print(f'\n{len(keys) + len(actual) - bad} 项通过，{bad} 项有问题。')
        return 1
    print(f'\n全部 {len(keys)} 把一致。')
    return 0


if __name__ == '__main__':
    if '--check' in sys.argv:
        sys.exit(check())
    print(render())
