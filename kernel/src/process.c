/* process.c — Kernel process model * @pattern Prototype
 */

#include "process.h"
#include "agentevent.h"
#include "elf.h"
#include "pe.h"
#include "wincompat.h"
#include "kheap.h"
#include "sched.h"
#include "serial.h"
#include "string.h"
#include "syscall.h"
#include "vfs.h"
#include "vmm.h"

/* Largest heap change a single sbrk() call may request (grow or shrink). Caps a
 * Ring 3 program's per-call appetite so it cannot drain physical memory or jump
 * the heap into the stack window in one step. */
#define PROCESS_SBRK_MAX (16ULL * 1024 * 1024)

struct process {
    uint32_t pid;
    uint32_t parent_pid;
    int task_id;
    uint8_t state;
    uint8_t is_user;
    int exit_code;
    uint64_t entry;
    uint64_t user_stack_top;
    uint64_t brk;
    char name[PROCESS_NAME_MAX];
    struct vm_space *space;
    uint64_t sig_handler[PROCESS_SIG_MAX]; /* Ring 3 handler VA per signal (0 = default) */
    uint64_t sig_restorer;                 /* SA_RESTORER-style trampoline VA */
    uint32_t sig_pending;                  /* bitmask of pending catchable signals */
    uint32_t uid, gid;                     /* real user / group id (Phase 13 DAC) */
    uint32_t euid, egid;                   /* effective ids — used for access checks */
    char cwd[VFS_PATH_MAX];                /* current working directory (Phase 15) */
};

static struct process process_table[PROCESS_MAX];
static uint32_t task_to_pid[MAX_TASKS];
static uint32_t next_pid = 1;
static int process_ready;

/* Working directory for contexts with no struct process — chiefly the kernel
 * shell task (pid 0). New processes spawned by the shell inherit it, so a
 * `cd` at the prompt is the cwd a subsequently `run` program starts in. */
static char kernel_cwd[VFS_PATH_MAX] = "/";

/* Ring 3 entry trampoline (boot/usermode.asm): builds an iretq frame and drops
 * to CPL=3. process_exec uses it to launch the new image in place. */
extern void enter_usermode(uint64_t user_rip, uint64_t user_rsp);

static void copy_name(char dst[PROCESS_NAME_MAX], const char *src) {
    size_t i = 0;
    if (!src) {
        dst[0] = '\0';
        return;
    }
    while (src[i] && i + 1 < PROCESS_NAME_MAX) {
        dst[i] = src[i];
        i++;
    }
    dst[i] = '\0';
}

/* Copy a path into a VFS_PATH_MAX field, defaulting to "/" for a NULL/empty src. */
static void copy_path_field(char dst[VFS_PATH_MAX], const char *src) {
    if (!src || src[0] == '\0') {
        dst[0] = '/';
        dst[1] = '\0';
        return;
    }
    size_t i = 0;
    while (src[i] && i + 1 < VFS_PATH_MAX) {
        dst[i] = src[i];
        i++;
    }
    dst[i] = '\0';
}

static struct process *find_by_pid(uint32_t pid) {
    for (int i = 0; i < PROCESS_MAX; i++) {
        if (process_table[i].state != PROCESS_UNUSED && process_table[i].pid == pid)
            return &process_table[i];
    }
    return 0;
}

static int alloc_slot(void) {
    for (int i = 0; i < PROCESS_MAX; i++) {
        if (process_table[i].state == PROCESS_UNUSED)
            return i;
    }
    return -1;
}

/* Build the SysV x86-64 initial process stack inside `space`'s (already mapped)
 * user stack. The argument strings are copied just below VMM_USER_STACK_TOP and
 * the pointer block is laid out below them so that, at _start:
 *   [rsp]            = argc
 *   [rsp+8 + 8*i]    = argv[i]          (i in 0..argc-1)
 *   [rsp+8 + 8*argc] = NULL             (argv terminator)
 *   next word        = NULL             (empty envp)
 * Returns the user rsp (16-byte aligned) to launch at, or 0 on failure. */
