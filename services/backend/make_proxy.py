import sys

def od(val, default):
    """Return val if not None/empty, else default"""
    if val is None or val == '':
        return default
    return val

# Read .env file
env = {}
try:
    with open('.env', 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                env[key.strip()] = value.strip()
except:
    pass

# Build config
cfg = {
    'enabled': env.get('ANTHROPIC_PROXY_ENABLED', 'false').lower() == 'true',
    'upstream': env.get('ANTHROPIC_PROXY_UPSTREAM', 'https://api.commandcode.ai/provider/v1/chat/completions'),
    'api_key': env.get('ANTHROPIC_PROXY_API_KEY', ''),
    'model': env.get('ANTHROPIC_PROXY_MODEL', 'meituan/LongCat-2.0:free'),
    'display_model': env.get('ANTHROPIC_PROXY_DISPLAY_MODEL', 'claude-opus-4-8'),
}

# Generate JavaScript code
js = '''#!/usr/bin/env node
"use strict";
const cfg = ''' + str(cfg).replace("'", '"') + ''';
// ... rest of proxy code
'''

with open('proxy.js', 'w') as f:
    f.write(js)

print('Generated proxy.js')
