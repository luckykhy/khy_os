import os
import sys
import struct
import json
import shutil

asar_path = r'C:\Program Files\ZCode\resources\app.asar'
output_dir = r'D:\Portable\khy-os\apps\khyos-desktop\docs\zcode-extracted'

# Remove output dir if exists
if os.path.exists(output_dir):
    shutil.rmtree(output_dir)

f = open(asar_path, 'rb')

# Read header
f.seek(4)
header_size = struct.unpack('I', f.read(4))[0] - 8
f.seek(f.tell() + 8)
header = f.read(header_size).decode('utf-8')
files = json.loads(header)
baseoffset = f.tell()

def extract_dir(path, files_dict, dest):
    os.makedirs(dest, exist_ok=True)
    for name, contents in files_dict.items():
        item_path = os.path.join(path, name)
        item_dest = os.path.join(dest, name)
        if 'files' in contents:
            extract_dir(item_path, contents['files'], item_dest)
        elif 'offset' in contents:
            f.seek(baseoffset + int(contents['offset']))
            data = f.read(int(contents['size']))
            with open(item_dest, 'wb') as out:
                out.write(data)
            print(f'  Extracted: {item_path}')

print('Extracting...')
extract_dir('.', files['files'], output_dir)
f.close()
print(f'Done! Extracted to {output_dir}')
