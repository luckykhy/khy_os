import os
import re

js_dir = r'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-extracted\out\renderer\assets'

# Get all JS files sorted by size (largest first)
js_files = []
for f in os.listdir(js_dir):
    if f.endswith('.js'):
        path = os.path.join(js_dir, f)
        size = os.path.getsize(path)
        js_files.append((f, size, path))

js_files.sort(key=lambda x: x[1], reverse=True)

# Only search the top 20 largest JS files
top_js = js_files[:20]
print(f'Searching top {len(top_js)} JS files...')

patterns = ['mention', 'context', 'attach', 'chip', 'permission', 'model', 'think', 'reason', 'agent', 'collapse', 'fold', 'expand', 'select', 'dropdown', 'popup', 'popover', 'input', 'prompt', 'send', 'button']

for f, size, path in top_js:
    with open(path, 'r', encoding='utf-8', errors='ignore') as file:
        content = file.read()
        found = []
        for p in patterns:
            if p in content.lower():
                found.append(p)
        if found:
            print(f'\n{f} ({size} bytes): found {found}')
