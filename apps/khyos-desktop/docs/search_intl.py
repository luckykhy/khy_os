import os
import re

# Search the main styles JS file for i18n message IDs related to UI patterns
js_file = r'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-extracted\out\renderer\assets\styles-DyAcaLKy.js'

with open(js_file, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Search for i18n message IDs
patterns = [
    r'chat\.toolbar\.thoughtLevel',
    r'chat\.toolbar\.model',
    r'chat\.toolbar\.mode',
    r'chat\.permission',
    r'chat\.attachment',
    r'chat\.mention',
    r'chat\.context',
    r'chat\.subagent',
    r'chat\.collapse',
    r'chat\.expand',
]

for p in patterns:
    matches = list(re.finditer(p, content, re.IGNORECASE))
    if matches:
        print(f'\n=== {p} ({len(matches)} matches) ===')
        for m in matches[:3]:
            start = max(0, m.start() - 100)
            end = min(len(content), m.end() + 200)
            print(f'At {m.start()}: {content[start:end]}')
            print('---')
