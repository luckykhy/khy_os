/* syscall.c — System call interface (hybrid kernel) * @pattern Command
 */

#include "syscall.h"
#include "agentask.h"
#include "console.h"
#include "ipc.h"
#include "net.h"
#include "process.h"
#include "rtc.h"
#include "sched.h"
#include "serial.h"
#include "string.h"
#include "timer.h"
#include "vfs.h"
#include "vmm.h"
#include "agentframe.h"

#define SYSCALL_MAX_WRITE_LEN 4096
#define SYSCALL_MAX_PATH      192
#define SYSCALL_MAX_FDS       32
#define SYSCALL_PIPE_MAX      16
#define SYSCALL_PIPE_CAP      4096   /* per-pipe ring-buffer capacity (bytes) */
#define SYSCALL_AGENT_QMAX    256    /* max decision-question bytes (off-stack) */

enum fd_kind {
    FD_FILE    = 0,   /* path-backed VFS file (default) */
    FD_PIPE    = 1,   /* one end of a kernel pipe (see pipe_table) */
    FD_CONSOLE = 2,   /* a standard stream (fd 0/1/2) bound to the serial console */
    FD_DIR     = 3,   /* an open directory; `offset` is the next-child cursor for
                         fgetdents. Not byte-readable/writable (Phase 25). */
};

/* The three standard streams every process starts with. */
#define FD_STDIN  0
#define FD_STDOUT 1
#define FD_STDERR 2

struct syscall_frame {
    uint64_t r15;
    uint64_t r14;
    uint64_t r13;
    uint64_t r12;
    uint64_t r11;
    uint64_t r10;
    uint64_t r9;
    uint64_t r8;
    uint64_t rbp;
    uint64_t rdi;
    uint64_t rsi;
    uint64_t rdx;
    uint64_t rcx;
    uint64_t rbx;
    uint64_t rax;
    uint64_t vector;
    uint64_t error_code;
    uint64_t rip;
    uint64_t cs;
    uint64_t rflags;
    uint64_t user_rsp;   /* pushed by CPU on the Ring 3 → Ring 0 int 0x80 */
    uint64_t ss;
};

struct fd_entry {
    int used;
    int kind;            /* enum fd_kind */
    size_t offset;       /* FD_FILE: byte offset within the file */
    int pipe_id;         /* FD_PIPE: index into pipe_table */
    int pipe_write;      /* FD_PIPE: 1 = write end, 0 = read end */
    char path[SYSCALL_MAX_PATH];
};

/* A pipe is a fixed-capacity kernel ring buffer with two ends. `readers` and
 * `writers` count the open fds referencing each end across ALL processes (the
 * fd table is kernel-global in this model). A read on an empty pipe blocks while
 * writers remain and returns EOF (0) once the last writer closes; a write on a
 * full pipe blocks while readers remain and fails (EPIPE) once they are gone. */
struct pipe_buf {
    int used;
    int readers;
    int writers;
    size_t head;         /* next byte to read */
    size_t count;        /* bytes currently buffered */
    uint8_t data[SYSCALL_PIPE_CAP];
};

static struct fd_entry fd_pool[PROCESS_MAX][SYSCALL_MAX_FDS];
static uint32_t fd_pool_owner[PROCESS_MAX]; /* pid that owns each bound row */
static int fd_pool_used[PROCESS_MAX];       /* 1 if the row is bound to a pid */
static struct pipe_buf pipe_table[SYSCALL_PIPE_MAX];
static int syscall_ready;

/* Return the fd table owned by `pid`, lazily binding a free pool row on first
 * use. Returns NULL only if every row is bound (more live processes with open
 * fds than the pool holds). */
static struct fd_entry *fdtable_for(uint32_t pid) {
    for (int i = 0; i < PROCESS_MAX; i++)
        if (fd_pool_used[i] && fd_pool_owner[i] == pid)
            return fd_pool[i];
    for (int i = 0; i < PROCESS_MAX; i++) {
        if (!fd_pool_used[i]) {
            fd_pool_used[i] = 1;
            fd_pool_owner[i] = pid;
            memset(fd_pool[i], 0, sizeof(fd_pool[i]));
            /* Every process starts with the three standard streams open on the
             * console (fork overwrites these with the parent's copies, which are
             * themselves console streams, so the invariant holds either way). */
            for (int s = FD_STDIN; s <= FD_STDERR; s++) {
                fd_pool[i][s].used = 1;
                fd_pool[i][s].kind = FD_CONSOLE;
            }
            return fd_pool[i];
        }
    }
    return NULL;
}

/* The calling process's fd table (NULL if the pool is exhausted). */
static struct fd_entry *cur_fds(void) {
    return fdtable_for(process_current_pid());
}

static void copy_cstr_limited(char *dst, const char *src, size_t max_len) {
    size_t i = 0;
    if (max_len == 0)
        return;
    if (!src) {
        dst[0] = '\0';
        return;
    }
    while (src[i] && (i + 1) < max_len) {
        dst[i] = src[i];
        i++;
    }
    dst[i] = '\0';
}

static int read_user_str(int from_user, uint64_t ptr, char *out, size_t max) {
    if (!ptr || max == 0)
        return -1;
    struct vm_space *space = NULL;
    if (from_user) {
        struct task *t = sched_current_task();
        if (!t || !t->space)
            return -1;
        space = t->space;
    }
    const char *src = (const char *)(uint64_t)ptr;
    size_t i = 0;
    for (; i + 1 < max; i++) {
        uint64_t va = ptr + i;
        /* Validate page-by-page as we scan (xv6 fetchstr style): a string that
         * ends just before an unmapped page is fine, but one that runs off into
         * unmapped or kernel memory is rejected before we touch it. */
        if (space && (i == 0 || (va & 0xFFFULL) == 0)) {
            if (vmm_check_user_range(space, va, 1, 0) != 0)
                return -1;
        }
        char c = src[i];
        out[i] = c;
        if (c == '\0')
            return 0;
    }
    out[max - 1] = '\0';
    return 0;
}

/* Read a path argument from the caller and normalize it to an absolute path.
 * A relative argument is resolved against the caller's current working directory
 * (the running process's cwd, or the shell/kernel cwd for the pid-0 context);
 * an absolute argument ignores the cwd. The normalized path is then canonicalized
 * through vfs_realpath, which dereferences symbolic links: intermediate link
 * components are always followed, while the final component is followed only when
 * `follow_final` is set — so unlink/readlink/symlink can act on the link itself
 * (follow_final = 0) whereas open/exec/stat see through it (follow_final = 1).
 * This is the single choke point through which every path-taking syscall obtains
 * its target, so relative-path and symlink support are uniform across all. */
static int read_user_path_ex(int from_user, uint64_t path_ptr,
                             char out[SYSCALL_MAX_PATH], int follow_final) {
    char raw[SYSCALL_MAX_PATH];
    if (read_user_str(from_user, path_ptr, raw, SYSCALL_MAX_PATH) != 0)
        return -1;
    char cwd[VFS_PATH_MAX];
    process_get_cwd(cwd, sizeof(cwd));
    char norm[SYSCALL_MAX_PATH];
    if (vfs_resolve(cwd, raw, norm, SYSCALL_MAX_PATH) != 0)
        return -1;
    if (vfs_realpath(norm, out, SYSCALL_MAX_PATH, follow_final) != 0)
        return -1;
    return 0;
}

/* The common case: resolve a path and follow a final symbolic link, so callers
 * operate on the link's target. Delete/inspect-the-link callers use
 * read_user_path_ex(..., 0) instead. */
static int read_user_path(int from_user, uint64_t path_ptr, char out[SYSCALL_MAX_PATH]) {
    return read_user_path_ex(from_user, path_ptr, out, 1);
}

/* Validate a user buffer [ptr, ptr+len) the kernel is about to read (or write,
 * when need_write) on the caller's behalf. Kernel (Ring 0) callers are trusted
 * as-is; Ring 3 callers are checked against their own address space's page
 * tables. Returns 1 if the access is safe, 0 if it must be refused. */
static int uok(int from_user, uint64_t ptr, uint64_t len, int need_write) {
    if (!from_user)
        return 1;
    struct task *t = sched_current_task();
    if (!t || !t->space)
        return 0;
    return vmm_check_user_range(t->space, ptr, (size_t)len, need_write) == 0;
}

/* ── Pipe ends ─────────────────────────────────────────────────── */

/* Drain bytes from a pipe's read-end fd into the (already validated) user
 * buffer. Blocks cooperatively via yield() while the pipe is empty but a writer
 * still holds the write end; returns 0 (EOF) once the last writer has closed and
 * nothing is buffered. Returns the byte count on success, -1 on a misuse (a fd
 * that is a write end). */
static uint64_t sys_pipe_read(struct fd_entry *fds, int fd, uint64_t buf_ptr, uint64_t len) {
    if (fds[fd].pipe_write)
        return (uint64_t)-1; /* reading the write end is a misuse */
    struct pipe_buf *p = &pipe_table[fds[fd].pipe_id];
    for (;;) {
        if (p->count > 0)
            break;
        if (p->writers == 0)
            return 0; /* EOF: buffer drained and no writer can refill it */
        yield();      /* wait for a writer to deposit bytes */
    }
    uint8_t *dst = (uint8_t *)(uintptr_t)buf_ptr;
    uint64_t n = 0;
    while (n < len && p->count > 0) {
        dst[n++] = p->data[p->head];
        p->head = (p->head + 1) % SYSCALL_PIPE_CAP;
        p->count--;
    }
    return n;
}

/* Deposit bytes from the (already validated) user buffer into a pipe's write-end
 * fd. Blocks cooperatively while the ring is full but a reader still holds the
 * read end; returns -1 (EPIPE) once every reader has closed. Returns the byte
 * count written, or -1 on misuse (a fd that is a read end). */
static uint64_t sys_pipe_write(struct fd_entry *fds, int fd, uint64_t buf_ptr, uint64_t len) {
    if (!fds[fd].pipe_write)
        return (uint64_t)-1; /* writing the read end is a misuse */
    struct pipe_buf *p = &pipe_table[fds[fd].pipe_id];
    const uint8_t *src = (const uint8_t *)(uintptr_t)buf_ptr;
    uint64_t n = 0;
    while (n < len) {
        if (p->readers == 0)
            return (uint64_t)-1; /* EPIPE: no one left to read */
        if (p->count == SYSCALL_PIPE_CAP) {
            yield(); /* ring full — let a reader drain it */
            continue;
        }
        size_t tail = (p->head + p->count) % SYSCALL_PIPE_CAP;
        p->data[tail] = src[n++];
        p->count++;
    }
    return n;
}

