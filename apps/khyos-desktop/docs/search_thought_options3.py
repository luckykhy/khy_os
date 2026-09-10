import os
import re

# Search the main styles JS file for thought level options
js_file = r'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-extracted\out\renderer\assets\styles-DyAcaLKy.js'

with open(js_file, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Find the thought level options array
idx = content.find('thoughtLevel.options')
if idx >= 0:
    print('=== thoughtLevel.options ===')
    print(content[max(0,idx-500):idx+1000])

# Find the thought level type definition
idx = content.find('modelThoughtLevels')
if idx >= 0:
    print('\n=== modelThoughtLevels ===')
    print(content[max(0,idx-200):idx+500])

# Find the thought level values
for level in ['low', 'medium', 'high', 'auto', 'none', 'minimal', 'basic', 'standard', 'extended', 'max']:
    idx = content.find(f'"{level}"')
    while idx >= 0:
        ctx = content[max(0,idx-100):idx+200]
        if 'thought' in ctx.lower() or 'sKe' in ctx:
            print(f'\n=== {level} at {idx} ===')
            print(ctx)
        idx = content.find(f'"{level}"', idx + 1)
        if idx > 2000000:
            break
