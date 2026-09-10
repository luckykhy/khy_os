import os
import re

# Search the main styles JS file for specific patterns
js_file = r'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-extracted\out\renderer\assets\styles-DyAcaLKy.js'

with open(js_file, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Search for thought/thinking level patterns
patterns = [
    (r'thoughtOption', 'thoughtOption'),
    (r'thinkingLevel', 'thinkingLevel'),
    (r'reasoningEffort', 'reasoningEffort'),
    (r'modelMenuDisabled', 'modelMenuDisabled'),
    (r'onOpenModelMenu', 'onOpenModelMenu'),
    (r'onCycleThoughtLevel', 'onCycleThoughtLevel'),
    (r'data-thought', 'data-thought'),
    (r'permission', 'permission'),
    (r'subagent', 'subagent'),
    (r'collapse', 'collapse'),
    (r'expand', 'expand'),
    (r'attachment', 'attachment'),
    (r'fileMention', 'fileMention'),
]

for pattern, name in patterns:
    matches = list(re.finditer(pattern, content, re.IGNORECASE))
    if matches:
        print(f'\n=== {name} ({len(matches)} matches) ===')
        for m in matches[:2]:  # Show first 2 matches
            start = max(0, m.start() - 100)
            end = min(len(content), m.end() + 200)
            print(f'At {m.start()}: {content[start:end]}')
            print('---')