static uint64_t sys_write(int from_user, uint64_t buf_ptr, uint64_t len) {
    if (!buf_ptr)
        return (uint64_t)-1;
    if (len > SYSCALL_MAX_WRITE_LEN)
        len = SYSCALL_MAX_WRITE_LEN;
    if (!uok(from_user, buf_ptr, len, 0))
        return (uint64_t)-1;
    const char *p = (const char *)(uint64_t)buf_ptr;
    for (uint64_t i = 0; i < len; i++)
        serial_putchar(p[i]);
    return len;
}

static uint64_t sys_exit(uint64_t status) {
    uint32_t pid = process_current_pid();
    process_mark_exited(pid, (int)status);

    /* Tear down the task. task_exit() marks it a zombie and switches away for
     * good, so this never returns — the syscall's iretq back to Ring 3 is
     * intentionally abandoned and the kernel stack + address space are reclaimed
     * by the zombie reaper once another task is running. A non-user caller (e.g.
     * the idle task, task 0) is left to fall through and simply get `status`. */
    if (pid != 0)
        task_exit();
    return status;
}

static uint64_t sys_getpid(void) {
    return process_current_pid();
}

static uint64_t sys_getppid(void) {
    return process_parent_pid();
}

static uint64_t sys_sbrk(uint64_t increment) {
    /* increment is a signed delta passed in a 64-bit register. */
    return (uint64_t)process_sbrk((long)increment);
}

static uint64_t sys_kill(uint64_t pid, uint64_t sig) {
    return (uint64_t)process_kill((uint32_t)pid, (int)sig);
}

/* sigaction(signum, handler, restorer): install a Ring 3 signal handler and the
 * restorer trampoline. The addresses are user VAs and are NOT dereferenced here
 * — a bogus one merely faults the program in Ring 3 (isolated) when delivery
 * jumps to it, so no kernel-side validation is required. */
static uint64_t sys_sigaction(uint64_t signum, uint64_t handler, uint64_t restorer) {
    return (uint64_t)process_sigaction((int)signum, handler, restorer);
}

static uint64_t sys_uptime(void) {
    return timer_get_ticks();
}

/* time(): current wall-clock time in Unix epoch seconds, read from the CMOS
 * RTC. Unlike sys_uptime (ticks since boot), this is real calendar time. */
static uint64_t sys_time(void) {
    return rtc_unix_time();
}

/* agent_ask(): pose a decision question to the connected agent and block for the
 * answer (stage A5, the OS → agent direction). The question string is copied in
 * with the usual page-validated reader; the output buffer is validated for
 * write, then handed straight to agent_ask, whose copy-back runs in this
 * caller's context (CR3 unchanged across int 0x80) so it lands in the user's
 * pages correctly. Returns the decision byte count on success, or a negative
 * AGENT_ASK_* code (AGENT_ASK_TIMEOUT when no agent answers — the caller then
 * applies a default; the kernel is never wedged). */
static uint64_t sys_agent_ask(int from_user, uint64_t q_ptr, uint64_t out_ptr,
                              uint64_t out_cap, uint64_t code, uint64_t timeout_ms) {
    char q[SYSCALL_AGENT_QMAX];
    if (read_user_str(from_user, q_ptr, q, sizeof(q)) != 0)
        return (uint64_t)(int64_t)AGENT_ASK_EINVAL;

    if (out_cap > AGENTFRAME_PAYLOAD_MAX)
        out_cap = AGENTFRAME_PAYLOAD_MAX;
    if (!out_ptr || out_cap == 0 || !uok(from_user, out_ptr, out_cap, 1 /* write */))
        return (uint64_t)(int64_t)AGENT_ASK_EINVAL;

    uint16_t rlen = 0;
    int rc = agent_ask((uint16_t)code, (const uint8_t *)q, (uint16_t)strlen(q),
                       (uint8_t *)(uint64_t)out_ptr, (uint16_t)out_cap, &rlen,
                       (uint32_t)timeout_ms);
    if (rc != AGENT_ASK_OK)
        return (uint64_t)(int64_t)rc;
    return (uint64_t)rlen;
}

/* Strip the final path component, yielding the parent directory path. "/a/b" ->
 * "/a", "/a" -> "/", "/" -> "/". Used to permission-check the parent directory
 * when creating a new file. */
static void path_dirname(const char *path, char out[SYSCALL_MAX_PATH]) {
    size_t n = 0;
    while (path[n] && n + 1 < SYSCALL_MAX_PATH) {
        out[n] = path[n];
        n++;
    }
    while (n > 0 && out[n - 1] != '/')
        n--;                       /* drop the leaf name */
    while (n > 1 && out[n - 1] == '/')
        n--;                       /* drop trailing slash, but keep root "/" */
    if (n == 0)
        n = 1;                     /* defensive: resolve to root */
    out[0] = '/';
    out[n] = '\0';
}

/* Discretionary access control (Phase 13). Returns 1 if a user process with the
 * caller's effective ids may access `path` with the requested rights, else 0.
 * Root (euid 0) bypasses all checks. The owner triad applies when euid == owner,
 * the group triad when egid == owner_gid, otherwise the "other" triad. Kernel-
 * originated calls (from_user == 0) and paths with no VFS metadata (a console or
 * pipe fd) always pass — DAC only guards real files. */
static int perm_ok(int from_user, const char *path, int want_read, int want_write) {
    if (!from_user)
        return 1;
    uint32_t euid = process_current_euid();
    if (euid == 0)
        return 1; /* root */

    uint32_t owner_uid = 0, owner_gid = 0;
    uint16_t mode = 0;
    if (vfs_get_meta(path, &owner_uid, &owner_gid, &mode) != 0)
        return 1; /* not a DAC-guarded file */

    uint16_t bits;
    if (euid == owner_uid)
        bits = (mode >> 6) & 7;
    else if (process_current_egid() == owner_gid)
        bits = (mode >> 3) & 7;
    else
        bits = mode & 7;

    if (want_read && !(bits & 4))
        return 0;
    if (want_write && !(bits & 2))
        return 0;
    return 1;
}

static uint64_t sys_open(int from_user, uint64_t path_ptr, uint64_t flags) {
    char path[SYSCALL_MAX_PATH];
    if (read_user_path(from_user, path_ptr, path) != 0)
        return (uint64_t)-1;

    int kind = FD_FILE;
    if (vfs_is_dir(path)) {
        /* A directory opens read-only as a streaming handle for fgetdents
         * (Phase 25). It cannot be created/truncated, and read/write reject it;
         * enumeration needs read permission, exactly like path-based getdents. */
        if (flags & O_CREAT)
            return (uint64_t)-2;
        if (!perm_ok(from_user, path, 1, 0))
            return (uint64_t)-5;
        kind = FD_DIR;
    } else if (flags & O_CREAT) {
        if (vfs_exists(path)) {
            /* Truncating an existing file requires write permission on it. */
            if (!perm_ok(from_user, path, 0, 1))
                return (uint64_t)-5;
            if (vfs_write_file(path, "", 0, 0) < 0)
                return (uint64_t)-4;
        } else {
            /* Creating a new file requires write permission on its directory. */
            char dir[SYSCALL_MAX_PATH];
            path_dirname(path, dir);
            if (!perm_ok(from_user, dir, 0, 1))
                return (uint64_t)-5;
            if (vfs_write_file(path, "", 0, 0) < 0)
                return (uint64_t)-4;
            /* A user-created file is owned by its creator's effective ids. */
            if (from_user)
                vfs_chown(path, process_current_euid(), process_current_egid());
        }
    } else if (!vfs_exists(path)) {
        return (uint64_t)-2;
    } else if (!perm_ok(from_user, path, 1, 0)) {
        /* Opening an existing file requires at least read permission. */
        return (uint64_t)-5;
    }

    struct fd_entry *fds = cur_fds();
    if (!fds)
        return (uint64_t)-3;
    for (int i = 0; i < SYSCALL_MAX_FDS; i++) {
        if (!fds[i].used) {
            fds[i].used = 1;
            fds[i].kind = kind;
            fds[i].offset = 0;
            copy_cstr_limited(fds[i].path, path, sizeof(fds[i].path));
            return (uint64_t)i;
        }
    }
    return (uint64_t)-3;
}

/* Blocking canonical-mode read from the console (stdin, fd 0). Pulls decoded
 * characters from the shared console input source — the PS/2 keyboard ring
 * (IRQ1) with the serial port as a fallback, exactly what the shell uses — and
 * runs a TTY line discipline over them:
 *
 *   - Line buffering: bytes accumulate until Enter (CR or LF), and the whole
 *     line (including the terminating '\n') is returned at once. A read also
 *     returns early if the user's buffer fills (no newline yet) so a short
 *     `len` still makes progress.
 *   - Backspace/DEL editing: erases the last buffered byte and rubs it off the
 *     screen with "\b \b", so typos can be corrected before Enter.
 *   - Ctrl-C (0x03): raises SIGINT on the calling process. If the program
 *     installed a SIGINT handler the kernel delivers it on this syscall's
 *     return; otherwise the default action terminates the program (exit code
 *     130). Either way this read does not return normally.
 *
 * A foreground program owns the console while it runs because the shell parks
 * in its reap-wait loop (which never drains input), so there is no contention
 * over the keyboard ring. */
