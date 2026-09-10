import os
import re

# Final comprehensive search
js_file = r'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-extracted\out\renderer\assets\styles-DyAcaLKy.js'

with open(js_file, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Find thought level value mapping (full)
idx = content.find('sKe={disabled:')
if idx >= 0:
    print('=== THOUGHT LEVEL VALUE MAPPING ===')
    print(content[idx:idx+2000])

# Find thought level options definition
idx = content.find('thoughtLevel.options')
if idx >= 0:
    print('\n=== THOUGHT LEVEL OPTIONS ===')
    print(content[max(0,idx-500):idx+1000])

# Find model selector
idx = content.find('openModelMenu')
if idx >= 0:
    print('\n=== MODEL SELECTOR ===')
    print(content[max(0,idx-200):idx+500])

# Find permission panel
idx = content.find('chat.permission.title')
if idx >= 0:
    print('\n=== PERMISSION PANEL ===')
    print(content[max(0,idx-200):idx+500])

# Find subagent UI
idx = content.find('subagents')
while idx >= 0 and idx < 100000:
    ctx = content[max(0,idx-100):idx+200]
    if 'collapse' in ctx.lower() or 'expand' in ctx.lower() or 'fold' in ctx.lower():
        print(f'\n=== SUBAGENT UI at {idx} ===')
        print(ctx)
    idx = content.find('subagents', idx + 1)

# Find file mention
idx = content.find('appendFileMention')
if idx >= 0:
    print('\n=== FILE MENTION ===')
    print(content[max(0,idx-200):idx+500])

# Find attachment
idx = content.find('attachmentMaxBytes')
if idx >= 0:
    print('\n=== ATTACHMENT ===')
    print(content[max(0,idx-200):idx+500])

# Find context menu
idx = content.find('contextWindow')
if idx >= 0:
    print('\n=== CONTEXT WINDOW ===')
    print(content[max(0,idx-200):idx+500])
