import os
import re

# Search the main styles JS file for thought level options
js_file = r'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-extracted\out\renderer\assets\styles-DyAcaLKy.js'

with open(js_file, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Find the thought level selector component
# Look for the pattern around thought-level
idx = content.find('thought-level')
if idx >= 0:
    # Get a larger context
    ctx = content[max(0,idx-2000):idx+2000]
    print('=== thought-level large context ===')
    print(ctx)

# Find the thought level options array
# Look for patterns like ['low', 'medium', 'high'] or similar
matches = list(re.finditer(r'\[.*?(?:low|medium|high|auto|none|minimal|basic|standard|extended|max).*?\]', content, re.IGNORECASE))
for m in matches[:10]:
    ctx = content[max(0,m.start()-100):m.end()+100]
    if 'thought' in ctx.lower() or 'reason' in ctx.lower() or 'level' in ctx.lower():
        print(f'\n=== Found array at {m.start()} ===')
        print(ctx)
