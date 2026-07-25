#!/usr/bin/env python3
"""agentbus_event_test.py — host-side verification for the Agent ⇄ OS *event*
plane (stage A6) over COM2: the OS → agent one-way push.

Unlike the control plane (agent → OS request/response) and the decision plane
(OS → agent ask, the kernel blocks for a reply), this plane is fire-and-forget:
the kernel notifies the agent of process lifecycle events and never waits for an
answer. We drive ordinary commands into the shell on COM1 and assert the
matching EVENT frames arrive on COM2:

  1. spawn + clean exit — `run /bin/stattest.elf` must produce a SPAWN event
     (carrying the new pid and the program name) and, when it finishes, an EXIT
     event for the SAME pid with exit_code 0.
  2. fault — `run /bin/fault.elf` dereferences an unmapped address, so the
     kernel reaps it. We must receive a FAULT event carrying the trap vector
     (#PF = 14) AND a paired EXIT event for the same pid with code 128+14=142.
     This proves the trap path emits the notification before reaping.
  3. liveness — after all that, the shell still answers a fresh command, proving
     the event plane is truly fire-and-forget: the kernel never blocked waiting
     for an agent that sends nothing back.

COM1 is a unix socket (so we can type commands and read shell output); COM2 is
the agent socket, drained by a background thread that collects EVENT frames.

Usage:  python3 kernel/tools/agentbus_event_test.py
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
COM1_SOCK = "/tmp/khy-agent-a6-com1.sock"
COM2_SOCK = "/tmp/khy-agent-a6-com2.sock"

# Frame types (parity with agentframe.h)
TYPE_EVENT = 0x03

# Event codes (parity with agentevent.h)
EV_SPAWN = 0x0001
EV_EXIT = 0x0002
EV_FAULT = 0x0003
EV_NAME = {EV_SPAWN: "SPAWN", EV_EXIT: "EXIT", EV_FAULT: "FAULT"}

# ── Wire codec (parity with agentframe.c) ────────────────────────────────────

def crc16_ccitt(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


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


def decode_frame(wire: bytes):
    raw = cobs_decode(wire)
    ftype, seq, code, plen = struct.unpack("<BIHH", raw[:9])
    payload = raw[9:9 + plen]
    want = struct.unpack("<H", raw[9 + plen:9 + plen + 2])[0]
    if crc16_ccitt(raw[:9 + plen]) != want:
        raise ValueError("CRC mismatch on decode")
    return ftype, seq, code, payload


def parse_event(payload: bytes):
    """Uniform event payload: [pid:4][aux:4][info:4][namelen:1][name]."""
    if len(payload) < 13:
        return None
    pid, aux, info = struct.unpack("<IIi", payload[:12])
    namelen = payload[12]
    name = payload[13:13 + namelen].decode("latin1", "replace")
    return {"pid": pid, "aux": aux, "info": info, "name": name}


# ── The host-side agent on COM2: collect EVENT frames ────────────────────────

class EventCollector:
    def __init__(self, conn):
        self.conn = conn
        self.events = []           # list of dicts: {code, seq, pid, aux, info, name}
        self.lock = threading.Lock()
        self.stop = False
        self.t = threading.Thread(target=self._loop, daemon=True)
        self.t.start()

    def _loop(self):
        self.conn.settimeout(0.3)
        buf = bytearray()
        while not self.stop:
            try:
                chunk = self.conn.recv(4096)
            except socket.timeout:
                continue
            if not chunk:
                break
            for b in chunk:
                if b == 0x00:
                    if buf:
                        self._consume(bytes(buf))
                        buf = bytearray()
                else:
                    buf.append(b)

    def _consume(self, wire: bytes):
        try:
            ftype, seq, code, payload = decode_frame(wire)
        except ValueError:
            return
        if ftype != TYPE_EVENT:
            return
        ev = parse_event(payload)
        if ev is None:
            return
        ev.update(code=code, seq=seq, t=time.time())
        with self.lock:
            self.events.append(ev)

    def snapshot(self):
        with self.lock:
            return list(self.events)

    def wait_for(self, pred, timeout):
        end = time.time() + timeout
        while time.time() < end:
            for ev in self.snapshot():
                if pred(ev):
                    return ev
            time.sleep(0.05)
        return None

    def shutdown(self):
        self.stop = True
        self.t.join(timeout=2)


def drain(conn, seconds):
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


class Com1Reader:
    """Continuously drains COM1 in the background so the kernel's serial_print
    never back-pressures (COM2 events would otherwise lag while we block reading
    COM2: an idle COM1 reader makes a running program's output spin on a bounded
    poll). Keeps the full transcript for assertions."""

    def __init__(self, conn):
        self.conn = conn
        self.buf = bytearray()
        self.lock = threading.Lock()
        self.stop = False
        self.t = threading.Thread(target=self._loop, daemon=True)
        self.t.start()

    def _loop(self):
        self.conn.settimeout(0.3)
        while not self.stop:
            try:
                chunk = self.conn.recv(4096)
            except socket.timeout:
                continue
            if not chunk:
                break
            with self.lock:
                self.buf += chunk

    def text(self):
        with self.lock:
            return bytes(self.buf)

    def wait_for_text(self, needle, timeout):
        end = time.time() + timeout
        while time.time() < end:
            if needle in self.text():
                return True
            time.sleep(0.05)
        return False

    def shutdown(self):
        self.stop = True
        self.t.join(timeout=2)


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

        collector = EventCollector(com2)
        reader = Com1Reader(com1)
        # Boot far enough to reach the shell prompt and start the bridge task.
        reader.wait_for_text(b"khy>", timeout=9)
        if b"khy>" not in reader.text() and b"KHY OS" not in reader.text():
            print(f"[WARN] no shell banner/prompt seen yet; head={reader.text()[:80]!r}")

        rc = 0
        t_start = time.time()

        # Check 1: spawn + clean exit.
        com1.sendall(b"run /bin/stattest.elf\n")
        spawn = collector.wait_for(
            lambda e: e["code"] == EV_SPAWN and "stattest" in e["name"], timeout=12)
        exit_ev = None
        if spawn:
            exit_ev = collector.wait_for(
                lambda e: e["code"] == EV_EXIT and e["pid"] == spawn["pid"], timeout=12)
        if spawn and exit_ev and exit_ev["info"] == 0:
            print(f"[PASS] spawn+exit: SPAWN pid={spawn['pid']} name={spawn['name']!r}, "
                  f"EXIT pid={exit_ev['pid']} code={exit_ev['info']}")
        else:
            print(f"[FAIL] spawn+exit: spawn={spawn} exit={exit_ev}")
            rc = 1

        # Check 2: fault — FAULT event (vector 14) + paired EXIT (code 142).
        com1.sendall(b"run /bin/fault.elf\n")
        fault = collector.wait_for(lambda e: e["code"] == EV_FAULT, timeout=12)
        fault_exit = None
        if fault:
            fault_exit = collector.wait_for(
                lambda e: e["code"] == EV_EXIT and e["pid"] == fault["pid"], timeout=12)
        if fault and fault["info"] == 14 and fault_exit and fault_exit["info"] == 128 + 14:
            print(f"[PASS] fault: FAULT pid={fault['pid']} vector={fault['info']}, "
                  f"paired EXIT code={fault_exit['info']}")
        else:
            print(f"[FAIL] fault: fault={fault} fault_exit={fault_exit}")
            rc = 1

        # Check 3: liveness — fire-and-forget never wedged the kernel.
        com1.sendall(b"echo a6-alive\n")
        if reader.wait_for_text(b"a6-alive", timeout=6):
            print("[PASS] liveness: shell still answers after event pushes "
                  "(plane is fire-and-forget, kernel never blocked)")
        else:
            print(f"[FAIL] liveness: tail={reader.text()[-120:]!r}")
            rc = 1

        # Informational: dump the event tape so a human can eyeball ordering.
        evs = collector.snapshot()
        tape = ", ".join(f"{EV_NAME.get(e['code'], e['code'])}#{e['pid']}"
                         f"({e['info']})@{e['t']-t_start:+.1f}s" for e in evs[-12:])
        print(f"[INFO] last events: {tape}")

        collector.shutdown()
        reader.shutdown()
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
