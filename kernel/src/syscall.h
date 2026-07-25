/* syscall.h — System call interface (hybrid kernel) * @pattern Strategy
 */
#ifndef SYSCALL_H
#define SYSCALL_H

#include <stdint.h>

enum syscall_nr {
    /* Core (1-9) */
    SYSCALL_WRITE    = 1,
    SYSCALL_EXIT     = 2,
    SYSCALL_GETPID   = 3,
    SYSCALL_UPTIME   = 4,
    SYSCALL_OPEN     = 5,
    SYSCALL_READ     = 6,
    SYSCALL_CLOSE    = 7,
    SYSCALL_NET_SEND = 8,
    SYSCALL_NET_RECV = 9,

    /* IPC (10-17) */
    SYSCALL_IPC_SEND        = 10,
    SYSCALL_IPC_RECV        = 11,
    SYSCALL_IPC_CALL        = 12,
    SYSCALL_PORT_REGISTER   = 13,
    SYSCALL_PORT_UNREGISTER = 14,
    SYSCALL_CREATE_PROCESS  = 15,
    SYSCALL_YIELD           = 16,
    SYSCALL_MMAP            = 17,

    /* File output (18) — fd-based write, complements SYSCALL_WRITE (console) */
    SYSCALL_WRITE_FILE      = 18,

    /* Process control (19-21) */
    SYSCALL_FORK            = 19,
    SYSCALL_EXEC            = 20,
    SYSCALL_WAIT            = 21,

    /* Extended process / fd control (22-26) */
    SYSCALL_GETPPID         = 22,
    SYSCALL_SBRK            = 23,
    SYSCALL_KILL            = 24,
    SYSCALL_DUP             = 25,
    SYSCALL_PIPE            = 26,

    /* Signals (27-28). sigaction installs a Ring 3 handler + restorer trampoline
     * for a catchable signal; sigreturn (issued by the restorer when the handler
     * returns) restores the interrupted context. See deliver_pending_signal. */
    SYSCALL_SIGACTION       = 27,
    SYSCALL_SIGRETURN       = 28,

    /* User identity & discretionary access control (29-35, Phase 13). getuid/
     * getgid/geteuid report the caller's ids; setuid/setgid change them (root
     * freely, non-root may only drop to an id it already holds). chmod/chown
     * adjust a file's permission bits / owner (chmod: owner or root; chown:
     * root only). */
    SYSCALL_GETUID          = 29,
    SYSCALL_GETGID          = 30,
    SYSCALL_GETEUID         = 31,
    SYSCALL_SETUID          = 32,
    SYSCALL_SETGID          = 33,
    SYSCALL_CHMOD           = 34,
    SYSCALL_CHOWN           = 35,

    /* Working directory (36-37, Phase 15). chdir sets the calling process's cwd
     * to a directory (resolved relative to the current cwd, like any path);
     * getcwd copies the cwd's absolute path into a user buffer. All path-taking
     * syscalls resolve a relative argument against the caller's cwd. */
    SYSCALL_CHDIR           = 36,
    SYSCALL_GETCWD          = 37,

    /* Filesystem mutation (38-40, Phase 16). mkdir creates a directory; rmdir
     * removes an EMPTY directory; unlink removes a regular file. Each requires
     * write permission on the parent directory (POSIX semantics) and resolves a
     * relative path argument against the caller's cwd. Together with open(O_CREAT)
     * they give userland symmetric create/delete for both files and directories. */
    SYSCALL_MKDIR           = 38,
    SYSCALL_RMDIR           = 39,
    SYSCALL_UNLINK          = 40,

    /* Symbolic links (41-42, Phase 17). symlink creates a link at the first path
     * whose contents are the second path (stored verbatim, never resolved at
     * creation); readlink copies a link's raw target text into a user buffer.
     * symlink/readlink/unlink act on the link itself (the final component is not
     * dereferenced); every other path-taking syscall follows links transparently
     * so a symlink to a file or directory is usable wherever the target is. */
    SYSCALL_SYMLINK         = 41,
    SYSCALL_READLINK        = 42,

    /* Virtual-memory mutation (43-44, Phase 19). munmap unmaps and releases a
     * previously mmap'd region (the inverse of mmap); mprotect changes the
     * read/write protection of an already-mapped region. Both confine their
     * range to the caller's own user window, complete the mmap API so a process
     * can give memory back and re-protect it instead of only ever acquiring it. */
    SYSCALL_MUNMAP          = 43,
    SYSCALL_MPROTECT        = 44,