static uint64_t setup_user_args(struct vm_space *space, int argc, const char *const argv[]) {
    if (argc < 0)
        argc = 0;
    if (argc > PROCESS_MAX_ARGS)
        argc = PROCESS_MAX_ARGS;

    uint64_t arg_va[PROCESS_MAX_ARGS];
    uint64_t sp = VMM_USER_STACK_TOP;

    /* 1. Copy each argument string to the top of the stack (top-down). */
    for (int i = argc - 1; i >= 0; i--) {
        const char *s = (argv && argv[i]) ? argv[i] : "";
        size_t len = strlen(s) + 1;
        sp -= len;
        if (vmm_copy_to_user(space, sp, s, len) != 0)
            return 0;
        arg_va[i] = sp;
    }

    /* 2. Reserve the pointer block below the strings, 16-aligning the final
     *    rsp. Block = argc(1) + argv[](argc) + argv NULL(1) + envp NULL(1). */
    sp &= ~0xFULL;
    uint64_t words = (uint64_t)argc + 3;
    uint64_t rsp = (sp - words * 8) & ~0xFULL;

    /* 3. Write argc, the argv pointer array, its NULL terminator, and an empty
     *    envp NULL — in ascending address order from rsp. */
    uint64_t slot = rsp;
    uint64_t value = (uint64_t)argc;
    if (vmm_copy_to_user(space, slot, &value, 8) != 0)
        return 0;
    slot += 8;
    for (int i = 0; i < argc; i++) {
        if (vmm_copy_to_user(space, slot, &arg_va[i], 8) != 0)
            return 0;
        slot += 8;
    }
    value = 0;
    if (vmm_copy_to_user(space, slot, &value, 8) != 0) /* argv terminator */
        return 0;
    slot += 8;
    if (vmm_copy_to_user(space, slot, &value, 8) != 0) /* empty envp */
        return 0;

    return rsp;
}

void process_init(void) {
    memset(process_table, 0, sizeof(process_table));
    for (int i = 0; i < MAX_TASKS; i++)
        task_to_pid[i] = 0;

    process_table[0].pid = 0;
    process_table[0].task_id = 0;
    process_table[0].state = PROCESS_RUNNING;
    process_table[0].is_user = 0;
    process_table[0].space = vmm_kernel_space();
    copy_name(process_table[0].name, "kernel");
    copy_path_field(process_table[0].cwd, "/");   /* kernel/shell starts at root */
    task_to_pid[0] = 0;

    process_ready = 1;
    serial_print("[PROC] Process manager initialized\n");
}

int process_register_kernel_task(const char *name, int task_id) {
    if (!process_ready || task_id < 0 || task_id >= MAX_TASKS)
        return -1;

    int slot = alloc_slot();
    if (slot < 0)
        return -2;

    uint32_t pid = next_pid++;
    struct process *p = &process_table[slot];
    memset(p, 0, sizeof(*p));
    p->pid = pid;
    p->task_id = task_id;
    p->state = PROCESS_READY;
    p->is_user = 0;
    p->space = vmm_kernel_space();
    copy_name(p->name, name ? name : "kthread");
    task_to_pid[task_id] = pid;
    return (int)pid;
}

void process_unregister_task(int task_id) {
    if (task_id <= 0 || task_id >= MAX_TASKS)
        return; /* never unregister the kernel/idle task (id 0) */

    uint32_t pid = task_to_pid[task_id];
    task_to_pid[task_id] = 0;

    for (int i = 0; i < PROCESS_MAX; i++) {
        if (process_table[i].state != PROCESS_UNUSED &&
            process_table[i].task_id == task_id && process_table[i].pid == pid) {
            /* Reclaim a user process's address space now that the scheduler has
             * switched CR3 away from it (this runs inside _reap_zombies, on a
             * different task). Kernel tasks share the kernel space and must not
             * free it. */
            struct process *p = &process_table[i];
            if (p->is_user && p->space && p->space != vmm_kernel_space())
                vmm_destroy_space(p->space);
            p->space = NULL;

            if (p->state == PROCESS_ZOMBIE && p->parent_pid != 0) {
                /* The process exited and still has a parent that may wait() on
                 * it. Keep the table entry as a zombie holding pid + exit_code;
                 * only its task slot and address space are gone (task_id = -1).
                 * process_reap_child() frees the slot when the parent waits. */
                p->task_id = -1;
            } else {
                /* No waiter — a kernel task, or an orphan already reparented to
                 * pid 0. Free the slot outright. */
                memset(p, 0, sizeof(*p));
                p->state = PROCESS_UNUSED;
            }
            return;
        }
    }
}

int process_create_from_elf(const char *path) {
    const char *argv[1];
    argv[0] = path;
    return process_create_from_elf_argv(path, 1, argv);
}

