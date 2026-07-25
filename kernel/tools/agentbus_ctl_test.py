#!/usr/bin/env python3
"""agentbus_ctl_test.py — host-side verification for the Agent ⇄ OS control plane
(stages A3–A4) over COM2.

The kernel runs each REQUEST against its in-kernel VFS / process model and replies
with real data. This driver mirrors the wire codec (agentframe.c) and the
control-plane payload layouts (agentctl.c / agentctl.h), then exercises:

  A3 read-only
   1. STAT  /etc/motd        -> OK, type=FILE, size>0
   2. READ  /etc/motd        -> OK, nread==size, content starts with the banner
   3. LIST  /                -> OK, contains the six known top-level directories
   4. LIST  /bin (paged)     -> OK, >16 entries total (proves paging), has init.elf
   5. STAT  /no/such/path    -> ENOENT
   6. READ  /bin (a dir)     -> EINVAL
  A4 mutate + process
   7. WRITE+READ /tmp/agent.txt          -> round-trips
   8. WRITE append                       -> file grows, content concatenated
   9. MKDIR /tmp/agentdir, re-MKDIR      -> OK then EEXIST
  10. REMOVE file (STAT->ENOENT) + dir   -> OK
  11. protected-path guard on /bin       -> EPERM (incl. a /bin/../bin/ escape)
  12. PS                                 -> lists processes incl. agent-bridge

A pass proves the agent can observe AND safely mutate the live system through
validated frames, with correct status, paging and guard semantics.

Usage:  python3 kernel/tools/agentbus_ctl_test.py
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
SOCK = "/tmp/khy-agent-a3test.sock"
COM1_LOG = "/tmp/khy-agent-a3test-com1.log"

# Frame types
TYPE_REQUEST = 0x01
TYPE_RESPONSE = 0x02

# Control-plane verbs (frame `code`)
CODE_STAT = 0x0001
CODE_LIST = 0x0002
CODE_READ = 0x0003
CODE_WRITE = 0x0004
CODE_MKDIR = 0x0005
CODE_REMOVE = 0x0006
CODE_PS = 0x0007

# Response status (first payload byte)
ST_OK = 0x00
ST_ENOENT = 0x01
ST_EINVAL = 0x02
ST_EEXIST = 0x03
ST_EPERM = 0x04

# vfs node types
NODE_FILE = 1
NODE_DIR = 2

# write modes
WRITE_OVERWRITE = 0
WRITE_APPEND = 1

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


# ── Request/response helpers (parity with agentctl.c) ────────────────────────

_seq = [0]


def request(conn, code: int, payload: bytes):
    """Send a control-plane REQUEST and return (status, body) of the RESPONSE."""
    _seq[0] += 1
    seq = _seq[0]
    conn.sendall(encode_frame(TYPE_REQUEST, seq, code, payload))
    wire = read_one_frame(conn)
    if wire is None:
        raise AssertionError(f"no response to code={code}")
    ftype, rseq, rcode, body = decode_frame(wire)
    assert ftype == TYPE_RESPONSE, f"type={ftype}"
    assert rseq == seq, f"seq {rseq} != {seq}"
    assert rcode == code, f"code {rcode} != {code}"
    assert len(body) >= 1, "empty response payload"
    return body[0], body[1:]


def parse_stat(body: bytes) -> dict:
    ftype, mode = body[0], struct.unpack("<H", body[1:3])[0]
    uid, gid = struct.unpack("<I", body[3:7])[0], struct.unpack("<I", body[7:11])[0]
    size, mtime, atime, ctime = struct.unpack("<QQQQ", body[11:43])
    return dict(type=ftype, mode=mode, uid=uid, gid=gid, size=size,
                mtime=mtime, atime=atime, ctime=ctime)


def parse_list_page(body: bytes):
    count = struct.unpack("<H", body[:2])[0]
    entries, off = [], 2
    for _ in range(count):
        etype = body[off]; off += 1
        esize = struct.unpack("<Q", body[off:off + 8])[0]; off += 8
        namelen = body[off]; off += 1
        name = body[off:off + namelen].decode("ascii", "replace"); off += namelen
        entries.append((name, etype, esize))
    return entries


def list_all(conn, path: bytes):
    """Page LIST until a page returns 0 entries; return the full entry list."""
    out, start = [], 0
    while True:
        status, body = request(conn, CODE_LIST, struct.pack("<I", start) + path)
        assert status == ST_OK, f"LIST status={status}"
        page = parse_list_page(body)
        if not page:
            break
        out.extend(page)
        start += len(page)
        if len(page) < 16:   # short page = last page
            break
    return out


def read_all(conn, path: bytes, maxbytes=1 << 20) -> bytes:
    out, offset = bytearray(), 0
    while len(out) < maxbytes:
        hdr = struct.pack("<QI", offset, 4096)
        status, body = request(conn, CODE_READ, hdr + path)
        assert status == ST_OK, f"READ status={status}"
        nread = struct.unpack("<I", body[:4])[0]
        if nread == 0:
            break
        out += body[4:4 + nread]
        offset += nread
    return bytes(out)


def write_file(conn, path: bytes, data: bytes, mode=WRITE_OVERWRITE):
    """WRITE request: [mode:1][pathlen:2][path][data]. Returns (status, written)."""
    payload = struct.pack("<BH", mode, len(path)) + path + data
    status, body = request(conn, CODE_WRITE, payload)
    written = struct.unpack("<I", body[:4])[0] if status == ST_OK else 0
    return status, written


def parse_ps_page(body: bytes):
    count = struct.unpack("<H", body[:2])[0]
    procs, off = [], 2
    for _ in range(count):
        pid = struct.unpack("<I", body[off:off + 4])[0]; off += 4
        tid = struct.unpack("<I", body[off:off + 4])[0]; off += 4
        state = body[off]; off += 1
        is_user = body[off]; off += 1
        namelen = body[off]; off += 1
        name = body[off:off + namelen].decode("ascii", "replace"); off += namelen
        procs.append(dict(pid=pid, tid=tid, state=state, is_user=is_user, name=name))
    return procs


def ps_all(conn):
    out, start = [], 0
    while True:
        status, body = request(conn, CODE_PS, struct.pack("<I", start))
        assert status == ST_OK, f"PS status={status}"
        page = parse_ps_page(body)
        if not page:
            break
        out.extend(page)
        start += len(page)
        if len(page) < 16:
            break
    return out


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

        # Check 1: STAT /etc/motd -> OK, regular file, non-empty.
        status, body = request(conn, CODE_STAT, b"/etc/motd")
        if status == ST_OK:
            st = parse_stat(body)
            if st["type"] == NODE_FILE and st["size"] > 0:
                print(f"[PASS] STAT /etc/motd: type=FILE size={st['size']} "
                      f"mode={st['mode']:o}")
            else:
                print(f"[FAIL] STAT /etc/motd unexpected: {st}")
                rc = 1
        else:
            print(f"[FAIL] STAT /etc/motd status={status}")
            rc = 1
            st = None

        # Check 2: READ /etc/motd -> full content matches its stat size + banner.
        data = read_all(conn, b"/etc/motd")
        if data.startswith(b"KHY OS ramfs online") and (st is None or len(data) == st["size"]):
            print(f"[PASS] READ /etc/motd: {len(data)} bytes, banner matches")
        else:
            print(f"[FAIL] READ /etc/motd: {len(data)} bytes, head={data[:24]!r}")
            rc = 1

        # Check 3: LIST / -> the six known top-level directories, all type DIR.
        root = list_all(conn, b"/")
        names = {n: t for (n, t, _s) in root}
        expect = {"bin", "etc", "proc", "tmp", "var", "net"}
        if expect <= set(names) and all(names[d] == NODE_DIR for d in expect):
            print(f"[PASS] LIST /: {sorted(names)} (all dirs present)")
        else:
            print(f"[FAIL] LIST /: got {names}")
            rc = 1

        # Check 4: LIST /bin paged -> >16 entries (proves paging) incl. init.elf.
        binents = list_all(conn, b"/bin")
        binnames = {n for (n, _t, _s) in binents}
        if len(binents) > 16 and "init.elf" in binnames:
            print(f"[PASS] LIST /bin: {len(binents)} entries across pages, "
                  f"init.elf present")
        else:
            print(f"[FAIL] LIST /bin: {len(binents)} entries, init.elf="
                  f"{'init.elf' in binnames}")
            rc = 1

        # Check 5: STAT a nonexistent path -> ENOENT.
        status, _ = request(conn, CODE_STAT, b"/no/such/path")
        if status == ST_ENOENT:
            print("[PASS] STAT /no/such/path -> ENOENT")
        else:
            print(f"[FAIL] STAT missing path status={status} (want ENOENT)")
            rc = 1

        # Check 6: READ on a directory -> EINVAL.
        status, _ = request(conn, CODE_READ, struct.pack("<QI", 0, 4096) + b"/bin")
        if status == ST_EINVAL:
            print("[PASS] READ /bin (dir) -> EINVAL")
        else:
            print(f"[FAIL] READ on dir status={status} (want EINVAL)")
            rc = 1

        # Check 7: WRITE then READ round-trips (the agent can author a file).
        body1 = b"agent-authored line one\n"
        status, written = write_file(conn, b"/tmp/agent.txt", body1)
        back = read_all(conn, b"/tmp/agent.txt") if status == ST_OK else b""
        if status == ST_OK and written == len(body1) and back == body1:
            print(f"[PASS] WRITE /tmp/agent.txt: {written} bytes, read-back matches")
        else:
            print(f"[FAIL] WRITE/READ round-trip: status={status} "
                  f"written={written} back={back!r}")
            rc = 1

        # Check 8: WRITE append extends the same file.
        body2 = b"agent-authored line two\n"
        status, _ = write_file(conn, b"/tmp/agent.txt", body2, mode=WRITE_APPEND)
        back = read_all(conn, b"/tmp/agent.txt") if status == ST_OK else b""
        if status == ST_OK and back == body1 + body2:
            print(f"[PASS] WRITE append: file is now {len(back)} bytes")
        else:
            print(f"[FAIL] WRITE append: status={status} back={back!r}")
            rc = 1

        # Check 9: MKDIR creates a dir; a second MKDIR reports EEXIST.
        s1, _ = request(conn, CODE_MKDIR, b"/tmp/agentdir")
        isdir = False
        if s1 == ST_OK:
            tmpents = {n: t for (n, t, _s) in list_all(conn, b"/tmp")}
            isdir = tmpents.get("agentdir") == NODE_DIR
        s2, _ = request(conn, CODE_MKDIR, b"/tmp/agentdir")
        if s1 == ST_OK and isdir and s2 == ST_EEXIST:
            print("[PASS] MKDIR /tmp/agentdir: created (DIR), re-create -> EEXIST")
        else:
            print(f"[FAIL] MKDIR: first={s1} isdir={isdir} second={s2}")
            rc = 1

        # Check 10: REMOVE the file, then STAT it -> ENOENT.
        s1, _ = request(conn, CODE_REMOVE, b"/tmp/agent.txt")
        s2, _ = request(conn, CODE_STAT, b"/tmp/agent.txt")
        s3, _ = request(conn, CODE_REMOVE, b"/tmp/agentdir")  # empty dir
        if s1 == ST_OK and s2 == ST_ENOENT and s3 == ST_OK:
            print("[PASS] REMOVE file -> gone (STAT ENOENT); REMOVE empty dir -> OK")
        else:
            print(f"[FAIL] REMOVE: file={s1} stat={s2} dir={s3}")
            rc = 1

        # Check 11: the protected-path guard blocks mutations under /bin.
        gw, _ = write_file(conn, b"/bin/evil.elf", b"x")
        gm, _ = request(conn, CODE_MKDIR, b"/bin/evil")
        gr, _ = request(conn, CODE_REMOVE, b"/bin/init.elf")
        # ...and a /bin/../bin/ escape is canonicalized and still blocked.
        ge, _ = write_file(conn, b"/bin/../bin/escape", b"x")
        still = request(conn, CODE_STAT, b"/bin/init.elf")[0]
        if (gw == ST_EPERM and gm == ST_EPERM and gr == ST_EPERM and
                ge == ST_EPERM and still == ST_OK):
            print("[PASS] protected-path guard: /bin write/mkdir/remove/escape -> EPERM")
        else:
            print(f"[FAIL] guard: w={gw} m={gm} r={gr} escape={ge} init.elf={still}")
            rc = 1

        # Check 12: PS lists live processes incl. the agent bridge kernel task.
        procs = ps_all(conn)
        names = {p["name"] for p in procs}
        if len(procs) > 0 and "agent-bridge" in names:
            print(f"[PASS] PS: {len(procs)} processes, names include agent-bridge "
                  f"({sorted(names)})")
        else:
            print(f"[FAIL] PS: {len(procs)} procs, names={sorted(names)}")
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
