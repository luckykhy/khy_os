import os
import re

# Final comprehensive search for all 5 patterns
js_file = r'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-extracted\out\renderer\assets\styles-DyAcaLKy.js'

with open(js_file, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

print('=== 1. ADD CONTEXT / @MENTION / FILE ATTACHMENT ===')

# Find mention patterns
idx = content.find('chat.mention')
while idx >= 0 and idx < 100000:
    ctx = content[max(0,idx-100):idx+300]
    print(f'\n--- chat.mention at {idx} ---')
    print(ctx)
    idx = content.find('chat.mention', idx + 1)

# Find file mention patterns
idx = content.find('appendFileMention')
if idx >= 0:
    print('\n--- appendFileMention ---')
    print(content[max(0,idx-200):idx+500])

# Find attachment patterns
idx = content.find('chat.attachment')
while idx >= 0 and idx < 100000:
    ctx = content[max(0,idx-100):idx+300]
    print(f'\n--- chat.attachment at {idx} ---')
    print(ctx)
    idx = content.find('chat.attachment', idx + 1)

print('\n\n=== 2. PERMISSION CONTROL ===')

# Find permission patterns
idx = content.find('chat.permission')
while idx >= 0 and idx < 100000:
    ctx = content[max(0,idx-100):idx+300]
    print(f'\n--- chat.permission at {idx} ---')
    print(ctx)
    idx = content.find('chat.permission', idx + 1)

print('\n\n=== 3. MODEL SELECTION ===')

# Find model selector
idx = content.find('chat.toolbar.model')
while idx >= 0 and idx < 100000:
    ctx = content[max(0,idx-100):idx+300]
    print(f'\n--- chat.toolbar.model at {idx} ---')
    print(ctx)
    idx = content.find('chat.toolbar.model', idx + 1)

print('\n\n=== 4. THINKING INTENSITY ===')

# Find thought level patterns
idx = content.find('chat.toolbar.thoughtLevel')
while idx >= 0 and idx < 200000:
    ctx = content[max(0,idx-100):idx+300]
    print(f'\n--- chat.toolbar.thoughtLevel at {idx} ---')
    print(ctx)
    idx = content.find('chat.toolbar.thoughtLevel', idx + 1)

print('\n\n=== 5. SUB-AGENT FOLDING ===')

# Find subagent patterns
idx = content.find('subagent')
while idx >= 0 and idx < 100000:
    ctx = content[max(0,idx-100):idx+300]
    if 'collapse' in ctx.lower() or 'expand' in ctx.lower() or 'fold' in ctx.lower() or 'tree' in ctx.lower():
        print(f'\n--- subagent at {idx} ---')
        print(ctx)
    idx = content.find('subagent', idx + 1)