static uint64_t sys_console_read(uint64_t buf_ptr, uint64_t len) {
    char *out = (char *)(uint64_t)buf_ptr;
    uint64_t n = 0;
    for (;;) {
        char c;
        if (!console_getchar_nonblock(&c)) {
            yield(); /* no input yet — let other tasks and IRQ1 run */
            continue;
        }

        if (c == 0x03) {                 /* Ctrl-C → SIGINT on this process */
            process_kill(process_current_pid(), PROCESS_SIGINT);
            /* Default action terminated us (no return), or a handler is now
             * pending and fires on this syscall's iretq. Report a short read of
             * whatever was typed so far; the interrupted line is discarded. */
            return n;
        }

        if (c == '\b' || c == 0x7f) {    /* Backspace / DEL: erase one byte */
            if (n > 0) {
                n--;
                console_putchar('\b');
                console_putchar(' ');
                console_putchar('\b');
            }
            continue;
        }

        if (c == '\r')                   /* normalize CR to LF */
            c = '\n';

        if (n < len) {
            out[n++] = c;
            console_putchar(c);          /* echo, like a cooked terminal */
        }

        if (c == '\n' || n == len)       /* line complete or buffer full */
            return n;
    }
}

static uint64_t sys_read(int from_user, uint64_t fd, uint64_t buf_ptr, uint64_t len) {
    struct fd_entry *fds = cur_fds();
    if (!fds || fd >= SYSCALL_MAX_FDS || !fds[fd].used)
        return (uint64_t)-1;
    if (!buf_ptr || len == 0)
        return 0;
    if (!uok(from_user, buf_ptr, len, 1 /* kernel writes into this buffer */))
        return (uint64_t)-1;

    if (fds[fd].kind == FD_PIPE)
        return sys_pipe_read(fds, (int)fd, buf_ptr, len);
    if (fds[fd].kind == FD_CONSOLE) {
        /* fd 0 is stdin — read live keystrokes. fd 1/2 are stdout/stderr; the
         * standard streams are all FD_CONSOLE, so reading a write stream is
         * meaningless and reports EOF rather than stealing the user's input. */
        if (fd == 0)
            return sys_console_read(buf_ptr, len);
        return 0;
    }
    if (fds[fd].kind == FD_DIR)
        return (uint64_t)-1; /* directories are not byte-readable; use fgetdents */

    /* Re-check read permission against the caller's current ids: a process that
     * dropped privilege (setuid) after opening must not keep reading a file it
     * could no longer open. */
    if (!perm_ok(from_user, fds[fd].path, 1, 0))
        return (uint64_t)-1;
    int n = vfs_read_file_at(fds[fd].path, (void *)(uint64_t)buf_ptr, (size_t)len, fds[fd].offset);
    if (n > 0)
        fds[fd].offset += (size_t)n;
    return (uint64_t)((n < 0) ? -2 : n);
}

static uint64_t sys_close(uint64_t fd) {
    struct fd_entry *fds = cur_fds();
    if (!fds || fd >= SYSCALL_MAX_FDS || !fds[fd].used)
        return (uint64_t)-1;
    if (fds[fd].kind == FD_PIPE) {
        struct pipe_buf *p = &pipe_table[fds[fd].pipe_id];
        if (fds[fd].pipe_write) {
            if (p->writers > 0)
                p->writers--;
        } else {
            if (p->readers > 0)
                p->readers--;
        }
        if (p->readers == 0 && p->writers == 0)
            p->used = 0; /* both ends gone — reclaim the ring */
    }
    fds[fd].used = 0;
    fds[fd].kind = FD_FILE;
    fds[fd].offset = 0;
    fds[fd].path[0] = '\0';
    return 0;
}

/* lseek(): reposition the cursor of an open FD_FILE descriptor. SEEK_SET sets it
 * to `off` absolute, SEEK_CUR adds `off` to the current offset, SEEK_END adds
 * `off` to the file's current size (`off` is a signed delta for CUR/END). Seeking
 * past end-of-file is allowed (a subsequent read there returns 0); seeking before
 * the start is rejected. Returns the resulting absolute offset, or -1 for a bad
 * descriptor, a non-seekable descriptor (pipe/console), an unknown whence, or a
 * negative result. */
static uint64_t sys_lseek(uint64_t fd, uint64_t off_raw, uint64_t whence) {
    struct fd_entry *fds = cur_fds();
    if (!fds || fd >= SYSCALL_MAX_FDS || !fds[fd].used)
        return (uint64_t)-1;
    if (fds[fd].kind != FD_FILE)
        return (uint64_t)-1;
    int64_t off = (int64_t)off_raw;
    int64_t base;
    switch (whence) {
    case SEEK_SET:
        base = 0;
        break;
    case SEEK_CUR:
        base = (int64_t)fds[fd].offset;
        break;
    case SEEK_END: {
        size_t sz = 0;
        if (vfs_get_size(fds[fd].path, &sz) != 0)
            return (uint64_t)-1;
        base = (int64_t)sz;
        break;
    }
    default:
        return (uint64_t)-1;
    }
    int64_t result = base + off;
    if (result < 0)
        return (uint64_t)-1;
    fds[fd].offset = (size_t)result;
    return (uint64_t)result;
}

/* truncate(): resize the file named by `path` to `length` bytes. Follows a
 * trailing symlink, requires write permission, and zero-extends or trims via
 * vfs_truncate. Returns 0 on success, -1 on a bad path, a non-file, denied
 * permission, or an allocation failure. */
static uint64_t sys_truncate(int from_user, uint64_t path_ptr, uint64_t length) {
    char path[SYSCALL_MAX_PATH];
    if (read_user_path(from_user, path_ptr, path) != 0)
        return (uint64_t)-1;
    if (!perm_ok(from_user, path, 0, 1 /* write */))
        return (uint64_t)-1;
    return vfs_truncate(path, (size_t)length) == 0 ? 0 : (uint64_t)-1;
}

/* ftruncate(): like truncate but on an open FD_FILE descriptor. Re-checks write
 * permission against the caller's current ids (a process that dropped privilege
 * after opening must not keep resizing a file it could no longer write). */
static uint64_t sys_ftruncate(int from_user, uint64_t fd, uint64_t length) {
    struct fd_entry *fds = cur_fds();
    if (!fds || fd >= SYSCALL_MAX_FDS || !fds[fd].used)
        return (uint64_t)-1;
    if (fds[fd].kind != FD_FILE)
        return (uint64_t)-1;
    if (!perm_ok(from_user, fds[fd].path, 0, 1 /* write */))
        return (uint64_t)-1;
    return vfs_truncate(fds[fd].path, (size_t)length) == 0 ? 0 : (uint64_t)-1;
}

/* rename(oldpath, newpath): move a regular file or symlink to a new name/location
 * (Phase 24). Neither final component is dereferenced (read_user_path_ex
 * follow_final = 0), so a symlink is moved as itself, matching unlink/symlink
 * semantics. Requires write permission on BOTH parent directories — the source's
 * (an entry is removed) and the destination's (an entry is added). The heavy
 * lifting (existence, directory/no-clobber rejection, relink, persist hooks)
 * lives in vfs_rename. Returns 0 on success, -1 otherwise. */
static uint64_t sys_rename(int from_user, uint64_t old_ptr, uint64_t new_ptr) {
    char oldpath[SYSCALL_MAX_PATH];
    if (read_user_path_ex(from_user, old_ptr, oldpath, 0) != 0)
        return (uint64_t)-1;
    char newpath[SYSCALL_MAX_PATH];
    if (read_user_path_ex(from_user, new_ptr, newpath, 0) != 0)
        return (uint64_t)-1;
    char olddir[SYSCALL_MAX_PATH];
    path_dirname(oldpath, olddir);
    if (!perm_ok(from_user, olddir, 0, 1))
        return (uint64_t)-1;
    char newdir[SYSCALL_MAX_PATH];
    path_dirname(newpath, newdir);
    if (!perm_ok(from_user, newdir, 0, 1))
        return (uint64_t)-1;
    return vfs_rename(oldpath, newpath) == 0 ? 0 : (uint64_t)-1;
}

/* dup(): duplicate an open fd onto the lowest free descriptor. A file end shares
 * the path and a copy of the current offset; a pipe end shares the same ring and
 * bumps that end's reader/writer count so the pipe stays open until every copy
 * is closed. Returns the new fd, or -1 for a bad source fd or a full table. */
static uint64_t sys_dup(uint64_t fd) {
    struct fd_entry *fds = cur_fds();
    if (!fds || fd >= SYSCALL_MAX_FDS || !fds[fd].used)
        return (uint64_t)-1;
    for (int i = 0; i < SYSCALL_MAX_FDS; i++) {
        if (!fds[i].used) {
            fds[i] = fds[fd];
            if (fds[i].kind == FD_PIPE) {
                struct pipe_buf *p = &pipe_table[fds[i].pipe_id];
                if (fds[i].pipe_write)
                    p->writers++;
                else
                    p->readers++;
            }
            return (uint64_t)i;
        }
    }
    return (uint64_t)-1; /* no free descriptor */
}

/* dup2(oldfd, newfd): duplicate oldfd onto a CHOSEN descriptor newfd (dup picks
 * the lowest free one; dup2 names the target). If newfd is already open it is
 * closed first, releasing any pipe-end reference so the counts stay balanced; if
 * oldfd == newfd (and oldfd is valid) the descriptor is left untouched. Like dup,
 * the copy shares the underlying object — a pipe end bumps its reference count so
 * the pipe survives until every copy is closed, and a file end keeps a private
 * copy of the current offset. This is the primitive behind shell redirection:
 * point fd 0/1/2 at an open file or pipe end before exec. Returns newfd, or -1
 * for a bad source descriptor or an out-of-range target. */
static uint64_t sys_dup2(uint64_t oldfd, uint64_t newfd) {
    struct fd_entry *fds = cur_fds();
    if (!fds || oldfd >= SYSCALL_MAX_FDS || !fds[oldfd].used)
        return (uint64_t)-1;
    if (newfd >= SYSCALL_MAX_FDS)
        return (uint64_t)-1;
    if (oldfd == newfd)
        return newfd; /* valid source onto itself: a no-op, per POSIX */

    /* Close whatever currently occupies newfd. Only a pipe end carries shared
     * state that must be released; the struct overwrite below replaces the rest. */
    if (fds[newfd].used && fds[newfd].kind == FD_PIPE) {
        struct pipe_buf *p = &pipe_table[fds[newfd].pipe_id];
        if (fds[newfd].pipe_write) {
            if (p->writers > 0)
                p->writers--;
        } else {
            if (p->readers > 0)
                p->readers--;
        }
        if (p->readers == 0 && p->writers == 0)
            p->used = 0; /* both ends gone — reclaim the ring */
    }

    fds[newfd] = fds[oldfd];
    if (fds[newfd].kind == FD_PIPE) {
        struct pipe_buf *p = &pipe_table[fds[newfd].pipe_id];
        if (fds[newfd].pipe_write)
            p->writers++;
        else
            p->readers++;
    }
    return newfd;
}