int process_create_from_elf_argv(const char *path, int argc, const char *const argv[]) {
    if (!process_ready || !path)
        return -1;

    size_t image_size = 0;
    if (vfs_get_size(path, &image_size) != 0 || image_size == 0)
        return -2;
    if (image_size > (2 * 1024 * 1024))
        return -3;

    uint8_t *image = (uint8_t *)kmalloc(image_size);
    if (!image)
        return -4;

    int n = vfs_read_file(path, image, image_size);
    if (n < 0 || (size_t)n != image_size) {
        kfree(image);
        return -5;
    }

    struct vm_space *space = vmm_create_user_space();
    if (!space) {
        kfree(image);
        return -6;
    }

    struct elf_image loaded;
    int rc = elf_load_user_image(image, image_size, space, &loaded);
    kfree(image);
    if (rc != 0) {
        vmm_destroy_space(space);
        return -7;
    }

    const size_t stack_size = 4 * VMM_PAGE_SIZE;
    uint64_t stack_bottom = VMM_USER_STACK_TOP - stack_size;
    rc = vmm_map_anonymous(space, stack_bottom, stack_size,
                           VMM_FLAG_PRESENT | VMM_FLAG_USER | VMM_FLAG_WRITABLE | VMM_FLAG_NO_EXEC);
    if (rc != 0) {
        vmm_destroy_space(space);
        return -8;
    }

    /* Seed argc/argv on the freshly mapped user stack; user_rsp is where the
     * program's _start sees its argument vector. */
    uint64_t user_rsp = setup_user_args(space, argc, argv);
    if (user_rsp == 0) {
        vmm_destroy_space(space);
        return -8;
    }

    /* [SAFE] Claim the process slot, issue the pid, initialise the entry, and
     * bind the scheduler task as ONE interrupt-masked operation. The previous
     * code ran alloc_slot() and the slot's first state write (PROCESS_READY)
     * OUTSIDE the cli section, but alloc_slot() only TESTS state==UNUSED — it
     * does not reserve the slot. This function is reached from the shell, which
     * runs as a kernel task with interrupts ENABLED, so a timer preemption
     * between the test and the state write let a concurrent fork() (an IF=0
     * syscall, atomic on its own) claim the SAME still-UNUSED slot: two
     * processes would then share one table entry (the create's later memset
     * would clobber the forked child's record — duplicate-pid confusion, a
     * leaked/double-freed child address space). Doing the claim, the
     * next_pid++ issuance, and the task→pid binding under one cli section makes
     * the slot non-UNUSED before interrupts can resume, so a racing alloc_slot()
     * skips it; pid issuance is likewise serialized. The body is bounded and
     * calls nothing that blocks. */
    uint64_t flags;
    __asm__ volatile("pushfq; pop %0; cli" : "=r"(flags) :: "memory");

    int slot = alloc_slot();
    if (slot < 0) {
        __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");
        vmm_destroy_space(space);
        return -9;
    }

    uint32_t pid = next_pid++;
    struct process *p = &process_table[slot];
    memset(p, 0, sizeof(*p));
    p->pid = pid;
    p->parent_pid = process_current_pid(); /* whoever ran us (e.g. the shell) */
    p->task_id = -1;
    p->state = PROCESS_READY;              /* claims the slot: no longer UNUSED */
    p->is_user = 1;
    p->entry = loaded.entry;
    p->user_stack_top = VMM_USER_STACK_TOP;
    p->brk = loaded.brk;
    p->space = space;
    copy_name(p->name, path);

    /* Inherit the launching process's user identity (the shell runs as root, so
     * programs start as root and may drop privilege via setuid). */
    struct process *creator = find_by_pid(p->parent_pid);
    if (creator) {
        p->uid = creator->uid;   p->gid = creator->gid;
        p->euid = creator->euid; p->egid = creator->egid;
    }

    /* Inherit the working directory from the creator, or from the kernel/shell
     * cwd when launched by the pid-0 kernel task (which has no process slot). */
    copy_path_field(p->cwd, creator ? creator->cwd : kernel_cwd);

    /* Create the Ring 3 scheduler task that actually executes this image. The
     * task is born TASK_READY, so with preemption live it could be dispatched
     * (and even reach SYSCALL_EXIT) before we record its task->pid binding —
     * which would make process_current_pid() resolve to the kernel (pid 0) and
     * mark the wrong process exited. Still inside the cli section so the slot is
     * created and bound atomically before the scheduler can ever select it. */
    int tid = sched_create_user_task(loaded.entry, user_rsp, space, p->name);
    if (tid >= 0) {
        task_to_pid[tid] = pid;
        p->task_id = tid;
        /* Event plane (stage A6): announce the new process. Enqueue-only (no
         * I/O), safe inside this cli section; the bridge task transmits later. */
        agentevent_post(AGENTEVENT_SPAWN, pid, p->parent_pid, tid, p->name);
    }

    __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");

    if (tid < 0) {
        /* No free task slot: tear down the half-built process. */
        vmm_destroy_space(space);
        memset(p, 0, sizeof(*p));
        p->state = PROCESS_UNUSED;
        return -10;
    }

    serial_print("[PROC] Loaded user process pid=");
    serial_print_dec(pid);
    serial_print(" tid=");
    serial_print_dec((uint64_t)tid);
    serial_print(" path=");
    serial_print(path);
    serial_print("\n");
    return (int)pid;
}

