#!/usr/bin/env python3
"""agentbus_ask_test.py — host-side verification for the Agent ⇄ OS *decision*
plane (stage A5) over COM2: the OS → agent direction.

Unlike the control-plane test (agent → OS), here the KERNEL initiates. We type
`agentask <question>` into the shell on COM1; the kernel blocks the shell task
and emits a DECISION_REQ frame on COM2. This driver plays the agent on COM2:

  1. answered case  — the kernel sends DECISION_REQ carrying the question; we
     reply DECISION_RESP "ALLOW" with the same seq; the shell unblocks and prints
     "[agentask] decision: ALLOW".
  2. frame shape    — the DECISION_REQ we received has type=DECISION_REQ and a
     payload equal to the typed question (proves the OS → agent payload path).
  3. timeout case   — we deliberately do NOT answer the next DECISION_REQ; the
     kernel's deadline fires (~3s default), the shell unblocks with the default
     and prints "no agent decision (timeout)". This proves a silent/absent agent
     can never wedge the kernel — the core loose-coupling requirement.

COM1 is a unix socket here (not a one-way log) so we can both type commands and
read the shell's output. COM2 is the agent socket.

Usage:  python3 kernel/tools/agentbus_ask_test.py
Exit:   0 = all checks pass, non-zero = failure.
"""
import os
import socket
import struct
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
KERNEL_DIR = os.path.dirname(HERE)
ISO = os.path.join(KERNEL_DIR, "build", "khy-os-kernel.iso")
COM1_SOCK = "/tmp/khy-agent-a5-com1.sock"
COM2_SOCK = "/tmp/khy-agent-a5-com2.sock"

# Frame types (parity with agentframe.h)
TYPE_DECISION_REQ = 0x04
TYPE_DECISION_RESP = 0x05

# ── Wire codec (parity with agentframe.c) ────────────────────────────────────

