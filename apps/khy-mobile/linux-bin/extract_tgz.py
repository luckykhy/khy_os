import tarfile
import os
import gzip

apk_path = os.path.join(os.path.dirname(__file__), 'proot-static.apk')
extract_dir = os.path.join(os.path.dirname(__file__), 'proot-extract5')

# The file is gzip compressed, not a zip
with gzip.open(apk_path, 'rb') as f:
    # Read the decompressed data
    decompressed = f.read()
    print(f"Decompressed size: {len(decompressed)} bytes")
    
    # Write to a temp tar file
    tar_path = os.path.join(os.path.dirname(__file__), 'proot-static.tar')
    with open(tar_path, 'wb') as out:
        out.write(decompressed)
    
    # Extract the tar file
    with tarfile.open(tar_path, 'r') as tar:
        tar.extractall(extract_dir)
        print("Extracted files:")
        for member in tar.getnames():
            print(f"  {member}")