int process_fork(const struct user_context *parent_ctx) {
    struct task *cur = sched_current_task();
    if (!cur || !cur->space)
        return -1;
    uint32_t parent_pid = process_current_pid();
    if (parent_pid == 0)
        return -1; /* the kernel/idle task cannot fork */

    /* Full copy of the parent's address space (image, stack, heap). */
    struct vm_space *child_space = vmm_clone_space(cur->space);
    if (!child_space)
        return -1;

    int slot = alloc_slot();
    if (slot < 0) {
        vmm_destroy_space(child_space);
        return -1;
    }

    struct process *parent = find_by_pid(parent_pid);
    uint32_t pid = next_pid++;
    struct process *p = &process_table[slot];
    memset(p, 0, sizeof(*p));
    p->pid = pid;
    p->parent_pid = parent_pid;
    p->task_id = -1;
    p->state = PROCESS_READY;
    p->is_user = 1;
    p->entry = parent ? parent->entry : 0;
    p->user_stack_top = parent ? parent->user_stack_top : VMM_USER_STACK_TOP;
    p->brk = parent ? parent->brk : 0;
    p->space = child_space;
    copy_name(p->name, parent ? parent->name : "forked");

    /* Inherit the parent's installed signal handlers + restorer (Unix fork
     * semantics); pending signals are NOT inherited (memset already cleared
     * sig_pending). */
    if (parent) {
        for (int s = 0; s < PROCESS_SIG_MAX; s++)
            p->sig_handler[s] = parent->sig_handler[s];
        p->sig_restorer = parent->sig_restorer;
        /* Inherit the parent's user identity (Unix fork semantics). */
        p->uid = parent->uid;   p->gid = parent->gid;
        p->euid = parent->euid; p->egid = parent->egid;
    }
    /* Inherit the working directory (Unix fork semantics). */
    copy_path_field(p->cwd, parent ? parent->cwd : "/");

    /* The child resumes from the same int 0x80 as the parent, but fork()
     * returns 0 in the child. */
    struct user_context ctx = *parent_ctx;
    ctx.rax = 0;

    /* Same atomicity requirement as process_create_from_elf_argv: the child is
     * born TASK_READY and could be scheduled (and exit) before we bind its
     * task→pid mapping. Create and bind it under a cli critical section. */
    uint64_t flags;
    __asm__ volatile("pushfq; pop %0; cli" : "=r"(flags) :: "memory");

    int tid = sched_fork_user_task(child_space, &ctx, p->name);
    if (tid >= 0) {
        task_to_pid[tid] = pid;
        p->task_id = tid;
        /* Duplicate the parent's open descriptors into the child before it can
         * be scheduled (Unix fork semantics: shared file offsets, pipe ends
         * gain a second holder). Done inside the cli section for the same
         * race-freedom reason as the task→pid binding above. */
        syscall_fork_fds(parent_pid, pid);
        /* Event plane (stage A6): a fork is also a process birth — announce the
         * child. Enqueue-only, safe inside this cli section. */
        agentevent_post(AGENTEVENT_SPAWN, pid, parent_pid, tid, p->name);
    }

    __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");

    if (tid < 0) {
        vmm_destroy_space(child_space);
        memset(p, 0, sizeof(*p));
        p->state = PROCESS_UNUSED;
        return -1;
    }

    serial_print("[PROC] fork: parent pid=");
    serial_print_dec(parent_pid);
    serial_print(" -> child pid=");
    serial_print_dec(pid);
    serial_print(" tid=");
    serial_print_dec((uint64_t)tid);
    serial_print("\n");
    return (int)pid; /* parent's fork() return value */
}