def crc16_ccitt(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def cobs_encode(data: bytes) -> bytes:
    out = bytearray()
    code_idx = 0
    out.append(0)
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
    i, n = 0, len(data)
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


def decode_frame(wire: bytes):
    raw = cobs_decode(wire)
    ftype, seq, code, plen = struct.unpack("<BIHH", raw[:9])
    payload = raw[9:9 + plen]
    want = struct.unpack("<H", raw[9 + plen:9 + plen + 2])[0]
    if crc16_ccitt(raw[:9 + plen]) != want:
        raise ValueError("CRC mismatch on decode")
    return ftype, seq, code, payload


def read_one_frame(conn, timeout=8):
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
                continue
            buf.append(chunk[0])
    except socket.timeout:
        return None


# ── The host-side agent on COM2 ──────────────────────────────────────────────

class AgentSim:
    """Reads DECISION_REQ frames on COM2 and optionally answers them. When
    `answer` is set it replies DECISION_RESP with `decision` echoing the request
    seq; when cleared it stays silent so the kernel's timeout must fire."""

    def __init__(self, conn):
        self.conn = conn
        self.answer = True
        self.decision = b"ALLOW"
        self.seen = []          # (type, code, payload) of every request observed
        self.stop = False
        self.t = threading.Thread(target=self._loop, daemon=True)
        self.t.start()

    def _loop(self):
        while not self.stop:
            wire = read_one_frame(self.conn, timeout=1)
            if wire is None:
                continue
            try:
                ftype, seq, code, payload = decode_frame(wire)
            except ValueError:
                continue
            if ftype == TYPE_DECISION_REQ:
                self.seen.append((ftype, code, payload))
                if self.answer:
                    self.conn.sendall(
                        encode_frame(TYPE_DECISION_RESP, seq, code, self.decision))

    def shutdown(self):
        self.stop = True
        self.t.join(timeout=2)


def drain(conn, seconds):
    """Accumulate whatever the shell prints on COM1 for `seconds`."""
    conn.settimeout(0.3)
    end = time.time() + seconds
    out = bytearray()
    while time.time() < end:
        try:
            chunk = conn.recv(4096)
            if not chunk:
                break
            out += chunk
        except socket.timeout:
            pass
    return bytes(out)


def drain_until(conn, needle, max_seconds):
    """Accumulate COM1 output until `needle` appears or the deadline passes.
    Returns (output, elapsed) — elapsed is time until the needle was seen (or
    the full window if it never appeared), so it measures real recovery time."""
    conn.settimeout(0.2)
    start = time.time()
    end = start + max_seconds
    out = bytearray()
    while time.time() < end:
        try:
            chunk = conn.recv(4096)
            if chunk:
                out += chunk
                if needle in out:
                    return bytes(out), time.time() - start
        except socket.timeout:
            pass
    return bytes(out), time.time() - start


# ── Test driver ──────────────────────────────────────────────────────────────

def main():
    if not os.path.exists(ISO):
        print(f"[FAIL] ISO not found: {ISO} (run `make` first)")
        return 2
    for p in (COM1_SOCK, COM2_SOCK):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass

    qemu = subprocess.Popen(
        [
            "qemu-system-x86_64", "-cdrom", ISO,
            "-serial", f"unix:{COM1_SOCK},server,nowait",
            "-serial", f"unix:{COM2_SOCK},server,nowait",
            "-display", "none", "-no-reboot",
        ],
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
    )

    try:
        deadline = time.time() + 15
        while not (os.path.exists(COM1_SOCK) and os.path.exists(COM2_SOCK)):
            if time.time() > deadline or qemu.poll() is not None:
                print("[FAIL] serial sockets never appeared / QEMU exited")
                return 3
            time.sleep(0.1)

        com1 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        com1.connect(COM1_SOCK)
        com2 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        com2.connect(COM2_SOCK)

        agent = AgentSim(com2)
        # Let the kernel boot far enough to start the shell and the bridge task.
        boot = drain(com1, 9)
        if b"khy>" not in boot and b"KHY OS" not in boot:
            print(f"[WARN] no shell banner/prompt seen yet; head={boot[:80]!r}")

        rc = 0

        # Check 1+2: agent answers — DECISION_REQ carries the question, shell
        # prints the decision.
        question = b"may I proceed?"
        agent.answer = True
        agent.decision = b"ALLOW"
        before = len(agent.seen)
        com1.sendall(b"agentask " + question + b"\n")
        out = drain(com1, 4)
        got_req = agent.seen[before:] if len(agent.seen) > before else []
        req_ok = bool(got_req) and got_req[0][0] == TYPE_DECISION_REQ and \
            got_req[0][2] == question
        if b"decision: ALLOW" in out and req_ok:
            print(f"[PASS] answered ask: DECISION_REQ payload={question!r}, "
                  f"shell printed 'decision: ALLOW'")
        else:
            print(f"[FAIL] answered ask: req_ok={req_ok} seen={got_req} "
                  f"out_tail={out[-120:]!r}")
            rc = 1

        # Check 3: agent goes silent — the kernel's deadline must fire and the
        # shell must recover with the default (never hangs).
        agent.answer = False
        before = len(agent.seen)
        t0 = time.time()
        com1.sendall(b"agentask should I shut down now?\n")
        out, elapsed = drain_until(com1, b"timeout", max_seconds=8)
        saw_req = len(agent.seen) > before
        # Default deadline is ~3s; assert it fired in a sane window and actually
        # waited (so it timed out, not errored instantly).
        if b"timeout" in out and saw_req and 1.0 < elapsed < 5.0:
            print(f"[PASS] silent agent: DECISION_REQ sent, shell timed out and "
                  f"recovered in {elapsed:.1f}s (kernel never wedged)")
        else:
            print(f"[FAIL] timeout case: saw_req={saw_req} elapsed={elapsed:.1f}s "
                  f"out_tail={out[-120:]!r}")
            rc = 1

        # Check 4: after a timeout the shell is still alive and answers again —
        # proves the wait-slot was freed and the kernel kept running.
        agent.answer = True
        agent.decision = b"DENY"
        com1.sendall(b"agentask try once more?\n")
        out = drain(com1, 4)
        if b"decision: DENY" in out:
            print("[PASS] post-timeout recovery: a fresh ask answers 'DENY'")
        else:
            print(f"[FAIL] post-timeout recovery: out_tail={out[-120:]!r}")
            rc = 1

        agent.shutdown()
        com1.close()
        com2.close()
        return rc
    finally:
        qemu.terminate()
        try:
            qemu.wait(timeout=5)
        except subprocess.TimeoutExpired:
            qemu.kill()
        for p in (COM1_SOCK, COM2_SOCK):
            try:
                os.remove(p)
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    sys.exit(main())