/* pipe(fds): create a kernel pipe and return its two ends. fds[0] is the read
 * end, fds[1] the write end. Returns 0 on success, -1 on a bad user pointer, an
 * exhausted pipe table, or fewer than two free descriptors. */
static uint64_t sys_pipe(int from_user, uint64_t fds_ptr) {
    if (!fds_ptr || !uok(from_user, fds_ptr, sizeof(int) * 2, 1 /* kernel writes */))
        return (uint64_t)-1;

    struct fd_entry *fds = cur_fds();
    if (!fds)
        return (uint64_t)-1;

    int pid = -1;
    for (int i = 0; i < SYSCALL_PIPE_MAX; i++) {
        if (!pipe_table[i].used) {
            pid = i;
            break;
        }
    }
    if (pid < 0)
        return (uint64_t)-1; /* pipe table exhausted */

    int rfd = -1, wfd = -1;
    for (int i = 0; i < SYSCALL_MAX_FDS; i++) {
        if (!fds[i].used) {
            if (rfd < 0)
                rfd = i;
            else {
                wfd = i;
                break;
            }
        }
    }
    if (rfd < 0 || wfd < 0)
        return (uint64_t)-1; /* need two free descriptors */

    struct pipe_buf *p = &pipe_table[pid];
    p->used = 1;
    p->readers = 1;
    p->writers = 1;
    p->head = 0;
    p->count = 0;

    fds[rfd].used = 1;
    fds[rfd].kind = FD_PIPE;
    fds[rfd].pipe_id = pid;
    fds[rfd].pipe_write = 0;

    fds[wfd].used = 1;
    fds[wfd].kind = FD_PIPE;
    fds[wfd].pipe_id = pid;
    fds[wfd].pipe_write = 1;

    int *out = (int *)(uintptr_t)fds_ptr; /* user CR3 active here */
    out[0] = rfd;
    out[1] = wfd;
    return 0;
}

/* fd-based file write: appends `len` bytes from the user buffer to the open
 * file and advances its offset. Persistence (for /disk) happens via the VFS
 * write hook inside vfs_write_file. Distinct from SYSCALL_WRITE, which is the
 * fd-less console write. */
static uint64_t sys_write_file(int from_user, uint64_t fd, uint64_t buf_ptr, uint64_t len) {
    struct fd_entry *fds = cur_fds();
    if (!fds || fd >= SYSCALL_MAX_FDS || !fds[fd].used)
        return (uint64_t)-1;
    if (!buf_ptr || len == 0)
        return 0;
    if (len > SYSCALL_MAX_WRITE_LEN)
        len = SYSCALL_MAX_WRITE_LEN;
    if (!uok(from_user, buf_ptr, len, 0))
        return (uint64_t)-1;

    if (fds[fd].kind == FD_PIPE)
        return sys_pipe_write(fds, (int)fd, buf_ptr, len);
    if (fds[fd].kind == FD_CONSOLE) {
        /* stdout/stderr: bytes go straight to the serial console, exactly like
         * the fd-less SYSCALL_WRITE — programs may now use the standard streams. */
        const char *p = (const char *)(uint64_t)buf_ptr;
        for (uint64_t i = 0; i < len; i++)
            serial_putchar(p[i]);
        return len;
    }
    if (fds[fd].kind == FD_DIR)
        return (uint64_t)-1; /* directories are not writable */

    /* FD_FILE: re-check write permission against the caller's current ids. */
    if (!perm_ok(from_user, fds[fd].path, 0, 1))
        return (uint64_t)-1;
    int n = vfs_write_file(fds[fd].path, (const void *)(uint64_t)buf_ptr,
                           (size_t)len, 1 /* append */);
    if (n < 0)
        return (uint64_t)-2;
    fds[fd].offset += (size_t)n;
    return (uint64_t)n;
}

/* ── User identity & DAC syscalls (Phase 13) ───────────────────────── */

static uint64_t sys_getuid(void)  { return (uint64_t)process_current_uid(); }
static uint64_t sys_getgid(void)  { return (uint64_t)process_current_gid(); }
static uint64_t sys_geteuid(void) { return (uint64_t)process_current_euid(); }

static uint64_t sys_setuid(uint64_t uid) {
    return (uint64_t)(int64_t)process_set_uid((uint32_t)uid);
}
static uint64_t sys_setgid(uint64_t gid) {
    return (uint64_t)(int64_t)process_set_gid((uint32_t)gid);
}

/* chmod: only the file's owner or root may change its mode. */
static uint64_t sys_chmod(int from_user, uint64_t path_ptr, uint64_t mode) {
    char path[SYSCALL_MAX_PATH];
    if (read_user_path(from_user, path_ptr, path) != 0)
        return (uint64_t)-1;
    uint32_t owner = 0, gid = 0;
    uint16_t cur = 0;
    if (vfs_get_meta(path, &owner, &gid, &cur) != 0)
        return (uint64_t)-1;
    if (from_user) {
        uint32_t euid = process_current_euid();
        if (euid != 0 && euid != owner)
            return (uint64_t)-1; /* not owner, not root */
    }
    return (uint64_t)(int64_t)vfs_chmod(path, (uint16_t)(mode & 0777));
}

/* chown: only root may change a file's owner (POSIX semantics). */
static uint64_t sys_chown(int from_user, uint64_t path_ptr, uint64_t uid, uint64_t gid) {
    char path[SYSCALL_MAX_PATH];
    if (read_user_path(from_user, path_ptr, path) != 0)
        return (uint64_t)-1;
    if (from_user && process_current_euid() != 0)
        return (uint64_t)-1;
    if (!vfs_exists(path))
        return (uint64_t)-1;
    return (uint64_t)(int64_t)vfs_chown(path, (uint32_t)uid, (uint32_t)gid);
}

/* chdir: set the calling context's cwd. The path argument is already resolved
 * to an absolute path by read_user_path (relative to the current cwd); it must
 * name an existing directory. Returns 0 on success, -1 if it is absent or not a
 * directory. No DAC check — traversal permission is enforced at open() time. */
static uint64_t sys_chdir(int from_user, uint64_t path_ptr) {
    char path[SYSCALL_MAX_PATH];
    if (read_user_path(from_user, path_ptr, path) != 0)
        return (uint64_t)-1;
    if (!vfs_is_dir(path))
        return (uint64_t)-1;
    return (uint64_t)(int64_t)process_set_cwd(path);
}

/* getcwd: copy the calling context's absolute cwd into the user buffer. Returns
 * the byte length written (excluding the NUL), or -1 if the buffer is too small
 * for the path plus its terminator. */
static uint64_t sys_getcwd(int from_user, uint64_t buf_ptr, uint64_t len) {
    if (!buf_ptr || len == 0)
        return (uint64_t)-1;
    char cwd[VFS_PATH_MAX];
    process_get_cwd(cwd, sizeof(cwd));
    size_t n = strlen(cwd);
    if (n + 1 > len)
        return (uint64_t)-1;
    if (!uok(from_user, buf_ptr, n + 1, 1 /* kernel writes the path */))
        return (uint64_t)-1;
    memcpy((void *)(uint64_t)buf_ptr, cwd, n + 1);
    return (uint64_t)n;
}

/* ── Filesystem mutation syscalls (Phase 16) ───────────────────────── */

/* mkdir: create the directory named by `path` (resolved against the cwd).
 * Requires write permission on the parent directory. Returns 0 on success, -1 on
 * a bad path, a permission denial, or a VFS failure (parent missing / exists). */
static uint64_t sys_mkdir(int from_user, uint64_t path_ptr) {
    char path[SYSCALL_MAX_PATH];
    if (read_user_path(from_user, path_ptr, path) != 0)
        return (uint64_t)-1;
    char dir[SYSCALL_MAX_PATH];
    path_dirname(path, dir);
    if (!perm_ok(from_user, dir, 0, 1))
        return (uint64_t)-1;
    return (uint64_t)(int64_t)(vfs_mkdir(path) == 0 ? 0 : -1);
}

/* rmdir: remove the EMPTY directory named by `path`. Requires write permission
 * on the parent directory. Returns 0 on success, -1 otherwise (absent, not a
 * directory, non-empty, or permission denied). */
static uint64_t sys_rmdir(int from_user, uint64_t path_ptr) {
    char path[SYSCALL_MAX_PATH];
    if (read_user_path(from_user, path_ptr, path) != 0)
        return (uint64_t)-1;
    char dir[SYSCALL_MAX_PATH];
    path_dirname(path, dir);
    if (!perm_ok(from_user, dir, 0, 1))
        return (uint64_t)-1;
    return (uint64_t)(int64_t)(vfs_rmdir(path) == 0 ? 0 : -1);
}

/* unlink: remove the regular file or symbolic link named by `path`. The final
 * component is NOT dereferenced (read_user_path_ex follow_final = 0), so unlink
 * removes a symlink itself rather than its target. Requires write permission on
 * the parent directory. Returns 0 on success, -1 otherwise (absent, a directory,
 * or permission denied). */
static uint64_t sys_unlink(int from_user, uint64_t path_ptr) {
    char path[SYSCALL_MAX_PATH];
    if (read_user_path_ex(from_user, path_ptr, path, 0) != 0)
        return (uint64_t)-1;
    char dir[SYSCALL_MAX_PATH];
    path_dirname(path, dir);
    if (!perm_ok(from_user, dir, 0, 1))
        return (uint64_t)-1;
    return (uint64_t)(int64_t)(vfs_remove(path) == 0 ? 0 : -1);
}

/* symlink: create a symbolic link at `link_ptr` whose stored target text is the
 * string at `target_ptr` (kept verbatim — it is resolved only when the link is
 * later traversed, so a relative or not-yet-existent target is fine). The link
 * path's final component is not dereferenced (we create the link, not write
 * through an existing one); the target is read as a raw string and never
 * resolved here. Requires write permission on the link's parent directory.
 * Returns 0 on success, -1 on a bad path, a permission denial, or if the link
 * path already exists. */