    /* File metadata (45-47, Phase 20). stat/lstat fill a struct khy_stat for a
     * path (stat follows a trailing symlink to its target; lstat reports the link
     * itself); fstat reports the file open on a descriptor. They let a program
     * learn a file's type, size, owner and permission bits without reading it —
     * the basis of `ls -l`, size-aware reads, and existence/type checks. */
    SYSCALL_STAT            = 45,
    SYSCALL_LSTAT           = 46,
    SYSCALL_FSTAT           = 47,

    /* Directory enumeration (48, Phase 21). getdents lists a directory's entries
     * into a user array of struct khy_dirent (one per child, with its name, type
     * and size). A trailing symlink in the path is followed, so a link to a
     * directory enumerates the target. This is the primitive a userland `ls`
     * needs: without it a Ring 3 program can stat a path it already knows but
     * cannot discover what a directory contains. */
    SYSCALL_GETDENTS        = 48,

    /* File-offset positioning (49, Phase 22). lseek repositions an open file
     * descriptor's read/write cursor: SEEK_SET sets it to an absolute offset,
     * SEEK_CUR adds to the current offset, SEEK_END adds to the file size. Until
     * now read/write only advanced the cursor forward, so a program could never
     * rewind or skip within a file; lseek makes file access random rather than
     * strictly sequential. Pipes and the console are not seekable. */
    SYSCALL_LSEEK           = 49,

    /* File truncation (50-51, Phase 23). truncate resizes the file at a path;
     * ftruncate resizes the file open on a descriptor. Growing zero-extends the
     * file, shrinking discards the tail. Both require write permission. This is
     * the missing inverse of append-only growth: until now a file could only get
     * bigger (write) or vanish entirely (unlink), never be cut to a chosen size. */
    SYSCALL_TRUNCATE        = 50,
    SYSCALL_FTRUNCATE       = 51,

    /* File rename/move (52, Phase 24). Relinks a regular file or symlink from one
     * path to another without copying its bytes (open fds stay valid). Requires
     * write permission on both the source and destination parent directories and
     * refuses to overwrite an existing destination. Directory rename is rejected.
     * This is the last primitive of basic file management: until now a process
     * could create and delete a name but never move one. */
    SYSCALL_RENAME          = 52,

    /* Directory streaming (53, Phase 25). Companion to SYSCALL_OPEN on a
     * directory: reads struct khy_dirent entries starting at the descriptor's
     * cursor and advances it, so a directory of any size can be paged through in
     * successive calls (path-based SYSCALL_GETDENTS is capped per call). Returns 0
     * once every entry has been delivered. */
    SYSCALL_FGETDENTS       = 53,

    /* Descriptor redirection (54, Phase 26). dup2 duplicates an open descriptor
     * onto a CHOSEN target number (unlike dup, which picks the lowest free one):
     * the target is closed first if open, then made a copy of the source. This is
     * the primitive behind shell redirection — a process points fd 0/1/2 at an
     * open file or pipe end before exec, so `cmd > file` / `cmd < file` work.
     * Returns the target descriptor, or -1 for a bad source/target. */
    SYSCALL_DUP2            = 54,

    /* Wall-clock time (55, Phase 27). Returns the current time as whole seconds
     * since the Unix epoch (1970-01-01 00:00:00 UTC), read from the CMOS RTC.
     * SYSCALL_UPTIME only counts ticks since boot and resets every reset; this
     * is the actual calendar time a program needs to timestamp work, compute
     * durations across reboots, or display the date. Returns the value in rax
     * (POSIX time(NULL) semantics); takes no arguments. */
    SYSCALL_TIME            = 55,

    /* Agent decision plane (56, stage A5). The OS → agent direction: a process
     * (or a kernel subsystem, via the in-kernel agent_ask primitive) poses a
     * decision question to the connected agent and blocks until it answers or a
     * timeout fires. arg0 = pointer to a NUL-terminated question (natural
     * language or a structured intent); arg1/arg2 = an output buffer and its
     * capacity for the decision bytes; arg3 = an intent code (0 = generic);
     * arg4 = timeout in milliseconds (0 = a built-in default). Returns the
     * number of decision bytes written (>= 0) on success, or a negative
     * AGENT_ASK_* code — notably AGENT_ASK_TIMEOUT when no agent is connected or
     * it stays silent, so the caller can fall back to a safe default. Unlike
     * every other syscall this one reaches OUT of the kernel to a human/agent in
     * the loop, which is why it is allowed to block and must always time out. */
    SYSCALL_AGENT_ASK       = 56,
};

