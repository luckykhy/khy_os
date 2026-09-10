#!/usr/bin/env python3
"""Generate XOR-encoded byte arrays for built-in API keys."""

# XOR key: 4 bytes, rotated per position
XK = [0xA3, 0x5F, 0xC2, 0x1B]

def encode(s):
    return [ord(c) ^ XK[i % 4] for i, c in enumerate(s)]

keys = {
    'SupXH': 'sk-kxfDu1UuUz4na6gNnoTy9SXrfqBvC5a6xlLWOmcgxvGSyP8y',
    'CommandCode': 'user_QduohLPx5gneWbdfWEwdjuTgtJ7bEUAfSEJ2urouYdnfUM9xQZaUAoFMgd9GU4KNcfNGk41Dr6ZWMFZweBV7PdU',
    'GLM': '844986c572bf414489be6f7d06fc0d95.p0lOiYflTGXjoury',
    'OpenCodeGo': 'sk-GfGfEeMHAP9OqViis7N6yFQtzVBTQIalFbWAEdH5MMpUwAXgVToUpX5mzRxxIrCX',
    'SenseNova': 'sk-ZqZmy6xPoGTJhAiAVe7RdRCbHQyrXRfo',
    'Agnes': 'sk-TDyXYtuXXCUrw42bDqtz0PigooeOtb5Oh4HUUvr47hxHrgDG',
}

lines = []
for name, key in keys.items():
    encoded = encode(key)
    # Format as Dart list, 12 per line
    dart_lines = []
    for i in range(0, len(encoded), 12):
        chunk = encoded[i:i+12]
        dart_lines.append('    ' + ', '.join(str(x) for x in chunk))
    lines.append(f'  static const List<int> _{name} = [')
    lines.extend(dart_lines)
    lines.append('  ];')
    lines.append('')
    # Verify
    decoded = ''.join(chr(x ^ XK[i % 4]) for i, x in enumerate(encoded))
    assert decoded == key, f'Mismatch for {name}'

# Output Dart code
print('// XOR key: 0xA3, 0x5F, 0xC2, 0x1B')
print('// Decode: s[i] = bytes[i] ^ KEY[i % 4]')
print('')
for l in lines:
    print(l)
