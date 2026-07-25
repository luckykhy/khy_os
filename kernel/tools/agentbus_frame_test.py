#!/usr/bin/env python3
"""agentbus_frame_test.py — Stage A2 host-side verification for the Agent ⇄ OS
bridge frame layer (COBS + CRC16 over COM2).

Mirrors the kernel codec in agentframe.c, then drives a round trip:
  1. Send a REQUEST frame; expect a RESPONSE with the same seq/code/payload
     (stage A2 dispatch is a frame-level echo).
  2. Send a frame with a corrupted CRC; expect NO reply (the kernel drops it).
  3. Send garbage bytes + a delimiter, then a good frame; expect the good frame
     to still round-trip (the RX accumulator resynchronizes on 0x00).

A pass proves COBS framing, CRC validation, frame decode/encode and delimiter
resync all work end to end on the isolated channel.

Usage:  python3 kernel/tools/agentbus_frame_test.py
Exit:   0 = all checks pass, non-zero = failure.
"""
import os
import socket
import struct
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
KERNEL_DIR = os.path.dirname(HERE)
ISO = os.path.join(KERNEL_DIR, "build", "khy-os-kernel.iso")
SOCK = "/tmp/khy-agent-a2test.sock"
COM1_LOG = "/tmp/khy-agent-a2test-com1.log"

TYPE_REQUEST = 0x01
TYPE_RESPONSE = 0x02

# ── Codec (parity with agentframe.c) ─────────────────────────────────────────

def crc16_ccitt(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


def cobs_encode(data: bytes) -> bytes:
    out = bytearray()
    code_idx = 0
    out.append(0)          # placeholder for the first code byte
    code = 1
    for byte in data:
        if byte == 0:
            out[code_idx] = code
            code = 1
            code_idx = len(out)
            out.append(0)
        else:
            out.append(byte)
            code += 1
            if code == 0xFF:
                out[code_idx] = code
                code = 1
                code_idx = len(out)
                out.append(0)
    out[code_idx] = code
    return bytes(out)


def cobs_decode(data: bytes) -> bytes:
    out = bytearray()
    i = 0
    n = len(data)
    while i < n:
        code = data[i]
        if code == 0:
            raise ValueError("zero code byte in COBS data")
        i += 1
        for _ in range(code - 1):
            out.append(data[i])
            i += 1
        if code < 0xFF and i < n:
            out.append(0)
    return bytes(out)


def encode_frame(ftype: int, seq: int, code: int, payload: bytes) -> bytes:
    raw = struct.pack("<BIHH", ftype, seq, code, len(payload)) + payload
    raw += struct.pack("<H", crc16_ccitt(raw))
    return cobs_encode(raw) + b"\x00"


def encode_frame_bad_crc(ftype: int, seq: int, code: int, payload: bytes) -> bytes:
    raw = struct.pack("<BIHH", ftype, seq, code, len(payload)) + payload
    raw += struct.pack("<H", (crc16_ccitt(raw) ^ 0xABCD) & 0xFFFF)  # corrupt
    return cobs_encode(raw) + b"\x00"


def decode_frame(wire: bytes):
    """wire excludes the trailing 0x00. Returns (type, seq, code, payload)."""
    raw = cobs_decode(wire)
    ftype, seq, code, plen = struct.unpack("<BIHH", raw[:9])
    payload = raw[9:9 + plen]
    want = struct.unpack("<H", raw[9 + plen:9 + plen + 2])[0]
    if crc16_ccitt(raw[:9 + plen]) != want:
        raise ValueError("CRC mismatch on decode")
    return ftype, seq, code, payload


def read_one_frame(conn, timeout=8):
    """Read bytes until a 0x00 delimiter; return the frame wire bytes (no 0x00),
    or None on timeout/EOF."""
    conn.settimeout(timeout)
    buf = bytearray()
    try:
        while True:
            chunk = conn.recv(1)
            if not chunk:
                return None
            if chunk[0] == 0x00:
                if buf:
                    return bytes(buf)
                continue  # skip leading delimiters
            buf.append(chunk[0])
    except socket.timeout:
        return None


# ── Test driver ──────────────────────────────────────────────────────────────

def main():
    if not os.path.exists(ISO):
        print(f"[FAIL] ISO not found: {ISO} (run `make` first)")
        return 2
    for p in (SOCK, COM1_LOG):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass

    qemu = subprocess.Popen(
        [
            "qemu-system-x86_64", "-cdrom", ISO,
            "-serial", "file:" + COM1_LOG,
            "-serial", f"unix:{SOCK},server,nowait",
            "-display", "none", "-no-reboot",
        ],
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
    )

    try:
        deadline = time.time() + 15
        while not os.path.exists(SOCK):
            if time.time() > deadline or qemu.poll() is not None:
                print("[FAIL] COM2 socket never appeared / QEMU exited")
                return 3
            time.sleep(0.1)

        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.connect(SOCK)
        time.sleep(8)  # let the kernel boot far enough to run agentbus_task

        rc = 0

        # Check 1: a good REQUEST round-trips as a RESPONSE echo.
        payload = b"hello-frame-A2"
        conn.sendall(encode_frame(TYPE_REQUEST, 42, 0x0001, payload))
        wire = read_one_frame(conn)
        if wire is None:
            print("[FAIL] no response to good frame")
            return 1
        try:
            ftype, seq, code, got = decode_frame(wire)
        except ValueError as e:
            print(f"[FAIL] response failed to decode: {e}")
            return 1
        if ftype == TYPE_RESPONSE and seq == 42 and code == 0x0001 and got == payload:
            print(f"[PASS] frame echo: RESPONSE seq=42 code=1 payload={got!r}")
        else:
            print(f"[FAIL] frame echo mismatch: type={ftype} seq={seq} "
                  f"code={code} payload={got!r}")
            rc = 1

        # Check 2: a bad-CRC frame is dropped (no reply).
        conn.sendall(encode_frame_bad_crc(TYPE_REQUEST, 99, 0x0001, b"corrupt"))
        wire = read_one_frame(conn, timeout=4)
        if wire is None:
            print("[PASS] bad-CRC frame dropped (no reply)")
        else:
            ftype, seq, code, got = decode_frame(wire)
            print(f"[FAIL] bad-CRC frame got a reply: seq={seq}")
            rc = 1

        # Check 3: garbage then a good frame — RX resynchronizes on the delimiter.
        conn.sendall(b"\x11\x22\x33\x00")  # noise + delimiter
        conn.sendall(encode_frame(TYPE_REQUEST, 7, 0x0002, b"resync"))
        wire = read_one_frame(conn)
        if wire is None:
            print("[FAIL] no response after garbage (resync failed)")
            return 1
        ftype, seq, code, got = decode_frame(wire)
        if ftype == TYPE_RESPONSE and seq == 7 and code == 0x0002 and got == b"resync":
            print("[PASS] RX resynchronized after garbage; good frame round-tripped")
        else:
            print(f"[FAIL] resync mismatch: seq={seq} payload={got!r}")
            rc = 1

        conn.close()
        return rc
    finally:
        qemu.terminate()
        try:
            qemu.wait(timeout=5)
        except subprocess.TimeoutExpired:
            qemu.kill()
        try:
            os.remove(SOCK)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    sys.exit(main())
