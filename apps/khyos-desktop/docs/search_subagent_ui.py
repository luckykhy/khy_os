import os
import re

# Search for subagent UI patterns
js_file = r'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-extracted\out\renderer\assets\styles-DyAcaLKy.js'

with open(js_file, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Find subagent UI
idx = content.find('subagent')
while idx >= 0 and idx < 200000:
    ctx = content[max(0,idx-100):idx+200]
    if 'collapse' in ctx.lower() or 'expand' in ctx.lower() or 'fold' in ctx.lower() or 'tree' in ctx.lower() or 'node' in ctx.lower():
        print(f'\n=== SUBAGENT UI at {idx} ===')
        print(ctx)
    idx = content.find('subagent', idx + 1)

# Find subagent node
idx = content.find('subagent-node')
if idx >= 0:
    print('\n=== SUBAGENT NODE ===')
    print(content[max(0,idx-200):idx+500])

# Find subagent tree
idx = content.find('subagentTree')
if idx >= 0:
    print('\n=== SUBAGENT TREE ===')
    print(content[max(0,idx-200):idx+500])

# Find subagent expand/collapse
idx = content.find('subagent')
while idx >= 0 and idx < 200000:
    ctx = content[max(0,idx-50):idx+150]
    if 'aria-expanded' in ctx or 'data-expanded' in ctx or 'toggle' in ctx:
        print(f'\n=== SUBAGENT EXPAND/COLLAPSE at {idx} ===')
        print(ctx)
    idx = content.find('subagent', idx + 1)
