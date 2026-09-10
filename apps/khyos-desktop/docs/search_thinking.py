import os
import re

# Search the main styles JS file for thinking/reasoning patterns
js_file = r'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-extracted\out\renderer\assets\styles-DyAcaLKy.js'

with open(js_file, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Search for thinking level UI
patterns = [
    (r'thought-level', 'thought-level'),
    (r'thinking.*level', 'thinking.*level'),
    (r'reasoning.*level', 'reasoning.*level'),
    (r'effort', 'effort'),
    (r'low.*medium.*high', 'low.*medium.*high'),
    (r'auto', 'auto'),
]

for pattern, name in patterns:
    matches = list(re.finditer(pattern, content, re.IGNORECASE))
    if matches:
        print(f'\n=== {name} ({len(matches)} matches) ===')
        for m in matches[:3]:
            start = max(0, m.start() - 100)
            end = min(len(content), m.end() + 200)
            print(f'At {m.start()}: {content[start:end]}')
            print('---')

# Also search for the thought level selector UI
idx = content.find('thought-level')
if idx >= 0:
    print(f'\n=== thought-level context ===')
    print(content[max(0,idx-500):idx+500])