int process_exec(const char *path, int argc, const char *const argv[]) {
    if (!process_ready || !path)
        return -1;

    /* exec only replaces a running Ring 3 process — never the kernel/idle task. */
    struct task *cur = sched_current_task();
    if (!cur || !cur->is_user || !cur->space)
        return -1;
    uint32_t pid = process_current_pid();
    if (pid == 0)
        return -1;

    /* 1. Read the new program image. It lands in the kernel heap, which lives in
     *    the shared kernel half of every address space, so it survives the CR3
     *    swap at commit time. */
    size_t image_size = 0;
    if (vfs_get_size(path, &image_size) != 0 || image_size == 0)
        return -2;
    if (image_size > (2 * 1024 * 1024))
        return -3;

    uint8_t *image = (uint8_t *)kmalloc(image_size);
    if (!image)
        return -4;

    int n = vfs_read_file(path, image, image_size);
    if (n < 0 || (size_t)n != image_size) {
        kfree(image);
        return -5;
    }

    /* 2. Build a brand-new address space and lay the image + stack + argv into
     *    it. The caller's old space stays active (and untouched) until commit,
     *    so any failure up to here is fully recoverable — we just free the new
     *    space and return an error, leaving the caller running. */
    struct vm_space *new_space = vmm_create_user_space();
    if (!new_space) {
        kfree(image);
        return -6;
    }

    struct elf_image loaded;
    int rc = elf_load_user_image(image, image_size, new_space, &loaded);
    kfree(image);
    if (rc != 0) {
        vmm_destroy_space(new_space);
        return -7;
    }

    const size_t stack_size = 4 * VMM_PAGE_SIZE;
    uint64_t stack_bottom = VMM_USER_STACK_TOP - stack_size;
    rc = vmm_map_anonymous(new_space, stack_bottom, stack_size,
                           VMM_FLAG_PRESENT | VMM_FLAG_USER | VMM_FLAG_WRITABLE | VMM_FLAG_NO_EXEC);
    if (rc != 0) {
        vmm_destroy_space(new_space);
        return -8;
    }

    uint64_t user_rsp = setup_user_args(new_space, argc, argv);
    if (user_rsp == 0) {
        vmm_destroy_space(new_space);
        return -8;
    }

    /* 3. Commit — the point of no return. Re-point the current task at the new
     *    space, update its process-table entry, switch CR3, then free the old
     *    space (CR3 no longer references it) and drop into the new image. Do it
     *    under cli so the scheduler can't observe a half-updated task/process;
     *    enter_usermode's iretq re-enables interrupts (RFLAGS=0x202). */
    uint64_t flags;
    __asm__ volatile("pushfq; pop %0; cli" : "=r"(flags) :: "memory");

    struct vm_space *old_space = cur->space;

    cur->space      = new_space;
    cur->user_entry = loaded.entry;
    cur->user_stack = user_rsp;
    cur->is_fork    = 0; /* no longer resuming a forked context */

    struct process *p = find_by_pid(pid);
    if (p) {
        p->entry          = loaded.entry;
        p->user_stack_top = VMM_USER_STACK_TOP;
        p->brk            = loaded.brk;
        p->space          = new_space;
        copy_name(p->name, path);
        /* exec resets caught signals to their default disposition (Unix
         * semantics): the new image never installed these handlers. */
        for (int s = 0; s < PROCESS_SIG_MAX; s++)
            p->sig_handler[s] = 0;
        p->sig_restorer = 0;
        p->sig_pending = 0;
    }

    vmm_switch_space(new_space);
    if (old_space && old_space != vmm_kernel_space())
        vmm_destroy_space(old_space);

    serial_print("[PROC] exec: pid=");
    serial_print_dec(pid);
    serial_print(" -> ");
    serial_print(path);
    serial_print("\n");

    (void)flags; /* intentionally not restored: enter_usermode never returns */
    enter_usermode(loaded.entry, user_rsp);
    return 0; /* unreachable */
}

int process_mark_exited(uint32_t pid, int exit_code) {
    uint64_t flags;
    __asm__ volatile("pushfq; pop %0; cli" : "=r"(flags) :: "memory");

    struct process *p = find_by_pid(pid);
    if (!p) {
        __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");
        return -1;
    }

    p->state = PROCESS_ZOMBIE;
    p->exit_code = exit_code;
    /* Close every descriptor the dying process held. This releases any pipe
     * ends so a peer blocked on the other side observes EOF (reader) or EPIPE
     * (writer) instead of hanging forever. Pure bookkeeping — touches no user
     * memory — so it is safe here in the exiting (or killer's) context. */
    syscall_release_fds(pid);
    /* Do NOT free the address space here: SYSCALL_EXIT runs on the exiting task
     * with this very space as the active CR3, so its page tables are still in
     * use. The space is destroyed in process_unregister_task() at reap time,
     * after the scheduler has switched CR3 away. */

    /* Reparent this process's children to pid 0 (kernel). A child that has
     * already exited (lingering zombie) now has no one to wait on it, so free
     * its slot immediately to avoid a leak; a live child just loses its parent
     * and will be auto-reaped (not lingered) when it exits. */
    for (int i = 0; i < PROCESS_MAX; i++) {
        struct process *c = &process_table[i];
        if (c->state == PROCESS_UNUSED || c->parent_pid != pid)
            continue;
        if (c->state == PROCESS_ZOMBIE && c->task_id < 0) {
            memset(c, 0, sizeof(*c));
            c->state = PROCESS_UNUSED;
        } else {
            c->parent_pid = 0;
        }
    }

    /* Event plane (stage A6): notify the agent that this process exited. O(1)
     * enqueue only — no I/O — so it is safe inside this cli section; the bridge
     * task drains and transmits later. A fault-killed process emits this EXIT
     * (exit_code = 128+vector) in addition to the FAULT event the trap path
     * posts, so the agent sees both the cause and the lifecycle end. */
    agentevent_post(AGENTEVENT_EXIT, pid, (uint32_t)p->task_id, exit_code, p->name);

    __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");
    return 0;
}

