#!/usr/bin/env python3
# @pattern Command, Interpreter
"""
Patch GGUF file: change rope.dimension_sections from [11, 11, 10] to [11, 11, 10, 0].

llama.cpp expects exactly 4 elements for qwen35.rope.dimension_sections,
but Ollama-exported Qwen 3.5 dense models only have 3. This script patches
the GGUF metadata in-place to add the missing trailing 0.

Usage:
  python3 patch_gguf_rope.py <model.gguf>
  python3 patch_gguf_rope.py  # defaults to ../models/qwen3.5-4b.gguf
"""
import struct
import sys
import os
import shutil

GGUF_MAGIC = b'GGUF'
# GGUF value types
GGUF_TYPE_UINT8    = 0
GGUF_TYPE_INT8     = 1
GGUF_TYPE_UINT16   = 2
GGUF_TYPE_INT16    = 3
GGUF_TYPE_UINT32   = 4
GGUF_TYPE_INT32    = 5
GGUF_TYPE_FLOAT32  = 6
GGUF_TYPE_BOOL     = 7
GGUF_TYPE_STRING   = 8
GGUF_TYPE_ARRAY    = 9
GGUF_TYPE_UINT64   = 10
GGUF_TYPE_INT64    = 11
GGUF_TYPE_FLOAT64  = 12

TYPE_SIZES = {
    GGUF_TYPE_UINT8: 1, GGUF_TYPE_INT8: 1,
    GGUF_TYPE_UINT16: 2, GGUF_TYPE_INT16: 2,
    GGUF_TYPE_UINT32: 4, GGUF_TYPE_INT32: 4,
    GGUF_TYPE_FLOAT32: 4, GGUF_TYPE_BOOL: 1,
    GGUF_TYPE_UINT64: 8, GGUF_TYPE_INT64: 8,
    GGUF_TYPE_FLOAT64: 8,
}


def read_string(f):
    length = struct.unpack('<Q', f.read(8))[0]
    return f.read(length).decode('utf-8')


def read_value(f):
    """Read a typed GGUF value, return (type, value, raw_bytes_consumed)."""
    vtype = struct.unpack('<I', f.read(4))[0]
    if vtype == GGUF_TYPE_STRING:
        s = read_string(f)
        return vtype, s
    elif vtype == GGUF_TYPE_ARRAY:
        elem_type = struct.unpack('<I', f.read(4))[0]
        count = struct.unpack('<Q', f.read(8))[0]
        elems = []
        for _ in range(count):
            if elem_type == GGUF_TYPE_STRING:
                elems.append(read_string(f))
            else:
                sz = TYPE_SIZES.get(elem_type, 4)
                raw = f.read(sz)
                if elem_type == GGUF_TYPE_INT32:
                    elems.append(struct.unpack('<i', raw)[0])
                elif elem_type == GGUF_TYPE_UINT32:
                    elems.append(struct.unpack('<I', raw)[0])
                elif elem_type == GGUF_TYPE_FLOAT32:
                    elems.append(struct.unpack('<f', raw)[0])
                elif elem_type == GGUF_TYPE_INT64:
                    elems.append(struct.unpack('<q', raw)[0])
                elif elem_type == GGUF_TYPE_UINT64:
                    elems.append(struct.unpack('<Q', raw)[0])
                else:
                    elems.append(raw)
        return vtype, (elem_type, elems)
    else:
        sz = TYPE_SIZES.get(vtype, 4)
        raw = f.read(sz)
        if vtype == GGUF_TYPE_INT32:
            return vtype, struct.unpack('<i', raw)[0]
        elif vtype == GGUF_TYPE_UINT32:
            return vtype, struct.unpack('<I', raw)[0]
        elif vtype == GGUF_TYPE_FLOAT32:
            return vtype, struct.unpack('<f', raw)[0]
        elif vtype == GGUF_TYPE_BOOL:
            return vtype, bool(raw[0])
        elif vtype == GGUF_TYPE_UINT64:
            return vtype, struct.unpack('<Q', raw)[0]
        elif vtype == GGUF_TYPE_INT64:
            return vtype, struct.unpack('<q', raw)[0]
        else:
            return vtype, raw


