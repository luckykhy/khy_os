/* ramfs.c — In-memory root filesystem bootstrap * @pattern Composite
 */

#include "ramfs.h"
#include "serial.h"
#include "vfs.h"
#include "string.h"
#include "user_init_blob.h"   /* GENERATED: user_init_elf[] from userland/init.asm */
#include "user_filetest_blob.h" /* GENERATED: user_filetest_elf[] from userland/filetest.asm */
#include "user_argv_blob.h"   /* GENERATED: user_argv_elf[] from userland/argv.asm */
#include "user_badptr_blob.h" /* GENERATED: user_badptr_elf[] from userland/badptr.asm */
#include "user_forktest_blob.h" /* GENERATED: user_forktest_elf[] from userland/forktest.asm */
#include "user_exectest_blob.h" /* GENERATED: user_exectest_elf[] from userland/exectest.asm */
#include "user_forkwait_blob.h" /* GENERATED: user_forkwait_elf[] from userland/forkwait.asm */
#include "user_fault_blob.h"  /* GENERATED: user_fault_elf[] from userland/fault.asm */
#include "user_stackgrow_blob.h" /* GENERATED: user_stackgrow_elf[] from userland/stackgrow.asm */
#include "user_cowtest_blob.h" /* GENERATED: user_cowtest_elf[] from userland/cowtest.asm */
#include "user_proctest_blob.h" /* GENERATED: user_proctest_elf[] from userland/proctest.asm */
#include "user_pipetest_blob.h" /* GENERATED: user_pipetest_elf[] from userland/pipetest.asm */
#include "user_stdiotest_blob.h" /* GENERATED: user_stdiotest_elf[] from userland/stdiotest.asm */
#include "user_sigtest_blob.h" /* GENERATED: user_sigtest_elf[] from userland/sigtest.asm */
#include "user_pipesrc_blob.h" /* GENERATED: user_pipesrc_elf[] from userland/pipesrc.asm */
#include "user_pipedst_blob.h" /* GENERATED: user_pipedst_elf[] from userland/pipedst.asm */
#include "user_readtest_blob.h" /* GENERATED: user_readtest_elf[] from userland/readtest.asm */
#include "user_siginttest_blob.h" /* GENERATED: user_siginttest_elf[] from userland/siginttest.asm */
#include "user_spintest_blob.h" /* GENERATED: user_spintest_elf[] from userland/spintest.asm */
#include "user_spinbare_blob.h" /* GENERATED: user_spinbare_elf[] from userland/spinbare.asm */
#include "user_usertest_blob.h" /* GENERATED: user_usertest_elf[] from userland/usertest.asm */
#include "user_cwdtest_blob.h" /* GENERATED: user_cwdtest_elf[] from userland/cwdtest.asm */
#include "user_rmtest_blob.h" /* GENERATED: user_rmtest_elf[] from userland/rmtest.asm */
#include "user_linktest_blob.h" /* GENERATED: user_linktest_elf[] from userland/linktest.asm */
#include "user_mmaptest_blob.h" /* GENERATED: user_mmaptest_elf[] from userland/mmaptest.asm */
#include "user_vmtest_blob.h" /* GENERATED: user_vmtest_elf[] from userland/vmtest.asm */
#include "user_stattest_blob.h" /* GENERATED: user_stattest_elf[] from userland/stattest.asm */
#include "user_dirtest_blob.h" /* GENERATED: user_dirtest_elf[] from userland/dirtest.asm */
#include "user_lseektest_blob.h" /* GENERATED: user_lseektest_elf[] from userland/lseektest.asm */
#include "user_trunctest_blob.h" /* GENERATED: user_trunctest_elf[] from userland/trunctest.asm */
#include "user_renametest_blob.h" /* GENERATED: user_renametest_elf[] from userland/renametest.asm */
#include "user_dirfdtest_blob.h" /* GENERATED: user_dirfdtest_elf[] from userland/dirfdtest.asm */
#include "user_dup2test_blob.h" /* GENERATED: user_dup2test_elf[] from userland/dup2test.asm */
#include "user_timetest_blob.h" /* GENERATED: user_timetest_elf[] from userland/timetest.asm */
#include "user_mtimetest_blob.h" /* GENERATED: user_mtimetest_elf[] from userland/mtimetest.asm */
#include "user_atimetest_blob.h" /* GENERATED: user_atimetest_elf[] from userland/atimetest.asm */
#include "user_ptimetest_blob.h" /* GENERATED: user_ptimetest_elf[] from userland/ptimetest.asm */

static int write_text(const char *path, const char *text) {
    return vfs_write_file(path, text, strlen(text), 0);
}

