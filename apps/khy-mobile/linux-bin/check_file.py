import os

apk_path = os.path.join(os.path.dirname(__file__), 'proot-static.apk')

with open(apk_path, 'rb') as f:
    header = f.read(20)
    print(f"File size: {os.path.getsize(apk_path)} bytes")
    print(f"Header bytes: {header.hex()}")
    print(f"Header as string: {header}")
