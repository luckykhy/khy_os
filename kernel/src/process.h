/* process.h — Kernel process model * @pattern Strategy
 */
#ifndef PROCESS_H
#define PROCESS_H

#include <stddef.h>
#include <stdint.h>

#define PROCESS_MAX       32
#define PROCESS_NAME_MAX  32
#define PROCESS_MAX_ARGS  16

/* Signal model (Phase 8). Numbers 1..PROCESS_SIG_MAX-1 are usable; SIGKILL is
 * never catchable and always takes the default (terminate) action. */
#define PROCESS_SIG_MAX   32
#define PROCESS_SIGINT     2
#define PROCESS_SIGKILL    9

enum process_state {
    PROCESS_UNUSED  = 0,
    PROCESS_READY   = 1,
    PROCESS_RUNNING = 2,
    PROCESS_ZOMBIE  = 3,
};

struct process_info {
    uint32_t pid;
    uint32_t task_id;
    uint8_t  state;
    uint8_t  is_user;
    uint64_t entry;
    uint64_t user_stack_top;
    uint64_t brk;
    char name[PROCESS_NAME_MAX];
};

void process_init(void);
int process_register_kernel_task(const char *name, int task_id);
/* Release the process-table slot bound to a scheduler task (called by the
 * scheduler when it reaps a finished/zombie task). No-op if not registered. */
void process_unregister_task(int task_id);
int process_create_from_elf(const char *path);
/* Like process_create_from_elf but seeds the SysV x86-64 argument vector on the
 * new program's user stack: at _start, [rsp]=argc, [rsp+8]=argv[0], ...,
 * argv[argc]=NULL, then an empty envp (single NULL). argv[0] is conventionally
 * the program name/path. argc is clamped to PROCESS_MAX_ARGS. */
int process_create_from_elf_argv(const char *path, int argc, const char *const argv[]);
int process_create_from_pe(const char *path);
int process_create_from_image(const char *path); /* Auto-detect ELF/PE by magic bytes */

/* fork(): duplicate the calling process into a child with a full copy of its
 * address space. `parent_ctx` is the parent's captured Ring 3 trap state; the
 * child resumes from it with rax=0. Returns the child pid to the parent, or -1
 * on failure. Built on vmm_clone_space + sched_fork_user_task. */
struct user_context;
int process_fork(const struct user_context *parent_ctx);

/* exec(): replace the calling process's image in place with the ELF at `path`,
 * seeding argc/argv on a fresh user stack (argv[0] is conventionally the path).
 * The pid and scheduler task are preserved; the old address space is freed.
 * Returns a negative error code on failure (the caller keeps running); on
 * success it never returns — the task drops into the new program. */
int process_exec(const char *path, int argc, const char *const argv[]);
int process_mark_exited(uint32_t pid, int exit_code);

/* wait(): reap one ZOMBIE child of `parent`. If `want_pid` != 0, restrict to
 * that specific child (used by the shell to wait on a foreground program).
 * Returns the child's pid (> 0) and writes its exit code to *code_out after
 * freeing the zombie slot; returns 0 if `parent` has matching child(ren) that
 * haven't exited yet (caller should yield and retry); returns -1 if `parent`
 * has no matching child at all. */
int process_reap_child(uint32_t parent, uint32_t want_pid, int *code_out);
uint32_t process_current_pid(void);

/* getppid(): the parent pid of the calling process (0 once reparented to the
 * kernel or for the kernel task itself). */
uint32_t process_parent_pid(void);

/* sbrk(): move the calling process's program break by `increment` bytes,
 * backing newly exposed pages with zeroed user memory on growth. Returns the
 * PREVIOUS break on success (so sbrk(0) reports the current break), or -1 on a
 * bad/oversized request or out-of-memory. Shrinking lowers the break without
 * unmapping; the pages are reclaimed at exit. */
long process_sbrk(long increment);

/* kill(): deliver `sig` to process `pid`. A catchable signal (1..31, not
 * SIGKILL) for which the target has installed a Ring 3 handler is marked pending
 * and delivered when the target next returns to user mode (synchronously for a
 * self-kill); otherwise the default action terminates the target (exit code
 * 128+sig). sig 0 is an existence probe that touches nothing. Killing self with
 * no handler exits and does not return. Returns 0 on success, -1 if `pid` is
 * 0/unknown/already a zombie. */
int process_kill(uint32_t pid, int sig);

/* sigaction(): install (or clear, handler==0) a Ring 3 handler for `signum` on
 * the calling process, plus the user-space restorer trampoline the kernel parks
 * as the handler's return address. Rejects signum 0, out-of-range, or SIGKILL.
 * Returns 0 on success, -1 otherwise. */
int process_sigaction(int signum, uint64_t handler, uint64_t restorer);

/* Drain one deliverable pending signal from the calling process: the lowest
 * pending signal, regardless of whether it has a handler. Clears its pending
 * bit and outputs the handler + restorer addresses (handler == 0 means no Ring 3
 * handler is installed, so the caller must apply the default action). Returns
 * the signal number (> 0), or 0 if nothing is pending. Drives signal delivery on
 * the syscall and IRQ return-to-user paths. */
int process_take_pending_signal(uint64_t *handler_out, uint64_t *restorer_out);

/* Foreground process for console signals. The shell records the user program it
 * launched and is waiting on; the keyboard IRQ targets this pid when the user
 * types the INTR character (Ctrl-C). 0 means "no foreground program" (the shell
 * is at its prompt), so Ctrl-C is left to the shell's own line editor. The shell
 * is a kernel task and is never itself a foreground pid, so it cannot be
 * signalled to death by Ctrl-C. */
void process_set_foreground(uint32_t pid);
uint32_t process_foreground(void);

/* Raise a catchable signal on `pid` from interrupt context (the keyboard IRQ).
 * Only sets the pending bit — no scheduler manipulation — so it is safe to call
 * with interrupts off inside an ISR. The signal is acted on (handler or default
 * terminate) when the target next returns to user mode. Returns 0 if the bit was
 * set, -1 for an invalid signal or a dead/unknown pid. */
int process_raise_signal(uint32_t pid, int sig);

/* User identity (Phase 13 — DAC). Each process carries a real and effective
 * uid/gid; access checks use the effective ids. The kernel and all kernel tasks
 * run as root (0); a newly created or forked process inherits its creator's /
 * parent's ids, and exec preserves them. */
uint32_t process_current_uid(void);
uint32_t process_current_gid(void);
uint32_t process_current_euid(void);
uint32_t process_current_egid(void);

/* setuid/setgid: root (euid 0) sets both the real and effective id to `id`. A
 * non-root process may only set its id to a value it already holds (its real or
 * effective id) — it can drop privilege but never regain it. Returns 0 on
 * success, -1 if there is no current user process or the change is forbidden. */
int process_set_uid(uint32_t uid);
int process_set_gid(uint32_t gid);

/* Working directory (Phase 15). process_get_cwd copies the current context's cwd
 * (the running process's, or the kernel/shell cwd for the pid-0 context) into
 * `out`. process_set_cwd replaces it with the already-resolved absolute path
 * `abs` (the caller must have verified it is a directory); returns 0, or -1 if
 * `abs` is not absolute. Children inherit the cwd on create/fork. */
void process_get_cwd(char *out, size_t sz);
int process_set_cwd(const char *abs);

size_t process_list(struct process_info *out, size_t max);
const char *process_state_string(uint8_t state);

#endif