int ramfs_init(void) {
    vfs_init();

    vfs_mkdir("/bin");
    vfs_mkdir("/etc");
    vfs_mkdir("/proc");
    vfs_mkdir("/tmp");
    vfs_mkdir("/var");
    vfs_mkdir("/net");

    write_text("/etc/motd",
               "KHY OS ramfs online\n"
               "Commands: help ps mem ls cat run netstat netsend netrecv\n");

    write_text("/proc/version", "KHY OS 0.2.0 experimental microkernel\n");
    write_text("/net/if0", "name=lo0 state=UP mtu=1500\n");
    /* A real, runnable Ring 3 program: write()+getpid()+exit() via int 0x80.
     * `run /bin/init.elf` loads and executes it in user mode. */
    vfs_write_file("/bin/init.elf", user_init_elf, user_init_elf_len, 0);
    /* Ring 3 file-IO demo: creates+writes+reads back /disk/uf.txt. */
    vfs_write_file("/bin/filetest.elf", user_filetest_elf, user_filetest_elf_len, 0);
    /* Ring 3 argv demo: prints its argc/argv. Try: run /bin/argv.elf a b c */
    vfs_write_file("/bin/argv.elf", user_argv_elf, user_argv_elf_len, 0);
    /* Ring 3 hardening test: hands the kernel bad pointers; each is refused
     * (rc=-1) and the kernel stays alive. Try: run /bin/badptr.elf */
    vfs_write_file("/bin/badptr.elf", user_badptr_elf, user_badptr_elf_len, 0);
    /* Ring 3 fork demo: one int 0x80 returns twice — parent and child each
     * print a banner and exit. Try: run /bin/forktest.elf */
    vfs_write_file("/bin/forktest.elf", user_forktest_elf, user_forktest_elf_len, 0);
    /* Ring 3 exec demo: replaces its own image in place with /bin/argv.elf.
     * Try: run /bin/exectest.elf */
    vfs_write_file("/bin/exectest.elf", user_exectest_elf, user_exectest_elf_len, 0);
    /* Ring 3 fork+exit+wait demo: parent forks a child, child exits with code
     * 42, parent waits and prints it. Try: run /bin/forkwait.elf */
    vfs_write_file("/bin/forkwait.elf", user_forkwait_elf, user_forkwait_elf_len, 0);
    /* Ring 3 fault-isolation test: dereferences an unmapped pointer DIRECTLY (no
     * syscall), raising a real #PF from Ring 3. The kernel kills only this
     * process and the shell prompt returns. Try: run /bin/fault.elf */
    vfs_write_file("/bin/fault.elf", user_fault_elf, user_fault_elf_len, 0);
    /* Ring 3 demand-paging test: walks its stack pointer far below the initially
     * mapped region; the kernel grows the stack one page per fault instead of
     * killing it. Try: run /bin/stackgrow.elf */
    vfs_write_file("/bin/stackgrow.elf", user_stackgrow_elf, user_stackgrow_elf_len, 0);
    /* Ring 3 copy-on-write test: fork()s, the child mutates a shared global and
     * the parent verifies its own copy is untouched — proving fork shares pages
     * COW with correct isolation. Try: run /bin/cowtest.elf */
    vfs_write_file("/bin/cowtest.elf", user_cowtest_elf, user_cowtest_elf_len, 0);
    /* Ring 3 Phase 4 syscall test: exercises sbrk (heap growth), getppid
     * (parentage across fork) and kill (terminating a child + harvesting its
     * signal exit code 137). Try: run /bin/proctest.elf */
    vfs_write_file("/bin/proctest.elf", user_proctest_elf, user_proctest_elf_len, 0);
    /* Ring 3 Phase 5 pipe test: creates a pipe, forks, the parent streams a
     * message through the write end and the child reads it back intact —
     * proving inter-process byte streams. Try: run /bin/pipetest.elf */
    vfs_write_file("/bin/pipetest.elf", user_pipetest_elf, user_pipetest_elf_len, 0);
    /* Ring 3 Phase 7 stdio test: writes to stdout (fd 1) and stderr (fd 2) with
     * the ordinary fd-based write and reads stdin (fd 0, currently EOF) —
     * proving every process starts with the three standard streams on the
     * console. Try: run /bin/stdiotest.elf */
    vfs_write_file("/bin/stdiotest.elf", user_stdiotest_elf, user_stdiotest_elf_len, 0);
    /* Ring 3 Phase 8 signal test: installs a Ring 3 signal handler, sends itself
     * a catchable signal, and verifies the kernel ran the handler and then
     * resumed the interrupted code with registers intact — real signal delivery,
     * not just process termination. Try: run /bin/sigtest.elf */
    vfs_write_file("/bin/sigtest.elf", user_sigtest_elf, user_sigtest_elf_len, 0);
    /* Ring 3 Phase 9 pipeline halves: pipesrc writes a payload to stdout and
     * pipedst drains stdin until EOF. The shell wires them together for
     * `run /bin/pipesrc.elf | /bin/pipedst.elf`, redirecting pipesrc's fd 1 onto
     * a kernel pipe feeding pipedst's fd 0 — a real shell pipeline. */
    vfs_write_file("/bin/pipesrc.elf", user_pipesrc_elf, user_pipesrc_elf_len, 0);
    vfs_write_file("/bin/pipedst.elf", user_pipedst_elf, user_pipedst_elf_len, 0);
    /* Ring 3 Phase 10 stdin test: prints a prompt then blocks on read(fd 0)
     * until the console (PS/2 keyboard or serial) delivers bytes, echoing the
     * captured line back — proving fd 0 is a live input source, not an instant
     * EOF. Try: run /bin/readtest.elf  then type a line + Enter. */
    vfs_write_file("/bin/readtest.elf", user_readtest_elf, user_readtest_elf_len, 0);
    /* Ring 3 Phase 11 SIGINT test: installs a Ring 3 SIGINT handler, blocks on
     * read(fd 0), and proves a Ctrl-C typed at the console is turned into a real
     * SIGINT delivered to the handler — canonical tty behaviour. Try:
     * run /bin/siginttest.elf  then press Ctrl-C. */
    vfs_write_file("/bin/siginttest.elf", user_siginttest_elf, user_siginttest_elf_len, 0);
    /* Ring 3 Phase 12 IRQ-driven SIGINT test: installs a handler then burns CPU
     * in a tight loop with NO syscall, so Ctrl-C can only land via the keyboard
     * IRQ return path — proving CPU-bound programs are interruptible, not just
     * read-blocked ones. Try: run /bin/spintest.elf  then press Ctrl-C. */
    vfs_write_file("/bin/spintest.elf", user_spintest_elf, user_spintest_elf_len, 0);
    /* Ring 3 Phase 12 default-terminate test: a pure CPU spinner with NO handler.
     * A Ctrl-C must terminate it (exit 130 = 128+SIGINT) via task_exit() invoked
     * from the keyboard-IRQ return path. Try: run /bin/spinbare.elf then Ctrl-C. */
    vfs_write_file("/bin/spinbare.elf", user_spinbare_elf, user_spinbare_elf_len, 0);
    /* Ring 3 Phase 13 multi-user / DAC test: getuid as root, create+own a file,
     * chmod 0600, drop privilege via setuid(1000), then prove the now-foreign
     * file is denied and root cannot be regained. Try: run /bin/usertest.elf */
    vfs_write_file("/bin/usertest.elf", user_usertest_elf, user_usertest_elf_len, 0);
    /* Ring 3 Phase 15 working-directory test: getcwd starts at "/", chdir("/tmp")
     * moves it, a relative open lands inside /tmp (confirmed by an absolute open
     * of the same file), a bogus relative chdir is rejected, and chdir("..") pops
     * back to root. Try: run /bin/cwdtest.elf */
    vfs_write_file("/bin/cwdtest.elf", user_cwdtest_elf, user_cwdtest_elf_len, 0);
    /* Ring 3 Phase 16 filesystem-mutation test: symmetric create/delete for files
     * and directories — mkdir, chdir into it, rmdir (empty-only), unlink, and a
     * non-empty rmdir refusal. Try: run /bin/rmtest.elf */
    vfs_write_file("/bin/rmtest.elf", user_rmtest_elf, user_rmtest_elf_len, 0);
    /* Ring 3 Phase 17 symbolic-link test: creates a symlink, reads its target,
     * follows it for open/chdir, proves a dangling link is rejected and a
     * self-referential link fails with ELOOP instead of hanging, then cleans up.
     * Try: run /bin/linktest.elf */
    vfs_write_file("/bin/linktest.elf", user_linktest_elf, user_linktest_elf_len, 0);
    /* Ring 3 Phase 18 file-backed mmap test: maps /proc/version into memory and
     * reads its bytes back through the mapping, checks that bytes past EOF are
     * zero, and that an anonymous mapping is zero-filled and writable. Try:
     * run /bin/mmaptest.elf */
    vfs_write_file("/bin/mmaptest.elf", user_mmaptest_elf, user_mmaptest_elf_len, 0);
    /* Ring 3 Phase 19 VM-mutation test: maps a writable page, makes it read-only
     * with mprotect (a child's write then faults), and finally munmaps it (a
     * child's access then faults) — proving a process can re-protect and release
     * memory, not just acquire it. The parent survives and reports. Try:
     * run /bin/vmtest.elf */
    vfs_write_file("/bin/vmtest.elf", user_vmtest_elf, user_vmtest_elf_len, 0);

    /* Ring 3 Phase 20 metadata test: creates a file, directory and symlink, then
     * uses stat / lstat / fstat to read back each one's type, size and mode
     * without reading the contents — proving a program can inspect the tree the
     * way `ls -l` does. Try: run /bin/stattest.elf */
    vfs_write_file("/bin/stattest.elf", user_stattest_elf, user_stattest_elf_len, 0);

    /* Ring 3 Phase 21 directory-enumeration test: builds a fresh directory with a
     * file, a subdirectory and a symlink, then uses getdents to list it and
     * verify each entry's name, type and size — proving a userland program can
     * discover directory contents (the primitive behind `ls`). Try:
     * run /bin/dirtest.elf */
    vfs_write_file("/bin/dirtest.elf", user_dirtest_elf, user_dirtest_elf_len, 0);

    /* Ring 3 Phase 22 file-offset test: writes "0123456789" then uses lseek with
     * SEEK_SET / SEEK_CUR / SEEK_END to jump around the file and read back the
     * digit at each position — proving random access, not just sequential I/O.
     * Try: run /bin/lseektest.elf */
    vfs_write_file("/bin/lseektest.elf", user_lseektest_elf, user_lseektest_elf_len, 0);

    /* Ring 3 Phase 23 truncation test: writes "0123456789", shrinks it to 4 bytes
     * with ftruncate(fd) then grows it to 7 with truncate(path), verifying the
     * new sizes via fstat/stat and that the grown region reads back as zero. Try:
     * run /bin/trunctest.elf */
    vfs_write_file("/bin/trunctest.elf", user_trunctest_elf, user_trunctest_elf_len, 0);

    /* Ring 3 Phase 24 rename test: creates a file, moves it with rename and proves
     * the bytes followed the name, refuses to clobber an existing destination and
     * to move a directory, then renames a symlink and confirms its target text
     * moved intact. The last basic file-management primitive. Try:
     * run /bin/renametest.elf */
    vfs_write_file("/bin/renametest.elf", user_renametest_elf, user_renametest_elf_len, 0);

    /* Ring 3 Phase 25 directory-fd test: opens a directory as a descriptor and
     * pages through its entries with fgetdents (advancing a per-fd cursor), proving
     * a directory of any size is fully enumerable; also confirms a directory fd is
     * not byte-readable and that fstat reports it as a directory. Try:
     * run /bin/dirfdtest.elf */
    vfs_write_file("/bin/dirfdtest.elf", user_dirfdtest_elf, user_dirfdtest_elf_len, 0);

    /* Ring 3 Phase 26 descriptor-redirection test: opens two files, uses dup2 to
     * alias one descriptor onto another chosen number, writes through the target
     * and proves the bytes reached the source file, that the other file is left
     * intact, and that the same-fd no-op and bad-source paths behave. The
     * primitive behind shell redirection (`cmd > file`). Try: run /bin/dup2test.elf */
    vfs_write_file("/bin/dup2test.elf", user_dup2test_elf, user_dup2test_elf_len, 0);

    /* Ring 3 Phase 27 wall-clock test: reads the current Unix epoch time twice
     * with the time syscall, checks the value is a plausible calendar time
     * (not boot-relative ticks) and that the second read does not run backwards,
     * proving the kernel exposes real wall-clock time. Try: run /bin/timetest.elf */
    vfs_write_file("/bin/timetest.elf", user_timetest_elf, user_timetest_elf_len, 0);

    /* Ring 3 Phase 28 file-timestamp test: brackets a file write between two
     * time() reads and checks the file's st_mtime falls in that window, proving
     * each file carries its real last-modification wall-clock time, and that a
     * later write never moves it backwards. Try: run /bin/mtimetest.elf */
    vfs_write_file("/bin/mtimetest.elf", user_mtimetest_elf, user_mtimetest_elf_len, 0);

    /* Ring 3 Phase 29 access/status-time test: completes the POSIX timestamp triple
     * (atime/mtime/ctime). Proves a read bumps only atime and a chmod bumps only
     * ctime — in both cases mtime stays byte-identical — so each operation touches
     * exactly the timestamp POSIX says it should. Try: run /bin/atimetest.elf */
    vfs_write_file("/bin/atimetest.elf", user_atimetest_elf, user_atimetest_elf_len, 0);

    /* Ring 3 Phase 30 timestamp-persistence test: proves a file's mtime survives
     * a reboot (restored from KhyFS) instead of being reborn as "now" at mount.
     * Two-phase via a /disk marker; needs a persistent disk (run-disk). Try a
     * first boot then a second on the same -hda image: run /bin/ptimetest.elf */
    vfs_write_file("/bin/ptimetest.elf", user_ptimetest_elf, user_ptimetest_elf_len, 0);

    serial_print("[RAMFS] Root filesystem initialized\n");
    return 0;
}
