/* sched.c — Round-robin kernel task scheduler for KHY OS (Hybrid Kernel)
 *
 * Cooperative/preemptive scheduler with blocking support.
 * Tasks are kernel threads or user-mode processes. Context switch
 * saves/restores callee-saved registers (rbx, rbp, r12-r15) and rsp.
 * TASK_BLOCKED state supports IPC blocking semantics.
 * @pattern State
 */

#include "sched.h"
#include "gdt.h"
#include "process.h"
#include "serial.h"
#include "string.h"
#include "timer.h"
#include "vmm.h"

/* Task table */
static struct task tasks[MAX_TASKS];
static int current_task;
static int num_tasks;
static int scheduler_ready;

/* Assembly context switch function */
extern void context_switch(uint64_t *old_rsp, uint64_t new_rsp);

/* Entry trampoline: defined in context_switch.asm */
extern void task_entry_trampoline(void);

/* Ring 3 entry paths: defined in boot/usermode.asm */
extern void enter_usermode(uint64_t user_rip, uint64_t user_rsp);
extern void iret_to_user_context(const struct user_context *ctx);

/* First-dispatch entry for Ring 3 tasks. Runs in Ring 0 on the task's kernel
 * stack (schedule() has already switched CR3 and set TSS.rsp0). Drops to
 * Ring 3 either at the task's entry point or, for a fork child, straight into
 * the parent's captured trap state (fork_ctx.rax = 0). Never returns. */
static void _user_task_bootstrap(void) {
    struct task *t = &tasks[current_task];
    if (t->is_fork)
        iret_to_user_context(&t->fork_ctx);
    else
        enter_usermode(t->user_entry, t->user_stack);
}

void sched_init(void) {
    memset(tasks, 0, sizeof(tasks));
    current_task = 0;
    num_tasks = 0;
    scheduler_ready = 0;

    /* Task 0 = the kernel_main context (idle task) */
    tasks[0].state   = TASK_RUNNING;
    tasks[0].name    = "kernel_main";
    tasks[0].id      = 0;
    tasks[0].space   = NULL;
    tasks[0].is_user = 0;
    num_tasks = 1;
    scheduler_ready = 1;

    serial_print("[SCHED] Scheduler initialized (max ");
    serial_print_dec(MAX_TASKS);
    serial_print(" tasks)\n");
}

/* Set up the initial stack frame for a new task.
 * Returns the initial RSP value. */
static uint64_t _setup_task_stack(struct task *t, void (*entry)(void)) {
    uint64_t *sp = &t->stack[TASK_STACK_SIZE / 8 - 1];

    /* Align stack to 16 bytes */
    sp = (uint64_t *)((uint64_t)sp & ~0xFULL);

    /* context_switch restores low→high: RFLAGS (popfq), rbp, rbx, r12,
     * r13, r14, r15, then ret. Build the frame in matching order. */
    *(--sp) = (uint64_t)task_entry_trampoline; /* ret → trampoline */
    *(--sp) = (uint64_t)entry;                  /* r15 = entry function */
    *(--sp) = 0;                                /* r14 */
    *(--sp) = 0;                                /* r13 */
    *(--sp) = 0;                                /* r12 */
    *(--sp) = 0;                                /* rbx */
    *(--sp) = 0;                                /* rbp */
    *(--sp) = 0x202;                            /* RFLAGS: bit1 reserved=1,
                                                 * bit9 IF=1 → new task starts
                                                 * with interrupts enabled so
                                                 * it can be preempted */

    return (uint64_t)sp;
}

static int _alloc_task_slot(void) {
    for (int i = 1; i < MAX_TASKS; i++) {
        if (tasks[i].state == TASK_UNUSED)
            return i;
    }
    return -1;
}

int sched_create_task(void (*entry)(void), const char *name) {
    int slot = _alloc_task_slot();
    if (slot < 0) {
        serial_print("[SCHED] ERROR: No free task slots\n");
        return -1;
    }

    struct task *t = &tasks[slot];
    memset(t, 0, sizeof(struct task));
    t->state   = TASK_READY;
    t->name    = name;
    t->id      = (uint32_t)slot;
    t->space   = NULL;
    t->is_user = 0;
    t->rsp     = _setup_task_stack(t, entry);
    num_tasks++;

    serial_print("[SCHED] Created task '");
    serial_print(name);
    serial_print("' (ID=");
    serial_print_dec(slot);
    serial_print(")\n");

    return slot;
}

