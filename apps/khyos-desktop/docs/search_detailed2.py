import os
import re

# Search the main styles JS file for specific patterns
js_file = r'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-extracted\out\renderer\assets\styles-DyAcaLKy.js'

with open(js_file, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Find thought-level UI
idx = content.find('thought-level')
if idx >= 0:
    print('=== thought-level UI ===')
    print(content[max(0,idx-1000):idx+1000])

# Find thinking level options
idx = content.find('cycleThoughtLevel')
if idx >= 0:
    print('\n=== cycleThoughtLevel ===')
    print(content[max(0,idx-500):idx+1000])

# Find model menu
idx = content.find('openModelMenu')
if idx >= 0:
    print('\n=== openModelMenu ===')
    print(content[max(0,idx-500):idx+1000])

# Find permission panel
idx = content.find('permission')
while idx >= 0 and idx < 100000:
    ctx = content[max(0,idx-200):idx+300]
    if 'panel' in ctx.lower() or 'toggle' in ctx.lower() or 'switch' in ctx.lower() or 'auto' in ctx.lower():
        print(f'\n=== permission at {idx} ===')
        print(ctx)
    idx = content.find('permission', idx + 1)