static uint64_t sys_symlink(int from_user, uint64_t target_ptr, uint64_t link_ptr) {
    char target[SYSCALL_MAX_PATH];
    if (read_user_str(from_user, target_ptr, target, SYSCALL_MAX_PATH) != 0)
        return (uint64_t)-1;
    char link[SYSCALL_MAX_PATH];
    if (read_user_path_ex(from_user, link_ptr, link, 0) != 0)
        return (uint64_t)-1;
    char dir[SYSCALL_MAX_PATH];
    path_dirname(link, dir);
    if (!perm_ok(from_user, dir, 0, 1))
        return (uint64_t)-1;
    return (uint64_t)(int64_t)(vfs_symlink(link, target) == 0 ? 0 : -1);
}

/* readlink: copy the raw target text of the symbolic link at `path` into the
 * user buffer (up to `len` bytes, NOT NUL-terminated — POSIX). The link's final
 * component is not dereferenced. Requires read permission on the link. Returns
 * the number of bytes written, or -1 if `path` is not a symlink or on a bad
 * buffer. */
static uint64_t sys_readlink(int from_user, uint64_t path_ptr, uint64_t buf_ptr, uint64_t len) {
    char path[SYSCALL_MAX_PATH];
    if (read_user_path_ex(from_user, path_ptr, path, 0) != 0)
        return (uint64_t)-1;
    if (!perm_ok(from_user, path, 1, 0))
        return (uint64_t)-1;
    char tmp[SYSCALL_MAX_PATH];
    int n = vfs_readlink(path, tmp, sizeof(tmp));
    if (n < 0)
        return (uint64_t)-1;
    if ((uint64_t)n > len)
        n = (int)len;
    if (n > 0) {
        if (!uok(from_user, buf_ptr, (uint64_t)n, 1 /* kernel writes the target */))
            return (uint64_t)-1;
        memcpy((void *)(uint64_t)buf_ptr, tmp, (size_t)n);
    }
    return (uint64_t)(int64_t)n;
}

/* ── File-metadata syscalls (Phase 20) ─────────────────────────────── */

/* Fill `*st` from the VFS node at `path` (already resolved). Returns 0 on
 * success, -1 if the path has no node. No DAC check: stat exposes metadata, not
 * file contents (POSIX requires only directory-traversal permission, which this
 * kernel does not restrict). */
static int stat_fill_path(const char *path, struct khy_stat *st) {
    uint8_t type = 0;
    uint64_t size = 0;
    uint32_t uid = 0, gid = 0;
    uint16_t mode = 0;
    uint64_t mtime = 0, atime = 0, ctime = 0;
    if (vfs_stat(path, &type, &size, &uid, &gid, &mode, &mtime, &atime, &ctime) != 0)
        return -1;
    st->st_size = size;
    st->st_uid = uid;
    st->st_gid = gid;
    st->st_mode = mode;
    st->st_type = type;
    st->st_mtime = mtime;
    st->st_atime = atime;
    st->st_ctime = ctime;
    return 0;
}

/* Copy a filled struct khy_stat out to the user buffer at `buf_ptr`, validating
 * the destination window first. Returns 0 on success, -1 on a bad buffer. */
static uint64_t stat_copy_out(int from_user, uint64_t buf_ptr, const struct khy_stat *st) {
    if (!buf_ptr)
        return (uint64_t)-1;
    if (!uok(from_user, buf_ptr, sizeof(*st), 1 /* kernel writes the struct */))
        return (uint64_t)-1;
    memcpy((void *)(uint64_t)buf_ptr, st, sizeof(*st));
    return 0;
}

/* stat: metadata of `path`, following a trailing symlink to its target. */
static uint64_t sys_stat(int from_user, uint64_t path_ptr, uint64_t buf_ptr) {
    char path[SYSCALL_MAX_PATH];
    if (read_user_path(from_user, path_ptr, path) != 0)
        return (uint64_t)-1;
    struct khy_stat st;
    memset(&st, 0, sizeof(st));
    if (stat_fill_path(path, &st) != 0)
        return (uint64_t)-1;
    return stat_copy_out(from_user, buf_ptr, &st);
}

/* lstat: like stat but the trailing component is NOT dereferenced, so a symlink
 * reports itself (type SYMLINK, size = target length) rather than its target. */
static uint64_t sys_lstat(int from_user, uint64_t path_ptr, uint64_t buf_ptr) {
    char path[SYSCALL_MAX_PATH];
    if (read_user_path_ex(from_user, path_ptr, path, 0) != 0)
        return (uint64_t)-1;
    struct khy_stat st;
    memset(&st, 0, sizeof(st));
    if (stat_fill_path(path, &st) != 0)
        return (uint64_t)-1;
    return stat_copy_out(from_user, buf_ptr, &st);
}

/* fstat: metadata of the file open on descriptor `fd`. A path-backed (FD_FILE)
 * descriptor reports its VFS node; a pipe or console descriptor has no node, so
 * it reports st_type 0 with a zero size (an honest "special, not a VFS file"). */
static uint64_t sys_fstat(int from_user, uint64_t fd, uint64_t buf_ptr) {
    struct fd_entry *fds = cur_fds();
    if (!fds || (int64_t)fd < 0 || fd >= SYSCALL_MAX_FDS || !fds[fd].used)
        return (uint64_t)-1;
    struct khy_stat st;
    memset(&st, 0, sizeof(st));
    if (fds[fd].kind == FD_FILE || fds[fd].kind == FD_DIR) {
        if (stat_fill_path(fds[fd].path, &st) != 0)
            return (uint64_t)-1;
    }
    /* FD_PIPE / FD_CONSOLE: leave the zeroed struct (st_type 0 = no VFS node). */
    return stat_copy_out(from_user, buf_ptr, &st);
}

/* ── Directory enumeration (Phase 21) ─────────────────────────────── */

#define SYSCALL_GETDENTS_MAX 64   /* entries per call (bounds the kernel scratch) */

/* getdents: enumerate the directory at `path`, filling the user array `buf` with
 * up to `max_entries` struct khy_dirent (one per child: name, type, size). A
 * trailing symlink is followed, so a link to a directory lists the target.
 * Requires read permission on the directory. Returns the number of entries
 * written (0 for an empty directory), or -1 if the path is not a directory,
 * permission is denied, or the user buffer is unusable. The per-call count is
 * capped at SYSCALL_GETDENTS_MAX; a directory with more children than the cap is
 * reported truncated. For unbounded enumeration, open the directory and stream it
 * with the cursor-paginated SYSCALL_FGETDENTS (Phase 25) instead. */
static uint64_t sys_getdents(int from_user, uint64_t path_ptr, uint64_t buf_ptr,
                             uint64_t max_entries) {
    static struct vfs_dirent scratch[SYSCALL_GETDENTS_MAX];
    char path[SYSCALL_MAX_PATH];
    if (read_user_path(from_user, path_ptr, path) != 0)
        return (uint64_t)-1;
    if (!vfs_is_dir(path))
        return (uint64_t)-1;
    if (!perm_ok(from_user, path, 1 /* read */, 0))
        return (uint64_t)-1;
    if (!buf_ptr || max_entries == 0)
        return (uint64_t)-1;
    if (max_entries > SYSCALL_GETDENTS_MAX)
        max_entries = SYSCALL_GETDENTS_MAX;
    if (!uok(from_user, buf_ptr, max_entries * sizeof(struct khy_dirent), 1))
        return (uint64_t)-1;
    int n = vfs_list_dir(path, scratch, (size_t)max_entries);
    if (n < 0)
        return (uint64_t)-1;
    for (int i = 0; i < n; i++) {
        struct khy_dirent d;
        memset(&d, 0, sizeof(d));
        d.d_size = scratch[i].size;
        d.d_type = scratch[i].type;
        for (size_t j = 0; j < sizeof(d.d_name) - 1 && scratch[i].name[j]; j++)
            d.d_name[j] = scratch[i].name[j];
        memcpy((void *)(uint64_t)(buf_ptr + (uint64_t)i * sizeof(d)), &d, sizeof(d));
    }
    return (uint64_t)(int64_t)n;
}

/* fgetdents: stream entries from a directory opened with SYSCALL_OPEN (an FD_DIR
 * descriptor), starting at the descriptor's cursor and advancing it by the number
 * returned. Repeated calls page through a directory of any size — the cursor lives
 * in fds[fd].offset — and return 0 once every child has been delivered. Re-checks
 * read permission against the caller's current ids (a process that dropped
 * privilege after opening must not keep reading the directory). Returns the number
 * of entries written, or -1 for a bad/non-directory descriptor, denied permission,
 * or an unusable user buffer. */
static uint64_t sys_fgetdents(int from_user, uint64_t fd, uint64_t buf_ptr,
                              uint64_t max_entries) {
    static struct vfs_dirent scratch[SYSCALL_GETDENTS_MAX];
    struct fd_entry *fds = cur_fds();
    if (!fds || fd >= SYSCALL_MAX_FDS || !fds[fd].used)
        return (uint64_t)-1;
    if (fds[fd].kind != FD_DIR)
        return (uint64_t)-1;
    if (!perm_ok(from_user, fds[fd].path, 1 /* read */, 0))
        return (uint64_t)-1;
    if (!buf_ptr || max_entries == 0)
        return (uint64_t)-1;
    if (max_entries > SYSCALL_GETDENTS_MAX)
        max_entries = SYSCALL_GETDENTS_MAX;
    if (!uok(from_user, buf_ptr, max_entries * sizeof(struct khy_dirent), 1))
        return (uint64_t)-1;
    int n = vfs_list_dir_at(fds[fd].path, fds[fd].offset, scratch, (size_t)max_entries);
    if (n < 0)
        return (uint64_t)-1;
    for (int i = 0; i < n; i++) {
        struct khy_dirent d;
        memset(&d, 0, sizeof(d));
        d.d_size = scratch[i].size;
        d.d_type = scratch[i].type;
        for (size_t j = 0; j < sizeof(d.d_name) - 1 && scratch[i].name[j]; j++)
            d.d_name[j] = scratch[i].name[j];
        memcpy((void *)(uint64_t)(buf_ptr + (uint64_t)i * sizeof(d)), &d, sizeof(d));
    }
    fds[fd].offset += (size_t)n;   /* advance the cursor for the next call */
    return (uint64_t)(int64_t)n;
}