/* Metadata returned by stat/lstat/fstat (Phase 20, extended Phase 28/29). Fixed
 * 48-byte layout shared verbatim with Ring 3: st_size first (file bytes, symlink
 * target length, or 0 for a directory), then owner ids, the 9-bit rwxrwxrwx mode,
 * the node type (a VFS_NODE_* value; 0 for a pipe/console descriptor that has no
 * VFS node), then the three POSIX timestamps in Unix epoch seconds — st_mtime
 * (last content/size change), st_atime (last content read) and st_ctime (last
 * status change: write/chmod/chown/rename). All timestamps read 0 for a node with
 * no VFS backing. The earlier fields keep their offsets, so Phase 20/21/28
 * programs are unaffected. */
struct khy_stat {
    uint64_t st_size;
    uint32_t st_uid;
    uint32_t st_gid;
    uint16_t st_mode;
    uint8_t  st_type;
    uint8_t  _pad[5];
    uint64_t st_mtime;
    uint64_t st_atime;
    uint64_t st_ctime;
};

/* One directory entry returned by getdents (Phase 21). Fixed 64-byte layout
 * shared verbatim with Ring 3: the child's size (file bytes, symlink target
 * length, or 0 for a subdirectory), its type (a VFS_NODE_* value), then the
 * NUL-terminated entry name (bounded by VFS_NAME_MAX). */
struct khy_dirent {
    uint64_t d_size;
    uint8_t  d_type;
    uint8_t  _pad[7];
    char     d_name[48];
};

/* open() flags (arg1 of SYSCALL_OPEN). */
#define O_CREAT 1   /* create the file if absent; truncate it to empty if present */

/* lseek() whence values (arg2 of SYSCALL_LSEEK). */
#define SEEK_SET 0   /* offset is absolute from the start of the file */
#define SEEK_CUR 1   /* offset is relative to the current cursor */
#define SEEK_END 2   /* offset is relative to the file's size */

/* mmap() flag (a high bit of the SYSCALL_MMAP flags argument, distinct from the
 * VMM_FLAG_* page-protection bits so it never collides with them). When set, the
 * mapping is file-backed: arg3 (r10) is an open file descriptor and arg4 (r8) is
 * a byte offset within that file; the mapped region is populated with the file's
 * bytes from that offset, and any bytes past end-of-file read as zero. When
 * clear, the mapping is anonymous zero-filled memory (the original behavior). */
#define MAP_FILE 0x10

void syscall_init(void);
uint64_t syscall_dispatch_frame(void *frame_base);

/* Per-process file-descriptor table lifecycle, driven by the process model.
 * fork duplicates the parent's open fds into the child (Unix semantics, so a
 * pipe gains a second reader/writer); process death closes them all, releasing
 * any pipe ends so peers observe EOF / EPIPE. Both are no-ops for a pid that
 * never opened a descriptor. */
void syscall_fork_fds(uint32_t parent_pid, uint32_t child_pid);
void syscall_release_fds(uint32_t pid);

/* Kernel-side pipe plumbing for shell pipelines (`A | B`). syscall_pipe_create
 * allocates an empty kernel pipe (no ends yet) and returns its id, or -1 if the
 * pipe table is full. syscall_bind_pipe_fd force-binds descriptor `fd` of `pid`
 * to one end of that pipe (write_end != 0 = write end), lazily creating the
 * process's fd table and bumping the end's reference count so it stays open
 * until the process closes it (or exits). Returns 0 on success, -1 on a bad
 * argument or an exhausted fd pool. Used by the shell to redirect a child's
 * stdout/stdin onto a pipe before it is scheduled. */
int syscall_pipe_create(void);
int syscall_bind_pipe_fd(uint32_t pid, int fd, int pipe_id, int write_end);

long syscall_invoke(uint64_t nr, uint64_t a0, uint64_t a1, uint64_t a2,
                    uint64_t a3, uint64_t a4, uint64_t a5);

#endif
