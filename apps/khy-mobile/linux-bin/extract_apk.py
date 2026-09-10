import zipfile
import os

apk_path = os.path.join(os.path.dirname(__file__), 'proot-static.apk')
extract_dir = os.path.join(os.path.dirname(__file__), 'proot-extract4')

with zipfile.ZipFile(apk_path, 'r') as z:
    z.extractall(extract_dir)
    print("Extracted files:")
    for name in z.namelist():
        print(f"  {name}")