/* net_send: hand `len` bytes from the user buffer to the network stack. */
static uint64_t sys_net_send(int from_user, uint64_t buf_ptr, uint64_t len) {
    if (!buf_ptr || len == 0)
        return (uint64_t)-1;
    if (!uok(from_user, buf_ptr, len, 0))
        return (uint64_t)-1;
    return (uint64_t)net_send((const void *)(uint64_t)buf_ptr, (size_t)len);
}

static uint64_t sys_net_recv(int from_user, uint64_t buf_ptr, uint64_t max_len) {
    if (!buf_ptr || max_len == 0)
        return (uint64_t)-1;
    if (!uok(from_user, buf_ptr, max_len, 1 /* kernel writes received bytes */))
        return (uint64_t)-1;
    return (uint64_t)net_recv((void *)(uint64_t)buf_ptr, (size_t)max_len);
}

/* ── IPC syscall wrappers ──────────────────────────────────────── */

static uint64_t sys_ipc_send(int from_user, uint64_t dest_port, uint64_t msg_ptr) {
    if (!msg_ptr)
        return (uint64_t)IPC_ERR_INVAL;
    if (!uok(from_user, msg_ptr, sizeof(struct ipc_message), 0))
        return (uint64_t)IPC_ERR_INVAL;
    return (uint64_t)ipc_send((uint16_t)dest_port,
                              (const struct ipc_message *)(uintptr_t)msg_ptr);
}

static uint64_t sys_ipc_recv(int from_user, uint64_t port, uint64_t msg_ptr, uint64_t flags) {
    if (!msg_ptr)
        return (uint64_t)IPC_ERR_INVAL;
    if (!uok(from_user, msg_ptr, sizeof(struct ipc_message), 1 /* filled in */))
        return (uint64_t)IPC_ERR_INVAL;
    return (uint64_t)ipc_recv((uint16_t)port,
                              (struct ipc_message *)(uintptr_t)msg_ptr,
                              (uint32_t)flags);
}

static uint64_t sys_ipc_call(int from_user, uint64_t dest_port, uint64_t req_ptr, uint64_t reply_ptr) {
    if (!req_ptr || !reply_ptr)
        return (uint64_t)IPC_ERR_INVAL;
    if (!uok(from_user, req_ptr, sizeof(struct ipc_message), 0) ||
        !uok(from_user, reply_ptr, sizeof(struct ipc_message), 1))
        return (uint64_t)IPC_ERR_INVAL;
    return (uint64_t)ipc_call((uint16_t)dest_port,
                              (const struct ipc_message *)(uintptr_t)req_ptr,
                              (struct ipc_message *)(uintptr_t)reply_ptr);
}

static uint64_t sys_port_register(uint64_t port) {
    return (uint64_t)ipc_port_register((uint16_t)port);
}

static uint64_t sys_port_unregister(uint64_t port) {
    return (uint64_t)ipc_port_unregister((uint16_t)port);
}

static uint64_t sys_create_process(int from_user, uint64_t path_ptr) {
    char path[SYSCALL_MAX_PATH];
    if (read_user_path(from_user, path_ptr, path) != 0)
        return (uint64_t)-1;
    return (uint64_t)process_create_from_elf(path);
}

#define SYSCALL_EXEC_ARG_LEN 64

/* exec(path, argv): replace the calling process's image in place with the ELF
 * at `path`, passing the NULL-terminated argv (a user array of char*). All
 * user-space reads happen HERE, while the caller's address space is still the
 * active CR3 — process_exec then tears that space down, so nothing user-side may
 * be touched afterward. Returns only on failure (-1); on success it never
 * returns (the task drops into the new program). */
static uint64_t sys_exec(int from_user, uint64_t path_ptr, uint64_t argv_ptr) {
    char path[SYSCALL_MAX_PATH];
    if (read_user_path(from_user, path_ptr, path) != 0)
        return (uint64_t)-1;

    /* Snapshot argv into kernel storage before the old space disappears. */
    char argbuf[PROCESS_MAX_ARGS][SYSCALL_EXEC_ARG_LEN];
    const char *argv[PROCESS_MAX_ARGS];
    int argc = 0;
    if (argv_ptr) {
        for (; argc < PROCESS_MAX_ARGS; argc++) {
            uint64_t slot = argv_ptr + (uint64_t)argc * 8;
            if (!uok(from_user, slot, 8, 0))
                return (uint64_t)-1;
            uint64_t p = *(const uint64_t *)(uintptr_t)slot;
            if (p == 0)
                break; /* NULL terminator */
            if (read_user_str(from_user, p, argbuf[argc], SYSCALL_EXEC_ARG_LEN) != 0)
                return (uint64_t)-1;
            argv[argc] = argbuf[argc];
        }
    }
    if (argc == 0) {
        /* No argv supplied: conventional argv[0] = the program path. */
        argv[0] = path;
        argc = 1;
    }

    return (uint64_t)process_exec(path, argc, (const char *const *)argv);
}

/* wait(status): block until one child of the calling process exits, then return
 * its pid and (if status != NULL) store its exit code at *status. Returns -1 if
 * the caller has no children. Polls via yield() — a child that hasn't exited yet
 * keeps the parent cooperatively scheduling until it does. */
static uint64_t sys_wait(int from_user, uint64_t status_ptr) {
    uint32_t pid = process_current_pid();
    if (pid == 0)
        return (uint64_t)-1; /* the kernel/idle task has no children to wait on */
    if (status_ptr && !uok(from_user, status_ptr, sizeof(int), 1 /* kernel writes it */))
        return (uint64_t)-1;

    for (;;) {
        int code = 0;
        int r = process_reap_child(pid, 0 /* any child */, &code);
        if (r > 0) {
            if (status_ptr)
                *(int *)(uintptr_t)status_ptr = code; /* user CR3 active here */
            return (uint64_t)r;
        }
        if (r < 0)
            return (uint64_t)-1; /* no children at all */
        yield(); /* children alive but none has exited yet */
    }
}

static uint64_t sys_yield(void) {
    yield();
    return 0;
}

/* Upper bound on a single user mmap request (resource-exhaustion guard). */
#define SYSCALL_MMAP_MAX (16ULL * 1024 * 1024)

/* Scratch for copying a file's bytes into a file-backed mapping one page at a
 * time. The syscall path is cooperative (single-threaded), so one static buffer
 * is reused across calls without contention. */
static uint8_t mmap_file_buf[VMM_PAGE_SIZE];

/* Populate the already-mapped, zero-filled user range [virt_addr, virt_addr+size)
 * with the contents of the file open on `fd` starting at byte `offset`. Bytes
 * past end-of-file are left zero (anonymous pages start zeroed), giving the usual
 * mmap semantics for a mapping larger than its backing file. Returns 0 on
 * success, -1 if `fd` is not an open regular file or a copy-out fails. */
static int mmap_populate_file(struct vm_space *space, uint64_t virt_addr,
                              uint64_t size, int fd, uint64_t offset) {
    struct fd_entry *fds = cur_fds();
    if (!fds || fd < 0 || fd >= SYSCALL_MAX_FDS || !fds[fd].used)
        return -1;
    if (fds[fd].kind != FD_FILE)
        return -1;                         /* a pipe/console has no byte extent */

    uint64_t done = 0;
    while (done < size) {
        uint64_t chunk = size - done;
        if (chunk > VMM_PAGE_SIZE)
            chunk = VMM_PAGE_SIZE;
        int n = vfs_read_file_at(fds[fd].path, mmap_file_buf, (size_t)chunk,
                                 (size_t)(offset + done));
        if (n <= 0)
            break;                         /* at/after EOF — remainder stays zero */
        if (vmm_copy_to_user(space, virt_addr + done, mmap_file_buf, (size_t)n) != 0)
            return -1;
        done += (uint64_t)n;
        if ((uint64_t)n < chunk)
            break;                         /* short read = EOF reached mid-chunk */
    }
    return 0;
}

static uint64_t sys_mmap(int from_user, uint64_t virt_addr, uint64_t size,
                         uint64_t flags, uint64_t fd, uint64_t offset) {
    struct task *t = sched_current_task();
    struct vm_space *space = t ? t->space : NULL;
    if (!space)
        space = vmm_kernel_space();

    int file_backed = (flags & MAP_FILE) != 0;

    if (from_user) {
        /* [SAFE] Zero-trust mmap gate. A Ring 3 caller controls all arguments, so
         * without this it could (a) map pages at a KERNEL virtual address — a
         * straight privilege breach — or (b) request an unbounded size to drain
         * every physical page. Confine the mapping to the caller's own user
         * window, cap the size, and discard any caller-supplied attribute bits so
         * only USER(+WRITABLE) can be set. */
        if (size == 0 || size > SYSCALL_MMAP_MAX)
            return (uint64_t)-1;
        if (virt_addr < VMM_USER_BASE)
            return (uint64_t)-1;
        /* Overflow-safe end check: keeps [virt_addr, virt_addr+size) ⊂ user. */
        if (virt_addr > VMM_USER_LIMIT - size)
            return (uint64_t)-1;
        flags = VMM_FLAG_USER | (flags & VMM_FLAG_WRITABLE);
    }

    /* A file-backed mapping is filled by copying the file's bytes into its pages,
     * so the pages must be writable while we populate them regardless of the
     * caller's requested protection. */
    uint64_t map_flags = file_backed ? (flags | VMM_FLAG_WRITABLE) : flags;
    int rc = vmm_map_anonymous(space, virt_addr, (size_t)size, map_flags);
    if (rc != 0)
        return (uint64_t)rc;

    if (file_backed &&
        mmap_populate_file(space, virt_addr, size, (int)fd, offset) != 0)
        return (uint64_t)-1;

    return 0;
}

static uint64_t sys_munmap(int from_user, uint64_t virt_addr, uint64_t size) {
    struct task *t = sched_current_task();
    struct vm_space *space = t ? t->space : NULL;
    if (!space)
        space = vmm_kernel_space();

    if (from_user) {
        /* Same zero-trust window as mmap: a Ring 3 caller may only release pages
         * inside its own user range, and a bounded size keeps the page walk cheap. */
        if (size == 0 || size > SYSCALL_MMAP_MAX)
            return (uint64_t)-1;
        if (virt_addr < VMM_USER_BASE)
            return (uint64_t)-1;
        if (virt_addr > VMM_USER_LIMIT - size)
            return (uint64_t)-1;
    }

    return (uint64_t)vmm_unmap_range(space, virt_addr, (size_t)size);
}

