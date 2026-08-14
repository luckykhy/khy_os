/* sched.h — Round-robin task scheduler with blocking support * @pattern Strategy
 */
#ifndef SCHED_H
#define SCHED_H

#include <stdint.h>

#define MAX_TASKS       32
#define TASK_STACK_SIZE 8192   /* 8KB per task stack */

/* Forward declaration */
struct vm_space;

/* A full Ring 3 register/return state, used to resume a forked child exactly
 * where its parent's int 0x80 will return. Field order and offsets are mirrored
 * by iret_to_user_context in boot/usermode.asm — KEEP THEM IN SYNC. */
struct user_context {
    uint64_t r15, r14, r13, r12, r11, r10, r9, r8;  /* +0  .. +56  */
    uint64_t rbp, rdi, rsi, rdx, rcx, rbx, rax;     /* +64 .. +112 */
    uint64_t rip;        /* +120 */
    uint64_t cs;         /* +128 */
    uint64_t rflags;     /* +136 */
    uint64_t user_rsp;   /* +144 */
    uint64_t ss;         /* +152 */
};

/* Task states */
enum task_state {
    TASK_UNUSED  = 0,
    TASK_READY   = 1,
    TASK_RUNNING = 2,
    TASK_BLOCKED = 3,
    TASK_ZOMBIE  = 4,   /* entry function returned; awaiting reclamation */
    TASK_SLEEPING = 5,  /* blocked until timer tick reaches wake_tick */
};

/* Task control block */
struct task {
    uint64_t         rsp;            /* Saved stack pointer */
    enum task_state  state;
    uint64_t         stack[TASK_STACK_SIZE / 8]; /* Task stack */
    const char      *name;
    uint32_t         id;
    struct vm_space *space;          /* User address space (NULL = kernel task) */
    uint8_t          is_user;        /* 1 if Ring 3 user task */
    uint64_t         wake_tick;      /* timer tick to wake at (TASK_SLEEPING) */
    uint64_t         user_entry;     /* Ring 3 entry RIP (is_user only) */
    uint64_t         user_stack;     /* Ring 3 initial RSP (is_user only) */
    uint8_t          is_fork;        /* 1 if launched as a fork child (resume via fork_ctx) */
    struct user_context fork_ctx;    /* parent's Ring 3 state to resume into (is_fork only) */
};

/* Initialize the scheduler */
void sched_init(void);

/* Create a new kernel task. Returns task ID or -1 on failure. */
int sched_create_task(void (*entry)(void), const char *name);

/* Create a Ring 3 user task. `user_entry`/`user_stack` are virtual addresses in
 * `space`; on first dispatch the task switches to `space`, sets TSS.rsp0, and
 * iretq's to Ring 3 at `user_entry` with RSP = `user_stack`. */
int sched_create_user_task(uint64_t user_entry, uint64_t user_stack,
                           struct vm_space *space, const char *name);

/* Create a Ring 3 task that, on first dispatch, resumes into `ctx` (the parent's
 * captured int 0x80 trap state) rather than starting a program at its entry.
 * This is how a fork()ed child returns from the same syscall as its parent —
 * with ctx.rax already set to 0. Returns task ID or -1. */
int sched_fork_user_task(struct vm_space *space, const struct user_context *ctx, const char *name);

/* Terminate the current task: mark it a zombie and switch away for good. Also
 * reached when a kernel task's entry function returns (via the trampoline) and
 * invoked by SYSCALL_EXIT to tear down a finished Ring 3 process. Never returns. */
void task_exit(void);

/* Called from timer IRQ to switch tasks */
void schedule(void);

/* Get current task ID */
int sched_current_id(void);

/* Get current task struct */
struct task *sched_current_task(void);

/* Voluntarily yield CPU to next task */
void yield(void);

/* Block the current task (sets TASK_BLOCKED, then yields) */
void sched_block_current(void);

/* Unblock a specific task (sets TASK_READY so scheduler can pick it up) */
void sched_unblock(int task_id);

/* Forcibly terminate another task by id (drives kill()): marks it a zombie for
 * the scheduler to reap. Returns 0 if marked, -1 if `task_id` is invalid, the
 * caller itself, or already dead. */
int sched_kill_task(int task_id);

/* Sleep the current task until `ticks` timer ticks have elapsed, yielding the
 * CPU meanwhile. At TIMER_HZ=100 one tick is 10 ms. */
void sched_sleep_ticks(uint64_t ticks);

/* Convenience wrapper: sleep the current task for approximately `ms`
 * milliseconds (rounded up to whole timer ticks, minimum one tick). */
void sched_sleep_ms(uint32_t ms);

#endif