int process_reap_child(uint32_t parent, uint32_t want_pid, int *code_out) {
    uint64_t flags;
    __asm__ volatile("pushfq; pop %0; cli" : "=r"(flags) :: "memory");

    int has_live = 0;   /* a matching child exists but isn't reapable yet */
    int result = -1;    /* no matching child at all */

    for (int i = 0; i < PROCESS_MAX; i++) {
        struct process *c = &process_table[i];
        if (c->state == PROCESS_UNUSED || c->parent_pid != parent)
            continue;
        if (want_pid && c->pid != want_pid)
            continue;

        /* A zombie whose task has been reaped (task_id < 0, address space freed)
         * is ready to harvest. A zombie whose task isn't reaped yet, or a still-
         * running child, counts as "alive" — the caller should wait and retry. */
        if (c->state == PROCESS_ZOMBIE && c->task_id < 0) {
            if (code_out)
                *code_out = c->exit_code;
            uint32_t cpid = c->pid;
            memset(c, 0, sizeof(*c));
            c->state = PROCESS_UNUSED;
            result = (int)cpid;
            break;
        }
        has_live = 1;
    }

    if (result < 0)
        result = has_live ? 0 : -1;

    __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");
    return result;
}

uint32_t process_current_pid(void) {
    int tid = sched_current_id();
    if (tid < 0 || tid >= MAX_TASKS)
        return 0;
    return task_to_pid[tid];
}

uint32_t process_parent_pid(void) {
    struct process *p = find_by_pid(process_current_pid());
    return p ? p->parent_pid : 0;
}

long process_sbrk(long increment) {
    uint32_t pid = process_current_pid();
    struct process *p = find_by_pid(pid);
    struct task *t = sched_current_task();
    if (pid == 0 || !p || !t || !t->space || p->brk == 0)
        return -1;

    uint64_t old_brk = p->brk;
    if (increment == 0)
        return (long)old_brk;

    /* Bound the new break to the caller's own user window and cap a single
     * request so a Ring 3 program cannot drain physical memory or push the heap
     * into the stack region with one call. */
    if (increment > (long)PROCESS_SBRK_MAX || increment < -(long)PROCESS_SBRK_MAX)
        return -1;
    uint64_t new_brk = old_brk + (uint64_t)increment;
    if (new_brk < VMM_USER_BASE || new_brk > VMM_USER_LIMIT)
        return -1;

    if (increment > 0) {
        /* Map every page in [old_brk, new_brk) that isn't backed yet. The page
         * containing old_brk may already be mapped (a previous partial-page
         * grow), so probe each page and only allocate the missing ones. On
         * failure, leave brk where it was — the already-mapped pages are tracked
         * by the space and reclaimed at exit, so this is safe, not a leak. */
        uint64_t first = old_brk & ~0xFFFULL;
        uint64_t last = (new_brk - 1) & ~0xFFFULL;
        for (uint64_t va = first; va <= last; va += VMM_PAGE_SIZE) {
            if (vmm_translate(t->space, va) != 0)
                continue;
            uint64_t phys = vmm_alloc_owned_page(t->space);
            if (!phys)
                return -1;
            if (vmm_map_page(t->space, va, phys,
                             VMM_FLAG_PRESENT | VMM_FLAG_USER | VMM_FLAG_WRITABLE | VMM_FLAG_NO_EXEC) != 0)
                return -1;
        }
    }
    /* Shrinking only lowers the break; the freed pages stay mapped and are
     * reclaimed at process exit. Keeps the implementation simple and avoids a
     * partial-unmap path; re-growing later just reuses the still-mapped pages. */

    p->brk = new_brk;
    return (long)old_brk;
}