static uint64_t sys_mprotect(int from_user, uint64_t virt_addr, uint64_t size,
                             uint64_t flags) {
    struct task *t = sched_current_task();
    struct vm_space *space = t ? t->space : NULL;
    if (!space)
        space = vmm_kernel_space();

    if (from_user) {
        if (size == 0 || size > SYSCALL_MMAP_MAX)
            return (uint64_t)-1;
        if (virt_addr < VMM_USER_BASE)
            return (uint64_t)-1;
        if (virt_addr > VMM_USER_LIMIT - size)
            return (uint64_t)-1;
        flags &= VMM_FLAG_WRITABLE;        /* only the R/W bit is user-controllable */
        /* mprotect changes existing mappings, it never creates them: the whole
         * range must already be mapped as user pages. vmm_check_user_range walks
         * every page and rejects a hole or an address outside the user window. */
        if (vmm_check_user_range(space, virt_addr, (size_t)size, 0) != 0)
            return (uint64_t)-1;
    }

    return (uint64_t)vmm_protect_range(space, virt_addr, (size_t)size, flags);
}

/* ── Main dispatch ─────────────────────────────────────────────── */

static uint64_t syscall_dispatch_raw(int from_user, uint64_t nr, uint64_t a0, uint64_t a1, uint64_t a2,
                                     uint64_t a3, uint64_t a4, uint64_t a5) {
    (void)a5;
    switch (nr) {
    /* Core syscalls (1-9) */
    case SYSCALL_WRITE:
        return sys_write(from_user, a0, a1);
    case SYSCALL_EXIT:
        return sys_exit(a0);
    case SYSCALL_GETPID:
        return sys_getpid();
    case SYSCALL_UPTIME:
        return sys_uptime();
    case SYSCALL_OPEN:
        return sys_open(from_user, a0, a1);
    case SYSCALL_READ:
        return sys_read(from_user, a0, a1, a2);
    case SYSCALL_CLOSE:
        return sys_close(a0);
    case SYSCALL_WRITE_FILE:
        return sys_write_file(from_user, a0, a1, a2);
    case SYSCALL_NET_SEND:
        return sys_net_send(from_user, a0, a1);
    case SYSCALL_NET_RECV:
        return sys_net_recv(from_user, a0, a1);

    /* IPC syscalls (10-17) */
    case SYSCALL_IPC_SEND:
        return sys_ipc_send(from_user, a0, a1);
    case SYSCALL_IPC_RECV:
        return sys_ipc_recv(from_user, a0, a1, a2);
    case SYSCALL_IPC_CALL:
        return sys_ipc_call(from_user, a0, a1, a2);
    case SYSCALL_PORT_REGISTER:
        return sys_port_register(a0);
    case SYSCALL_PORT_UNREGISTER:
        return sys_port_unregister(a0);
    case SYSCALL_CREATE_PROCESS:
        return sys_create_process(from_user, a0);
    case SYSCALL_EXEC:
        return sys_exec(from_user, a0, a1);
    case SYSCALL_WAIT:
        return sys_wait(from_user, a0);
    case SYSCALL_YIELD:
        return sys_yield();
    case SYSCALL_MMAP:
        return sys_mmap(from_user, a0, a1, a2, a3, a4);

    /* Extended process / fd control (22-26) */
    case SYSCALL_GETPPID:
        return sys_getppid();
    case SYSCALL_SBRK:
        return sys_sbrk(a0);
    case SYSCALL_KILL:
        return sys_kill(a0, a1);
    case SYSCALL_DUP:
        return sys_dup(a0);
    case SYSCALL_PIPE:
        return sys_pipe(from_user, a0);
    case SYSCALL_SIGACTION:
        return sys_sigaction(a0, a1, a2);
    /* SYSCALL_SIGRETURN is handled in syscall_dispatch_frame (it rewrites the
     * trap frame in place) and never reaches this argument-only dispatcher. */

    /* User identity & DAC (29-35) */
    case SYSCALL_GETUID:
        return sys_getuid();
    case SYSCALL_GETGID:
        return sys_getgid();
    case SYSCALL_GETEUID:
        return sys_geteuid();
    case SYSCALL_SETUID:
        return sys_setuid(a0);
    case SYSCALL_SETGID:
        return sys_setgid(a0);
    case SYSCALL_CHMOD:
        return sys_chmod(from_user, a0, a1);
    case SYSCALL_CHOWN:
        return sys_chown(from_user, a0, a1, a2);

    /* Working directory (36-37) */
    case SYSCALL_CHDIR:
        return sys_chdir(from_user, a0);
    case SYSCALL_GETCWD:
        return sys_getcwd(from_user, a0, a1);

    /* Filesystem mutation (38-40) */
    case SYSCALL_MKDIR:
        return sys_mkdir(from_user, a0);
    case SYSCALL_RMDIR:
        return sys_rmdir(from_user, a0);
    case SYSCALL_UNLINK:
        return sys_unlink(from_user, a0);

    /* Symbolic links (41-42) */
    case SYSCALL_SYMLINK:
        return sys_symlink(from_user, a0, a1);
    case SYSCALL_READLINK:
        return sys_readlink(from_user, a0, a1, a2);

    /* Virtual-memory mutation (43-44) */
    case SYSCALL_MUNMAP:
        return sys_munmap(from_user, a0, a1);
    case SYSCALL_MPROTECT:
        return sys_mprotect(from_user, a0, a1, a2);

    /* File metadata (45-47) */
    case SYSCALL_STAT:
        return sys_stat(from_user, a0, a1);
    case SYSCALL_LSTAT:
        return sys_lstat(from_user, a0, a1);
    case SYSCALL_FSTAT:
        return sys_fstat(from_user, a0, a1);

    /* Directory enumeration (48) */
    case SYSCALL_GETDENTS:
        return sys_getdents(from_user, a0, a1, a2);

    /* File-offset positioning (49) */
    case SYSCALL_LSEEK:
        return sys_lseek(a0, a1, a2);

    /* File truncation (50-51) */
    case SYSCALL_TRUNCATE:
        return sys_truncate(from_user, a0, a1);
    case SYSCALL_FTRUNCATE:
        return sys_ftruncate(from_user, a0, a1);

    /* File rename/move (52) */
    case SYSCALL_RENAME:
        return sys_rename(from_user, a0, a1);

    /* Directory streaming by descriptor (53) */
    case SYSCALL_FGETDENTS:
        return sys_fgetdents(from_user, a0, a1, a2);

    /* Descriptor redirection (54) */
    case SYSCALL_DUP2:
        return sys_dup2(a0, a1);

    /* Wall-clock time (55) */
    case SYSCALL_TIME:
        return sys_time();

    /* Agent decision plane (56) — OS → agent ask, may block, always times out */
    case SYSCALL_AGENT_ASK:
        return sys_agent_ask(from_user, a0, a1, a2, a3, a4);

    default:
        return (uint64_t)-38; /* ENOSYS */
    }
}

void syscall_init(void) {
    memset(fd_pool, 0, sizeof(fd_pool));
    memset(fd_pool_owner, 0, sizeof(fd_pool_owner));
    memset(fd_pool_used, 0, sizeof(fd_pool_used));
    memset(pipe_table, 0, sizeof(pipe_table));
    syscall_ready = 1;
    serial_print("[SYSCALL] int 0x80 dispatcher ready\n");
}

void syscall_fork_fds(uint32_t parent_pid, uint32_t child_pid) {
    struct fd_entry *parent = NULL;
    for (int i = 0; i < PROCESS_MAX; i++) {
        if (fd_pool_used[i] && fd_pool_owner[i] == parent_pid) {
            parent = fd_pool[i];
            break;
        }
    }
    if (!parent)
        return; /* parent holds no open descriptors — nothing to inherit */

    struct fd_entry *child = fdtable_for(child_pid);
    if (!child)
        return; /* pool exhausted: child starts empty (best effort) */

    for (int i = 0; i < SYSCALL_MAX_FDS; i++) {
        child[i] = parent[i];
        if (parent[i].used && parent[i].kind == FD_PIPE) {
            /* The child now also references this pipe end — bump the count so the
             * pipe stays open until BOTH processes close it (Unix semantics). */
            struct pipe_buf *p = &pipe_table[parent[i].pipe_id];
            if (parent[i].pipe_write)
                p->writers++;
            else
                p->readers++;
        }
    }
}

void syscall_release_fds(uint32_t pid) {
    for (int i = 0; i < PROCESS_MAX; i++) {
        if (!fd_pool_used[i] || fd_pool_owner[i] != pid)
            continue;
        struct fd_entry *fds = fd_pool[i];
        for (int j = 0; j < SYSCALL_MAX_FDS; j++) {
            if (fds[j].used && fds[j].kind == FD_PIPE) {
                struct pipe_buf *p = &pipe_table[fds[j].pipe_id];
                if (fds[j].pipe_write) {
                    if (p->writers > 0)
                        p->writers--;
                } else {
                    if (p->readers > 0)
                        p->readers--;
                }
                if (p->readers == 0 && p->writers == 0)
                    p->used = 0;
            }
        }
        fd_pool_used[i] = 0;
        fd_pool_owner[i] = 0;
        memset(fds, 0, sizeof(fd_pool[i]));
        return;
    }
}

int syscall_pipe_create(void) {
    for (int i = 0; i < SYSCALL_PIPE_MAX; i++) {
        if (!pipe_table[i].used) {
            pipe_table[i].used = 1;
            pipe_table[i].readers = 0; /* bumped as ends are bound */
            pipe_table[i].writers = 0;
            pipe_table[i].head = 0;
            pipe_table[i].count = 0;
            return i;
        }
    }
    return -1; /* pipe table exhausted */
}

