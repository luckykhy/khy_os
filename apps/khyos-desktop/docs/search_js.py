import os
import re

# Search through JS files for relevant patterns
js_dir = r'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-extracted\out\renderer\assets'

# Find main app JS files
main_js = None
for f in os.listdir(js_dir):
    if f.startswith('index-') and f.endswith('.js'):
        main_js = f
        break

if main_js:
    print(f'Found main JS: {main_js}')
    with open(os.path.join(js_dir, main_js), 'r', encoding='utf-8') as f:
        content = f.read()
    print(f'Size: {len(content)} chars')
    
    # Search for relevant patterns
    patterns = ['mention', 'context', 'attach', 'chip', 'tag', 'file', 'permission', 'model', 'think', 'reason', 'agent', 'collapse', 'fold', 'expand', 'select', 'dropdown', 'popup', 'popover', 'input', 'prompt', 'send', 'button']
    for p in patterns:
        idx = content.lower().find(p)
        if idx >= 0:
            print(f'\nFound "{p}" at {idx}:')
            print(content[max(0,idx-50):idx+200])
            print('---')