def scan_gguf(filepath):
    """Scan GGUF file and find the rope.dimension_sections key."""
    target_key = None
    with open(filepath, 'rb') as f:
        magic = f.read(4)
        assert magic == GGUF_MAGIC, f"Not a GGUF file: {magic}"
        version = struct.unpack('<I', f.read(4))[0]
        n_tensors = struct.unpack('<Q', f.read(8))[0]
        n_kv = struct.unpack('<Q', f.read(8))[0]

        print(f"GGUF v{version}, {n_kv} KV pairs, {n_tensors} tensors")

        for i in range(n_kv):
            key_start = f.tell()
            key = read_string(f)
            value_start = f.tell()
            vtype, val = read_value(f)
            value_end = f.tell()

            if 'dimension_sections' in key:
                print(f"\nFound: {key}")
                print(f"  Type: array, Value: {val}")
                print(f"  File offset: key@{key_start}, value@{value_start}, end@{value_end}")
                target_key = {
                    'key': key,
                    'key_start': key_start,
                    'value_start': value_start,
                    'value_end': value_end,
                    'vtype': vtype,
                    'val': val,
                }

        kv_end = f.tell()

    return target_key, kv_end, n_tensors, n_kv, version


def patch_gguf(filepath):
    """Patch dimension_sections from 3 elements to 4 (append 0)."""
    info, kv_end, n_tensors, n_kv, version = scan_gguf(filepath)

    if info is None:
        print("\nNo dimension_sections key found in GGUF metadata.")
        print("This model may not need patching, or uses a different key name.")
        return False

    elem_type, elems = info['val']
    if len(elems) == 4:
        print(f"\nAlready has 4 elements: {elems}. No patch needed.")
        return True
    if len(elems) != 3:
        print(f"\nUnexpected element count: {len(elems)} (expected 3). Aborting.")
        return False

    print(f"\nPatching: {elems} -> {elems + [0]}")

    # Strategy: rebuild the entire file because inserting 4 bytes shifts all offsets.
    # Read original file in chunks.
    backup = filepath + '.bak'
    if not os.path.exists(backup):
        print(f"Creating backup: {backup}")
        shutil.copy2(filepath, backup)

    with open(filepath, 'rb') as f:
        # Read everything before the array count (value_start + 4 bytes type + 4 bytes elem_type)
        # Array layout: [type:u32] [elem_type:u32] [count:u64] [data...]
        # value_start points to the type field
        array_count_offset = info['value_start'] + 4 + 4  # skip type(u32) + elem_type(u32)
        f.seek(0)
        before = f.read(array_count_offset)

        # Read old count
        old_count_bytes = f.read(8)
        old_count = struct.unpack('<Q', old_count_bytes)[0]
        assert old_count == 3, f"Expected count 3, got {old_count}"

        # Read array data (3 x int32 = 12 bytes)
        array_data = f.read(3 * 4)

        # Read everything after
        after = f.read()

    # Build new file
    new_count = struct.pack('<Q', 4)
    new_array_data = array_data + struct.pack('<i', 0)  # append int32(0)

    with open(filepath, 'wb') as f:
        f.write(before)
        f.write(new_count)
        f.write(new_array_data)
        f.write(after)

    new_size = os.path.getsize(filepath)
    print(f"Patched successfully. New file size: {new_size:,} bytes (+4 bytes)")
    return True


def main():
    default_path = os.path.join(os.path.dirname(__file__), '..', 'models', 'qwen3.5-4b.gguf')
    filepath = sys.argv[1] if len(sys.argv) > 1 else default_path
    filepath = os.path.abspath(filepath)

    if not os.path.exists(filepath):
        print(f"File not found: {filepath}")
        sys.exit(1)

    print(f"File: {filepath}")
    print(f"Size: {os.path.getsize(filepath):,} bytes\n")

    success = patch_gguf(filepath)
    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()
