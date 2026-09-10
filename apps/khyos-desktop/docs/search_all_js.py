import os
import re
import json

js_dir = r'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-extracted\out\renderer\assets'

# Get all JS files sorted by size (largest first - likely main app code)
js_files = []
for f in os.listdir(js_dir):
    if f.endswith('.js'):
        path = os.path.join(js_dir, f)
        size = os.path.getsize(path)
        js_files.append((f, size, path))

js_files.sort(key=lambda x: x[1], reverse=True)
print(f'Total JS files: {len(js_files)}')
print(f'Largest JS files:')
for f, size, path in js_files[:10]:
    print(f'  {f}: {size} bytes')

# Search for specific patterns in all JS files
patterns = ['mention', 'context', 'attach', 'chip', 'tag', 'file', 'permission', 'model', 'think', 'reason', 'agent', 'collapse', 'fold', 'expand', 'select', 'dropdown', 'popup', 'popover', 'input', 'prompt', 'send', 'button']

results = {}
for pattern in patterns:
    results[pattern] = []

for f, size, path in js_files:
    with open(path, 'r', encoding='utf-8', errors='ignore') as file:
        content = file.read()
        for pattern in patterns:
            if pattern in content.lower():
                # Find all occurrences
                idx = 0
                while True:
                    idx = content.lower().find(pattern, idx)
                    if idx == -1:
                        break
                    # Get context around the match
                    start = max(0, idx - 30)
                    end = min(len(content), idx + 100)
                    context = content[start:end]
                    results[pattern].append((f, context))
                    idx += 1

# Print results
for pattern, matches in results.items():
    if matches:
        print(f'\n=== Pattern: {pattern} ({len(matches)} matches) ===')
        for f, ctx in matches[:3]:  # Show first 3 matches
            print(f'  File: {f}')
            print(f'  Context: {ctx}')
            print()
