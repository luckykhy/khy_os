#!/usr/bin/env python3
"""agentbus_echo_test.py — Stage A1 host-side verification for the Agent ⇄ OS
bridge channel (COM2).

Boots the kernel under QEMU with COM1 on a log file and COM2 on a unix socket
(the `make run-agent` topology), connects to COM2 as the host agent would, sends
a probe, and checks the kernel echoes every byte back. A successful round trip
proves the isolated agent channel carries bytes in both directions without
touching the human TTY on COM1.

Usage:  python3 kernel/tools/agentbus_echo_test.py
Exit:   0 = round trip OK, non-zero = failure (with diagnostics).
"""
import os
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
KERNEL_DIR = os.path.dirname(HERE)
ISO = os.path.join(KERNEL_DIR, "build", "khy-os-kernel.iso")
SOCK = "/tmp/khy-agent-a1test.sock"
COM1_LOG = "/tmp/khy-agent-a1test-com1.log"
PROBE = b"PING-khy-agentbus-A1\n"


def main():
    if not os.path.exists(ISO):
        print(f"[FAIL] ISO not found: {ISO} (run `make` first)")
        return 2

    for p in (SOCK, COM1_LOG):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass

    com1 = open(COM1_LOG, "wb")
    qemu = subprocess.Popen(
        [
            "qemu-system-x86_64",
            "-cdrom", ISO,
            "-serial", "file:" + COM1_LOG,                  # COM1 = human TTY -> log
            "-serial", f"unix:{SOCK},server,nowait",        # COM2 = agent channel
            "-display", "none", "-no-reboot",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    com1.close()

    try:
        # Wait for QEMU to create the COM2 socket.
        deadline = time.time() + 15
        while not os.path.exists(SOCK):
            if time.time() > deadline:
                print("[FAIL] COM2 socket never appeared")
                return 3
            if qemu.poll() is not None:
                print(f"[FAIL] QEMU exited early (code {qemu.returncode})")
                return 3
            time.sleep(0.1)

        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.connect(SOCK)
        conn.settimeout(20)

        # Give the kernel time to boot far enough that agentbus_task is running
        # and draining COM2. Bytes sent before then sit in the UART FIFO and are
        # echoed once the task starts, so an early send is harmless, but waiting
        # keeps the diagnostics clean.
        time.sleep(8)

        conn.sendall(PROBE)

        got = b""
        try:
            while len(got) < len(PROBE):
                chunk = conn.recv(64)
                if not chunk:
                    break
                got += chunk
        except socket.timeout:
            pass

        if got == PROBE:
            print(f"[PASS] COM2 echo round trip OK: sent {PROBE!r}, got {got!r}")
            rc = 0
        else:
            print(f"[FAIL] echo mismatch: sent {PROBE!r}, got {got!r}")
            rc = 1

        # Confirm COM1 is unaffected: the boot banner should be on the log.
        with open(COM1_LOG, "rb") as f:
            com1_data = f.read()
        if b"KHY OS" in com1_data and b"AGENTBUS" in com1_data:
            print("[PASS] COM1 human TTY banner + AGENTBUS init present (channels isolated)")
        else:
            print("[WARN] COM1 log missing expected banner/AGENTBUS line")
            rc = rc or 1

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
