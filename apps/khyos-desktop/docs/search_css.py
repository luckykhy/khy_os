import re

with open(r'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-extracted\out\renderer\assets\styles-t2tKjMWX.css', 'r', encoding='utf-8') as f:
    content = f.read()

# Find all remaining color blocks
blocks = re.findall(r'([a-zA-Z\[\]="._-]+)\s*\{([^}]+)\}', content)
color_blocks = []
for selector, block in blocks:
    vars_in_block = re.findall(r'(--color-[a-z-]+):\s*([^;]+);', block)
    if len(vars_in_block) > 5:
        color_blocks.append((selector, vars_in_block))

# Print remaining blocks
for selector, vars_list in color_blocks[5:]:
    print(f'\nSelector: {selector}')
    print(f'Variables: {len(vars_list)}')
    for var, val in vars_list:
        print(f'  {var}: {val}')

# Also find dark theme overrides
dark_match = re.search(r'\[data-theme\s*=\s*"dark"\][^{]*\{([^}]+)\}', content)
if dark_match:
    print('\n\n=== DARK THEME OVERRIDES ===')
    dark_vars = re.findall(r'(--[a-z-]+):\s*([^;]+);', dark_match.group(1))
    print(f'Variables: {len(dark_vars)}')
    for var, val in dark_vars[:50]:
        print(f'  {var}: {val}')
