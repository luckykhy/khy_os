#!/usr/bin/env python3
# @pattern Command, Interpreter
"""
Patch GGUF tensor names for Qwen 3.5 compatibility with llama.cpp b8390.

Problem: Ollama-exported Qwen 3.5 GGUF has tensor names like:
  blk.0.ssm_dt      (1D, bias-like)
  blk.0.ssm_a       (1D, weight-like)

But llama.cpp b8390 expects:
  blk.0.ssm_dt.bias
  blk.0.ssm_a.weight

This script rewrites the GGUF file, renaming these tensors in-place.
Since tensor names can change length, we rebuild the file from scratch.

Usage:
  python3 patch_gguf_tensors.py <model.gguf>
  python3 patch_gguf_tensors.py  # defaults to ../models/qwen3.5-4b.gguf
"""
import struct
import sys
import os
import shutil
import re

GGUF_MAGIC = b'GGUF'

# Tensor name renames applied to ALL tensors (regex -> replacement)
TENSOR_RENAMES = {
    # blk.X.ssm_dt (1D) -> blk.X.ssm_dt.bias
    # llama.cpp expects .bias suffix for dt tensors
    r'^(blk\.\d+\.ssm_dt)$': r'\1.bias',
}

# Tensor renames applied ONLY to SSM layers (n_head_kv=0).
# Ollama uses attn_qkv for SSM input projection; upstream uses ssm_in.
SSM_LAYER_RENAMES = {
    r'^(blk\.\d+\.)attn_qkv(.*)$': r'\1ssm_in\2',
}

# GGUF type sizes
TYPE_SIZES = {
    0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8,
}

# GGML type element sizes (for tensor data)
GGML_TYPE_SIZES = {
    0: 4,     # f32
    1: 2,     # f16
    2: 0,     # q4_0 (block quantized, handled separately)
    3: 0,     # q4_1
    6: 0,     # q5_0
    7: 0,     # q5_1
    8: 1,     # q8_0
    9: 0,     # q8_1
    10: 0,    # q2_K
    11: 0,    # q3_K_S
    12: 0,    # q3_K_M
    13: 0,    # q3_K_L
    14: 0,    # q4_K_S
    15: 0,    # q4_K_M
    16: 0,    # q5_K_S
    17: 0,    # q5_K_M
    18: 0,    # q6_K
    19: 0,    # q8_K
    26: 0,    # bf16 (2 bytes per element)
    30: 2,    # f64
}


def read_bytes(f, n):
    data = f.read(n)
    if len(data) != n:
        raise EOFError(f"Expected {n} bytes, got {len(data)}")
    return data


def read_u32(f):
    return struct.unpack('<I', read_bytes(f, 4))[0]


def read_u64(f):
    return struct.unpack('<Q', read_bytes(f, 8))[0]


def read_i32(f):
    return struct.unpack('<i', read_bytes(f, 4))[0]


def read_string(f):
    length = read_u64(f)
    return read_bytes(f, length).decode('utf-8')


def write_u32(f, v):
    f.write(struct.pack('<I', v))


def write_u64(f, v):
    f.write(struct.pack('<Q', v))


def write_string(f, s):
    encoded = s.encode('utf-8')
    write_u64(f, len(encoded))
    f.write(encoded)


def read_kv_value(f):
    """Read a KV value and return (type, raw_bytes) for verbatim copy."""
    start = f.tell()
    vtype = read_u32(f)

    if vtype == 8:  # string
        length = read_u64(f)
        f.read(length)
    elif vtype == 9:  # array
        elem_type = read_u32(f)
        count = read_u64(f)
        for _ in range(count):
            if elem_type == 8:
                length = read_u64(f)
                f.read(length)
            else:
                f.read(TYPE_SIZES.get(elem_type, 4))
    else:
        f.read(TYPE_SIZES.get(vtype, 4))

    end = f.tell()
    # Re-read as raw bytes
    f.seek(start)
    raw = f.read(end - start)
    return raw


def rename_tensor(name, is_ssm_layer=False):
    """Apply rename rules. Returns (new_name, was_renamed)."""
    # Apply global renames
    for pattern, replacement in TENSOR_RENAMES.items():
        new_name = re.sub(pattern, replacement, name)
        if new_name != name:
            return new_name, True

    # Apply SSM-layer-specific renames
    if is_ssm_layer:
        for pattern, replacement in SSM_LAYER_RENAMES.items():
            new_name = re.sub(pattern, replacement, name)
            if new_name != name:
                return new_name, True

    return name, False