int process_kill(uint32_t pid, int sig) {
    if (pid == 0)
        return -1; /* the kernel/idle process is not killable */

    uint32_t self = process_current_pid();
    struct process *p = find_by_pid(pid);
    if (!p || p->state == PROCESS_ZOMBIE)
        return -1; /* no such live process */
    if (sig == 0)
        return 0;  /* signal 0: existence probe only, target is alive */

    /* A catchable signal (not SIGKILL) for which the target installed a Ring 3
     * handler is delivered, not fatal: mark it pending so the target runs its
     * handler on its next return to user mode. For a self-kill that return is
     * THIS syscall's iretq, so the handler fires synchronously. */
    if (sig > 0 && sig < PROCESS_SIG_MAX && sig != PROCESS_SIGKILL && p->sig_handler[sig]) {
        p->sig_pending |= (1u << sig);
        return 0;
    }

    int exit_code = 128 + sig; /* shell convention: 128 + signal number */

    if (pid == self) {
        /* Killing yourself is just exit(); never returns. */
        process_mark_exited(self, exit_code);
        task_exit();
        return 0; /* unreachable */
    }

    int target_tid = p->task_id;
    process_mark_exited(pid, exit_code);
    /* Stop the target's task from running again; the scheduler reaps it (freeing
     * its address space) and process_unregister_task turns it into a harvestable
     * zombie for its parent's wait(), exactly like a voluntary exit. */
    if (target_tid >= 0)
        sched_kill_task(target_tid);
    return 0;
}

int process_sigaction(int signum, uint64_t handler, uint64_t restorer) {
    uint32_t pid = process_current_pid();
    if (pid == 0)
        return -1; /* the kernel task has no signal dispositions */
    struct process *p = find_by_pid(pid);
    if (!p)
        return -1;
    if (signum <= 0 || signum >= PROCESS_SIG_MAX || signum == PROCESS_SIGKILL)
        return -1; /* invalid number, or the uncatchable SIGKILL */

    p->sig_handler[signum] = handler; /* 0 clears back to the default action */
    if (restorer)
        p->sig_restorer = restorer;   /* one trampoline serves every handler */
    return 0;
}

int process_take_pending_signal(uint64_t *handler_out, uint64_t *restorer_out) {
    struct process *p = find_by_pid(process_current_pid());
    if (!p || p->sig_pending == 0)
        return 0;
    for (int s = 1; s < PROCESS_SIG_MAX; s++) {
        if (p->sig_pending & (1u << s)) {
            p->sig_pending &= ~(1u << s);
            if (handler_out)
                *handler_out = p->sig_handler[s];
            if (restorer_out)
                *restorer_out = p->sig_restorer;
            return s;
        }
    }
    return 0;
}

/* Foreground process for console-generated signals (Ctrl-C). Only ever a user
 * program the shell launched; the shell clears it back to 0 once the program is
 * reaped, so the kernel shell task is never a target. */
static volatile uint32_t foreground_pid;

void process_set_foreground(uint32_t pid) {
    foreground_pid = pid;
}

uint32_t process_foreground(void) {
    return foreground_pid;
}

int process_raise_signal(uint32_t pid, int sig) {
    if (pid == 0)
        return -1;
    if (sig <= 0 || sig >= PROCESS_SIG_MAX || sig == PROCESS_SIGKILL)
        return -1; /* SIGKILL is never deferred; it always terminates outright */
    struct process *p = find_by_pid(pid);
    if (!p || p->state == PROCESS_ZOMBIE)
        return -1;
    /* IRQ-safe: a single word OR. Delivery (handler or default terminate) runs
     * later, on the target's return to user mode, in a context that may safely
     * touch the scheduler. */
    p->sig_pending |= (1u << sig);
    return 0;
}

/* ── User identity (Phase 13 — DAC) ───────────────────────────────── */

static struct process *current_process(void) {
    return find_by_pid(process_current_pid());
}

uint32_t process_current_uid(void)  { struct process *p = current_process(); return p ? p->uid  : 0; }
uint32_t process_current_gid(void)  { struct process *p = current_process(); return p ? p->gid  : 0; }
uint32_t process_current_euid(void) { struct process *p = current_process(); return p ? p->euid : 0; }
uint32_t process_current_egid(void) { struct process *p = current_process(); return p ? p->egid : 0; }

int process_set_uid(uint32_t uid) {
    struct process *p = current_process();
    if (!p)
        return -1;
    /* Root sets both real and effective uid freely; a non-root process may only
     * move to an id it already holds (drop privilege, never gain it). */
    if (p->euid == 0 || uid == p->uid || uid == p->euid) {
        p->uid = p->euid = uid;
        return 0;
    }
    return -1;
}

int process_set_gid(uint32_t gid) {
    struct process *p = current_process();
    if (!p)
        return -1;
    if (p->euid == 0 || gid == p->gid || gid == p->egid) {
        p->gid = p->egid = gid;
        return 0;
    }
    return -1;
}

/* ── Working directory (Phase 15) ─────────────────────────────────── */

void process_get_cwd(char *out, size_t sz) {
    if (!out || sz == 0)
        return;
    struct process *p = current_process();
    const char *src = p ? p->cwd : kernel_cwd;   /* pid-0 kernel/shell fallback */
    size_t i = 0;
    while (src[i] && i + 1 < sz) {
        out[i] = src[i];
        i++;
    }
    out[i] = '\0';
}