int syscall_bind_pipe_fd(uint32_t pid, int fd, int pipe_id, int write_end) {
    if (fd < 0 || fd >= SYSCALL_MAX_FDS || pipe_id < 0 || pipe_id >= SYSCALL_PIPE_MAX)
        return -1;
    if (!pipe_table[pipe_id].used)
        return -1;

    struct fd_entry *fds = fdtable_for(pid);
    if (!fds)
        return -1; /* fd pool exhausted */

    /* If the slot already referenced a pipe end (e.g. an inherited one), release
     * that reference before repointing it, so counts stay balanced. */
    if (fds[fd].used && fds[fd].kind == FD_PIPE) {
        struct pipe_buf *old = &pipe_table[fds[fd].pipe_id];
        if (fds[fd].pipe_write) {
            if (old->writers > 0)
                old->writers--;
        } else {
            if (old->readers > 0)
                old->readers--;
        }
        if (old->readers == 0 && old->writers == 0)
            old->used = 0;
    }

    fds[fd].used = 1;
    fds[fd].kind = FD_PIPE;
    fds[fd].pipe_id = pipe_id;
    fds[fd].pipe_write = write_end ? 1 : 0;
    fds[fd].offset = 0;
    fds[fd].path[0] = '\0';

    struct pipe_buf *p = &pipe_table[pipe_id];
    if (write_end)
        p->writers++;
    else
        p->readers++;
    return 0;
}

/* ── Signal delivery (Phase 8) ─────────────────────────────────────
 * On the way back to Ring 3, deliver one pending signal that has a registered
 * handler by rewriting the trap frame: snapshot the interrupted context onto the
 * user stack (below the SysV red zone, 16-aligned), redirect rip to handler(sig)
 * with a user-supplied restorer parked as the return address. When the handler
 * returns it lands on the restorer, which issues SYSCALL_SIGRETURN to restore the
 * saved context — so the program resumes exactly where it was interrupted. */
static void deliver_pending_signal(struct syscall_frame *f, uint64_t syscall_rv) {
    if ((f->cs & 3) != 3)
        return; /* only a Ring 3 context can take a signal */

    uint64_t handler = 0, restorer = 0;
    int sig = process_take_pending_signal(&handler, &restorer);
    if (sig <= 0)
        return; /* nothing pending */

    if (handler == 0 || restorer == 0) {
        /* No Ring 3 handler installed: the default action for a catchable signal
         * (e.g. a Ctrl-C SIGINT raised on a CPU-bound program from the keyboard
         * IRQ) is to terminate. We are on the task's kernel stack about to return
         * to Ring 3, so it is safe to mark the process exited and switch away for
         * good — the program never resumes. */
        process_mark_exited(process_current_pid(), 128 + sig);
        task_exit(); /* never returns */
        return;
    }

    struct task *t = sched_current_task();
    if (!t || !t->space)
        return;

    /* Snapshot the interrupted Ring 3 state. rax carries the syscall's result so
     * the program observes its normal return value once the handler finishes. */
    struct user_context saved;
    saved.r15 = f->r15; saved.r14 = f->r14; saved.r13 = f->r13; saved.r12 = f->r12;
    saved.r11 = f->r11; saved.r10 = f->r10; saved.r9 = f->r9; saved.r8 = f->r8;
    saved.rbp = f->rbp; saved.rdi = f->rdi; saved.rsi = f->rsi; saved.rdx = f->rdx;
    saved.rcx = f->rcx; saved.rbx = f->rbx; saved.rax = syscall_rv;
    saved.rip = f->rip; saved.cs = f->cs; saved.rflags = f->rflags;
    saved.user_rsp = f->user_rsp; saved.ss = f->ss;

    /* Carve the signal frame from the user stack: skip the 128-byte red zone,
     * place the saved context 16-aligned, then a return-address slot for the
     * restorer (so the handler entry sees rsp % 16 == 8, per the post-call ABI).
     * vmm_copy_to_user fails cleanly on an unmapped page, so a frame that would
     * overflow the mapped stack is skipped rather than faulting the kernel. */
    uint64_t sp = f->user_rsp - 128;
    sp -= sizeof(saved);
    sp &= ~0xFULL;
    uint64_t save_area = sp;
    if (vmm_copy_to_user(t->space, save_area, &saved, sizeof(saved)) != 0)
        return; /* leave the program untouched if the frame can't be staged */
    sp -= 8;
    if (vmm_copy_to_user(t->space, sp, &restorer, sizeof(restorer)) != 0)
        return;

    f->rip = handler;
    f->rdi = (uint64_t)sig; /* SysV first integer argument: handler(int signum) */
    f->user_rsp = sp;
}

/* sigreturn: the restorer trampoline lands here (its int 0x80) after the handler
 * returns, with user_rsp pointing at the saved context staged by delivery.
 * Restore the interrupted Ring 3 state into the trap frame so the following iretq
 * resumes the program. Returns the saved rax — the stub writes our return value
 * into the saved-rax slot, which is the only register slot it overwrites. */
static uint64_t sys_sigreturn(struct syscall_frame *f) {
    if ((f->cs & 3) != 3)
        return (uint64_t)-1;
    struct task *t = sched_current_task();
    if (!t || !t->space)
        return (uint64_t)-1;

    uint64_t save_area = f->user_rsp; /* the restorer's int 0x80 left rsp here */
    if (!uok(1, save_area, sizeof(struct user_context), 0))
        return (uint64_t)-1;
    const struct user_context *s = (const struct user_context *)(uintptr_t)save_area;

    f->r15 = s->r15; f->r14 = s->r14; f->r13 = s->r13; f->r12 = s->r12;
    f->r11 = s->r11; f->r10 = s->r10; f->r9 = s->r9; f->r8 = s->r8;
    f->rbp = s->rbp; f->rdi = s->rdi; f->rsi = s->rsi; f->rdx = s->rdx;
    f->rcx = s->rcx; f->rbx = s->rbx;
    f->rip = s->rip;
    f->user_rsp = s->user_rsp;

    /* Sanitize the (user-writable) saved rflags: clear IOPL so a forged frame
     * can't raise I/O privilege, force the reserved bit and IF on so interrupts
     * can never be disabled from Ring 3. cs/ss keep their current Ring 3
     * selectors. */
    uint64_t rf = s->rflags;
    rf &= ~(3ULL << 12);  /* IOPL = 0 */
    rf |= (1ULL << 1);    /* reserved, always 1 */
    rf |= (1ULL << 9);    /* IF on */
    f->rflags = rf;

    return s->rax;
}

uint64_t syscall_dispatch_frame(void *frame_base) {
    if (!syscall_ready || !frame_base)
        return (uint64_t)-1;
    struct syscall_frame *f = (struct syscall_frame *)frame_base;
    /* CPL 3 in the saved CS means a Ring 3 program issued the int 0x80, so its
     * pointer arguments are untrusted and must be validated against its own
     * address space. A Ring 0 caller (kernel code reaching syscalls via
     * syscall_invoke) is trusted and skips validation. */
    int from_user = (int)((f->cs & 3) == 3);

    /* fork() needs the whole trap frame, not just the argument registers: the
     * child is launched by replaying this exact Ring 3 state with rax=0. Handle
     * it here where the frame is in hand. Only meaningful for Ring 3 callers. */
    if (f->rax == SYSCALL_FORK) {
        if (!from_user)
            return (uint64_t)-1;
        struct user_context ctx;
        ctx.r15 = f->r15; ctx.r14 = f->r14; ctx.r13 = f->r13; ctx.r12 = f->r12;
        ctx.r11 = f->r11; ctx.r10 = f->r10; ctx.r9 = f->r9; ctx.r8 = f->r8;
        ctx.rbp = f->rbp; ctx.rdi = f->rdi; ctx.rsi = f->rsi; ctx.rdx = f->rdx;
        ctx.rcx = f->rcx; ctx.rbx = f->rbx; ctx.rax = f->rax;
        ctx.rip = f->rip; ctx.cs = f->cs; ctx.rflags = f->rflags;
        ctx.user_rsp = f->user_rsp; ctx.ss = f->ss;
        return (uint64_t)process_fork(&ctx);
    }

    /* sigreturn rewrites the trap frame in place to restore the pre-signal
     * context, so it also needs the whole frame. Do NOT deliver a new signal on
     * its way out — we are mid-restore. */
    if (f->rax == SYSCALL_SIGRETURN) {
        if (!from_user)
            return (uint64_t)-1;
        return sys_sigreturn(f);
    }

    uint64_t rv = syscall_dispatch_raw(from_user, f->rax, f->rdi, f->rsi, f->rdx, f->r10, f->r8, f->r9);

    /* Returning to a Ring 3 caller: deliver one pending signal (if any has a
     * handler) by redirecting this return into the user's handler. A self-kill is
     * delivered here synchronously; another process's signal arrives on its next
     * syscall return. */
    if (from_user)
        deliver_pending_signal(f, rv);
    return rv;
}

/* Signal-delivery hook for the IRQ return path (irq_common_stub). An IRQ that
 * interrupted Ring 3 saves the same register frame layout as a syscall, so on
 * the way back to user mode we deliver one pending signal — this is what lets a
 * Ctrl-C reach a CPU-bound program that never makes a syscall. The interrupted
 * rax is preserved (no syscall result to substitute). IRQs from kernel context
 * (cs != Ring 3) are ignored by deliver_pending_signal. */
void irq_return_deliver_signals(void *frame_base) {
    if (!syscall_ready || !frame_base)
        return;
    struct syscall_frame *f = (struct syscall_frame *)frame_base;
    deliver_pending_signal(f, f->rax);
}

long syscall_invoke(uint64_t nr, uint64_t a0, uint64_t a1, uint64_t a2,
                    uint64_t a3, uint64_t a4, uint64_t a5) {
    register uint64_t rax __asm__("rax") = nr;
    register uint64_t rdi __asm__("rdi") = a0;
    register uint64_t rsi __asm__("rsi") = a1;
    register uint64_t rdx __asm__("rdx") = a2;
    register uint64_t r10 __asm__("r10") = a3;
    register uint64_t r8  __asm__("r8")  = a4;
    register uint64_t r9  __asm__("r9")  = a5;

    __asm__ volatile(
        "int $0x80"
        : "+a"(rax)
        : "D"(rdi), "S"(rsi), "d"(rdx), "r"(r10), "r"(r8), "r"(r9)
        : "memory", "rcx", "r11");

    return (long)rax;
}
