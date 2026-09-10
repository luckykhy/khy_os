import os
import re

# Search the main styles JS file for thought level options
js_file = r'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-extracted\out\renderer\assets\styles-DyAcaLKy.js'

with open(js_file, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Find thought level values
idx = content.find('thought-level')
while idx >= 0:
    ctx = content[max(0,idx-200):idx+500]
    if 'low' in ctx.lower() or 'medium' in ctx.lower() or 'high' in ctx.lower() or 'auto' in ctx.lower() or 'value' in ctx.lower():
        print(f'=== thought-level at {idx} ===')
        print(ctx)
        print('---')
    idx = content.find('thought-level', idx + 1)
    if idx > 2000000:
        break

# Find thought level options
matches = list(re.finditer(r'thought.*level.*option|option.*thought.*level', content, re.IGNORECASE))
for m in matches[:5]:
    print(f'\n=== Found at {m.start()} ===')
    print(content[max(0,m.start()-200):m.end()+300])

# Search for actual level values
for level in ['low', 'medium', 'high', 'auto', 'none']:
    idx = content.lower().find(f'"{level}"')
    while idx >= 0:
        ctx = content[max(0,idx-100):idx+200]
        if 'thought' in ctx.lower() or 'reason' in ctx.lower():
            print(f'\n=== {level} at {idx} ===')
            print(ctx)
        idx = content.lower().find(f'"{level}"', idx + 1)
        if idx > 2000000:
            break