/* Set the current context's working directory to the already-resolved absolute
 * path `abs`. The caller is responsible for having verified it names a directory.
 * Returns 0 on success, -1 if `abs` is not absolute. */
int process_set_cwd(const char *abs) {
    if (!abs || abs[0] != '/')
        return -1;
    struct process *p = current_process();
    copy_path_field(p ? p->cwd : kernel_cwd, abs);
    return 0;
}

size_t process_list(struct process_info *out, size_t max) {
    if (!out || max == 0)
        return 0;

    size_t n = 0;
    for (int i = 0; i < PROCESS_MAX && n < max; i++) {
        if (process_table[i].state == PROCESS_UNUSED)
            continue;
        out[n].pid = process_table[i].pid;
        out[n].task_id = (process_table[i].task_id < 0) ? (uint32_t)-1 : (uint32_t)process_table[i].task_id;
        out[n].state = process_table[i].state;
        out[n].is_user = process_table[i].is_user;
        out[n].entry = process_table[i].entry;
        out[n].user_stack_top = process_table[i].user_stack_top;
        out[n].brk = process_table[i].brk;
        copy_name(out[n].name, process_table[i].name);
        n++;
    }
    return n;
}

int process_create_from_pe(const char *path) {
    if (!process_ready || !path)
        return -1;

    size_t image_size = 0;
    if (vfs_get_size(path, &image_size) != 0 || image_size == 0)
        return -2;
    if (image_size > (4 * 1024 * 1024))
        return -3; /* PE files can be larger than ELF */

    uint8_t *image = (uint8_t *)kmalloc(image_size);
    if (!image)
        return -4;

    int n = vfs_read_file(path, image, image_size);
    if (n < 0 || (size_t)n != image_size) {
        kfree(image);
        return -5;
    }

    struct vm_space *space = vmm_create_user_space();
    if (!space) {
        kfree(image);
        return -6;
    }

    struct pe_image loaded;
    int rc = pe_load_user_image(image, image_size, space, &loaded);
    kfree(image);
    if (rc != 0) {
        vmm_destroy_space(space);
        return -7;
    }

    /* Map user stack */
    const size_t stack_size = 4 * VMM_PAGE_SIZE;
    uint64_t stack_bottom = VMM_USER_STACK_TOP - stack_size;
    rc = vmm_map_anonymous(space, stack_bottom, stack_size,
                           VMM_FLAG_PRESENT | VMM_FLAG_USER | VMM_FLAG_WRITABLE | VMM_FLAG_NO_EXEC);
    if (rc != 0) {
        vmm_destroy_space(space);
        return -8;
    }

    int slot = alloc_slot();
    if (slot < 0) {
        vmm_destroy_space(space);
        return -9;
    }

    uint32_t pid = next_pid++;
    struct process *p = &process_table[slot];
    memset(p, 0, sizeof(*p));
    p->pid = pid;
    p->task_id = -1;
    p->state = PROCESS_READY;
    p->is_user = 1;
    p->entry = loaded.entry;
    p->user_stack_top = VMM_USER_STACK_TOP;
    p->brk = loaded.image_base + loaded.image_size;
    p->space = space;
    copy_name(p->name, path);

    serial_print("[PROC] Loaded PE process pid=");
    serial_print_dec(pid);
    serial_print(" path=");
    serial_print(path);
    serial_print(" subsystem=");
    serial_print(pe_subsystem_name(loaded.subsystem));
    serial_print("\n");

    return (int)pid;
}

int process_create_from_image(const char *path) {
    if (!process_ready || !path)
        return -1;

    /* Read first bytes to detect format */
    uint8_t magic[4];
    int n = vfs_read_file(path, magic, sizeof(magic));
    if (n < 4)
        return -2;

    /* ELF: 0x7F 'E' 'L' 'F' */
    if (magic[0] == 0x7F && magic[1] == 'E' && magic[2] == 'L' && magic[3] == 'F') {
        serial_print("[PROC] Detected ELF format: ");
        serial_print(path);
        serial_print("\n");
        return process_create_from_elf(path);
    }

    /* PE: 'M' 'Z' */
    if (magic[0] == 'M' && magic[1] == 'Z') {
        serial_print("[PROC] Detected PE format: ");
        serial_print(path);
        serial_print("\n");
        return process_create_from_pe(path);
    }

    serial_print("[PROC] Unknown binary format: ");
    serial_print(path);
    serial_print("\n");
    return -3;
}

const char *process_state_string(uint8_t state) {
    switch (state) {
    case PROCESS_READY:
        return "READY";
    case PROCESS_RUNNING:
        return "RUNNING";
    case PROCESS_ZOMBIE:
        return "ZOMBIE";
    default:
        return "UNUSED";
    }
}
