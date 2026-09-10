import struct
import json
import os
import sys

asar_path = r'C:\Program Files\ZCode\resources\app.asar'
output_dir = r'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-extracted'

with open(asar_path, 'rb') as f:
    data = f.read(16)
    print(f'First 16 bytes: {data.hex()}')
    
    # asar format: 4 bytes pickle_size, then pickle data
    # pickle data contains: 4 bytes header_size, then header JSON
    pickle_size = struct.unpack('<I', data[0:4])[0]
    header_size = struct.unpack('<I', data[4:8])[0]
    print(f'pickle_size={pickle_size}, header_size={header_size}')
    
    # Read header JSON starting at offset 8
    f.seek(8)
    header_bytes = f.read(header_size)
    print(f'Read {len(header_bytes)} bytes')
    
    # Try to parse JSON
    try:
        header = json.loads(header_bytes.decode('utf-8'))
    except:
        # Maybe there's extra data, try to find the JSON end
        # Find the last } character
        header_str = header_bytes.decode('utf-8', errors='ignore')
        last_brace = header_str.rfind('}')
        if last_brace > 0:
            header = json.loads(header_str[:last_brace+1])
        else:
            raise
    
    files = header.get('files', {})
    print(f'Total files: {len(files)}')
    
    css_files = [k for k in files if k.endswith('.css')]
    print(f'CSS files ({len(css_files)}):')
    for c in css_files[:10]:
        print(f'  {c}')
    
    js_files = [k for k in files if k.endswith('.js')]
    print(f'JS files ({len(js_files)}):')
    for j in js_files[:10]:
        print(f'  {j}')