int sched_create_user_task(uint64_t user_entry, uint64_t user_stack,
                           struct vm_space *space, const char *name) {
    int slot = _alloc_task_slot();
    if (slot < 0) {
        serial_print("[SCHED] ERROR: No free task slots\n");
        return -1;
    }

    struct task *t = &tasks[slot];
    memset(t, 0, sizeof(struct task));
    t->state      = TASK_READY;
    t->name       = name;
    t->id         = (uint32_t)slot;
    t->space      = space;
    t->is_user    = 1;
    t->user_entry = user_entry;
    t->user_stack = user_stack;
    t->rsp        = _setup_task_stack(t, _user_task_bootstrap);
    num_tasks++;

    serial_print("[SCHED] Created user task '");
    serial_print(name);
    serial_print("' (ID=");
    serial_print_dec(slot);
    serial_print(", space=");
    serial_print_hex((uint64_t)space);
    serial_print(")\n");

    return slot;
}

int sched_fork_user_task(struct vm_space *space, const struct user_context *ctx,
                         const char *name) {
    if (!space || !ctx)
        return -1;

    int slot = _alloc_task_slot();
    if (slot < 0) {
        serial_print("[SCHED] ERROR: No free task slots\n");
        return -1;
    }

    struct task *t = &tasks[slot];
    memset(t, 0, sizeof(struct task));
    t->state      = TASK_READY;
    t->name       = name;
    t->id         = (uint32_t)slot;
    t->space      = space;
    t->is_user    = 1;
    t->is_fork    = 1;
    t->fork_ctx   = *ctx;
    t->user_entry = ctx->rip;
    t->user_stack = ctx->user_rsp;
    t->rsp        = _setup_task_stack(t, _user_task_bootstrap);
    num_tasks++;

    serial_print("[SCHED] Forked user task '");
    serial_print(name);
    serial_print("' (ID=");
    serial_print_dec(slot);
    serial_print(")\n");

    return slot;
}

/* Reap zombie tasks: release their slots and process bookkeeping. Runs inside
 * schedule() with interrupts disabled, on some OTHER task's stack — the
 * currently running slot is never reaped (task_exit switches away first). */
static void _reap_zombies(void) {
    for (int i = 1; i < MAX_TASKS; i++) {
        if (i == current_task || tasks[i].state != TASK_ZOMBIE)
            continue;
        process_unregister_task(i);
        tasks[i].state = TASK_UNUSED;
        num_tasks--;
    }
}

void schedule(void) {
    /* Disable interrupts around the selection + switch critical section so a
     * timer IRQ cannot re-enter schedule() while a cooperative yield() is
     * mid-switch. Because context_switch now carries RFLAGS per task, this is
     * safe: we save the caller's IF state here and restore it on every exit
     * path, which is what re-enables interrupts for the resumed task (e.g.
     * IF=1 for a cooperative yield, IF=0 for a task preempted in-IRQ). */
    uint64_t flags;
    __asm__ volatile("pushfq; pop %0; cli" : "=r"(flags) :: "memory");

    if (!scheduler_ready || num_tasks <= 1) {
        __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");
        return;
    }

    _reap_zombies();

    int old = current_task;
    int next = old;
    uint64_t now = timer_get_ticks();

    /* Find next ready task (round-robin), skip BLOCKED/UNUSED/ZOMBIE and wake
     * any sleeper whose deadline has passed along the way. */
    for (int i = 0; i < MAX_TASKS; i++) {
        next = (next + 1) % MAX_TASKS;
        if (tasks[next].state == TASK_SLEEPING && now >= tasks[next].wake_tick)
            tasks[next].state = TASK_READY;
        if (tasks[next].state == TASK_READY || tasks[next].state == TASK_RUNNING)
            break;
    }

    if (next == old) {
        __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");
        return;
    }

    /* Update states */
    if (tasks[old].state == TASK_RUNNING)
        tasks[old].state = TASK_READY;
    tasks[next].state = TASK_RUNNING;
    current_task = next;

    /* Switch address space if tasks have different vm_spaces */
    struct vm_space *old_space = tasks[old].space;
    struct vm_space *new_space = tasks[next].space;
    if (new_space && new_space != old_space) {
        vmm_switch_space(new_space);
    } else if (!new_space && old_space) {
        /* Switching back to kernel space */
        vmm_switch_space(vmm_kernel_space());
    }

    /* If switching to a user-mode task, set TSS.rsp0 to its kernel stack top
     * so interrupts from Ring 3 land on the correct kernel stack */
    if (tasks[next].is_user) {
        uint64_t kernel_stack_top = (uint64_t)&tasks[next].stack[TASK_STACK_SIZE / 8];
        gdt_set_kernel_stack(kernel_stack_top);
    }

    /* Perform context switch. Control returns here only when THIS task is
     * later rescheduled; restore the caller's IF state before returning. */
    context_switch(&tasks[old].rsp, tasks[next].rsp);

    __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");
}