def patch_gguf(filepath):
    """Parse and rebuild GGUF with renamed tensors."""
    print(f"Reading: {filepath}")
    print(f"Size: {os.path.getsize(filepath):,} bytes\n")

    # Phase 1: Parse everything
    kv_pairs = []
    tensor_infos = []
    head_count_kv = []  # per-layer n_head_kv values

    with open(filepath, 'rb') as f:
        magic = read_bytes(f, 4)
        assert magic == GGUF_MAGIC, f"Not a GGUF file"
        version = read_u32(f)
        n_tensors = read_u64(f)
        n_kv = read_u64(f)

        print(f"GGUF v{version}, {n_kv} KV pairs, {n_tensors} tensors")

        # Read KV pairs (as raw bytes for verbatim copy)
        for _ in range(n_kv):
            key = read_string(f)
            value_raw = read_kv_value(f)
            kv_pairs.append((key, value_raw))

            # Extract head_count_kv array to determine SSM vs attention layers
            if key.endswith('.attention.head_count_kv'):
                import io
                buf = io.BytesIO(value_raw)
                vtype = read_u32(buf)  # 9 = array
                if vtype == 9:
                    elem_type = read_u32(buf)
                    count = read_u64(buf)
                    for _ in range(count):
                        head_count_kv.append(read_u32(buf))

        if head_count_kv:
            ssm_layers = [i for i, v in enumerate(head_count_kv) if v == 0]
            attn_layers = [i for i, v in enumerate(head_count_kv) if v > 0]
            print(f"  SSM layers ({len(ssm_layers)}): {ssm_layers[:5]}...")
            print(f"  Attention layers ({len(attn_layers)}): {attn_layers[:5]}...")

        # Read tensor infos
        for _ in range(n_tensors):
            name = read_string(f)
            n_dims = read_u32(f)
            dims = [read_u64(f) for _ in range(n_dims)]
            dtype = read_u32(f)
            offset = read_u64(f)
            tensor_infos.append({
                'name': name,
                'n_dims': n_dims,
                'dims': dims,
                'dtype': dtype,
                'offset': offset,
            })

        # Remember where tensor data starts (after alignment)
        header_end = f.tell()
        # GGUF aligns tensor data to 32 bytes from start of file
        # The alignment boundary is typically right after the header
        # Find actual data start by looking at first tensor offset
        if tensor_infos:
            # Tensor offsets are relative to the start of tensor data section
            # The data section starts at the first aligned position after header
            alignment = 32
            data_start = ((header_end + alignment - 1) // alignment) * alignment
        else:
            data_start = header_end

        # Read ALL tensor data (from data_start to end of file)
        f.seek(data_start)
        tensor_data = f.read()

    # Phase 2: Rename tensors
    ssm_layer_set = set(i for i, v in enumerate(head_count_kv) if v == 0) if head_count_kv else set()
    renamed_count = 0
    for info in tensor_infos:
        # Determine which layer this tensor belongs to
        m = re.match(r'blk\.(\d+)\.', info['name'])
        layer_idx = int(m.group(1)) if m else -1
        is_ssm = layer_idx in ssm_layer_set

        new_name, was_renamed = rename_tensor(info['name'], is_ssm_layer=is_ssm)
        if was_renamed:
            print(f"  Rename: {info['name']} -> {new_name}")
            info['name'] = new_name
            renamed_count += 1

    if renamed_count == 0:
        print("\nNo tensors need renaming. File is already compatible.")
        return True

    print(f"\nRenamed {renamed_count} tensors. Rebuilding file...")

    # Phase 3: Rebuild the GGUF file
    backup = filepath + '.pre-tensor-patch.bak'
    if not os.path.exists(backup):
        print(f"Creating backup: {backup}")
        shutil.copy2(filepath, backup)

    with open(filepath, 'wb') as f:
        # Header
        f.write(GGUF_MAGIC)
        write_u32(f, version)
        write_u64(f, n_tensors)
        write_u64(f, n_kv)

        # KV pairs (verbatim)
        for key, value_raw in kv_pairs:
            write_string(f, key)
            f.write(value_raw)

        # Tensor infos (with renamed names)
        for info in tensor_infos:
            write_string(f, info['name'])
            write_u32(f, info['n_dims'])
            for d in info['dims']:
                write_u64(f, d)
            write_u32(f, info['dtype'])
            write_u64(f, info['offset'])

        # Align to 32 bytes before tensor data
        pos = f.tell()
        alignment = 32
        aligned_pos = ((pos + alignment - 1) // alignment) * alignment
        padding = aligned_pos - pos
        if padding > 0:
            f.write(b'\x00' * padding)

        # Tensor data (verbatim — offsets within data section unchanged)
        f.write(tensor_data)

    new_size = os.path.getsize(filepath)
    print(f"Done! New size: {new_size:,} bytes")
    return True


def main():
    default_path = os.path.join(os.path.dirname(__file__), '..', 'models', 'qwen3.5-4b.gguf')
    filepath = sys.argv[1] if len(sys.argv) > 1 else default_path
    filepath = os.path.abspath(filepath)

    if not os.path.exists(filepath):
        print(f"File not found: {filepath}")
        sys.exit(1)

    success = patch_gguf(filepath)
    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()