int sched_current_id(void) {
    return current_task;
}

struct task *sched_current_task(void) {
    return &tasks[current_task];
}

void yield(void) {
    schedule();
}

void sched_block_current(void) {
    if (current_task == 0) {
        /* Never block the idle/kernel_main task */
        serial_print("[SCHED] WARNING: Attempt to block kernel_main ignored\n");
        return;
    }
    tasks[current_task].state = TASK_BLOCKED;
    schedule();
}

void sched_unblock(int task_id) {
    if (task_id < 0 || task_id >= MAX_TASKS)
        return;
    if (tasks[task_id].state == TASK_BLOCKED)
        tasks[task_id].state = TASK_READY;
}

void task_exit(void) {
    __asm__ volatile("cli");

    if (current_task == 0) {
        /* kernel_main is the idle anchor — it must never exit. */
        serial_print("[SCHED] WARNING: task_exit on kernel_main; halting\n");
    } else {
        tasks[current_task].state = TASK_ZOMBIE;
        serial_print("[SCHED] Task '");
        serial_print(tasks[current_task].name ? tasks[current_task].name : "?");
        serial_print("' exited (ID=");
        serial_print_dec(current_task);
        serial_print(")\n");
    }

    /* Switch away for good; the slot is reaped from another task's schedule().
     * schedule() can only return here if nothing else was runnable — then wait
     * for a timer tick and retry. */
    for (;;) {
        schedule();
        __asm__ volatile("sti; hlt; cli");
    }
}

int sched_kill_task(int task_id) {
    if (task_id <= 0 || task_id >= MAX_TASKS || task_id == current_task)
        return -1;
    enum task_state s = tasks[task_id].state;
    if (s == TASK_UNUSED || s == TASK_ZOMBIE)
        return -1;
    tasks[task_id].state = TASK_ZOMBIE;
    return 0;
}

void sched_sleep_ticks(uint64_t ticks) {
    if (ticks == 0) {
        yield();
        return;
    }

    uint64_t until = timer_get_ticks() + ticks;

    if (current_task == 0) {
        /* kernel_main must stay runnable: idle-wait instead of sleeping. */
        while (timer_get_ticks() < until)
            __asm__ volatile("hlt");
        return;
    }

    uint64_t flags;
    __asm__ volatile("pushfq; pop %0; cli" : "=r"(flags) :: "memory");
    tasks[current_task].wake_tick = until;
    tasks[current_task].state = TASK_SLEEPING;
    /* schedule() returns immediately when nothing else is runnable, so keep
     * yielding (idling between timer ticks) until the deadline passes. */
    while (timer_get_ticks() < until) {
        schedule();
        if (timer_get_ticks() >= until)
            break;
        __asm__ volatile("sti; hlt; cli");
    }
    tasks[current_task].state = TASK_RUNNING;
    __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");
}

void sched_sleep_ms(uint32_t ms) {
    uint64_t ticks = ((uint64_t)ms * TIMER_HZ + 999) / 1000;
    if (ticks == 0)
        ticks = 1;
    sched_sleep_ticks(ticks);
}
