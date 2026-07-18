/* ipc.c — Port-based IPC for the KHY OS hybrid kernel
 *
 * Each port has a fixed-depth message queue (ring buffer).
 * Blocking: when a sender's target queue is full, or a receiver's
 * queue is empty, the calling task is put into TASK_BLOCKED state
 * and is woken up when space/data becomes available.
 * @pattern Mediator
 */

#include "ipc.h"
#include "sched.h"
#include "serial.h"
#include "string.h"

/* ── Port descriptor ─────────────────────────────────────────────── */

struct ipc_port {
    int       registered;           /* 0 = free, 1 = owned */
    int       owner_task_id;        /* Task that owns this port */
    struct ipc_message queue[IPC_QUEUE_DEPTH];
    int       head;                 /* Next read index */
    int       tail;                 /* Next write index */
    int       count;                /* Messages in queue */
    int       blocked_sender;       /* Task blocked waiting to send (-1 = none) */
    int       blocked_receiver;     /* Task blocked waiting to recv (-1 = none) */
};

static struct ipc_port ports[IPC_MAX_PORTS];
static uint32_t next_seq;

/* ── Single-CPU mutual exclusion ─────────────────────────────────────
 * Mask interrupts (NOT a spinlock) to serialize access to the shared port
 * table against a preempting task. Deadlock-immune and nest-safe. Crucially,
 * a task may block (sched_block_current) WHILE masked: schedule() and
 * context_switch carry RFLAGS per task, so the switched-in task runs with its
 * own IF and the blocked task's masked state is restored only when it is later
 * resumed — then ipc_crit_leave restores the caller's original IF. */
static inline uint64_t ipc_crit_enter(void) {
    uint64_t flags;
    __asm__ volatile("pushfq; pop %0; cli" : "=r"(flags) :: "memory");
    return flags;
}
static inline void ipc_crit_leave(uint64_t flags) {
    __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");
}

/* ── Helpers ─────────────────────────────────────────────────────── */

static int _queue_full(const struct ipc_port *p) {
    return p->count >= IPC_QUEUE_DEPTH;
}

static int _queue_empty(const struct ipc_port *p) {
    return p->count == 0;
}

static void _queue_push(struct ipc_port *p, const struct ipc_message *msg) {
    memcpy(&p->queue[p->tail], msg, sizeof(struct ipc_message));
    p->tail = (p->tail + 1) % IPC_QUEUE_DEPTH;
    p->count++;
}

static void _queue_pop(struct ipc_port *p, struct ipc_message *out) {
    memcpy(out, &p->queue[p->head], sizeof(struct ipc_message));
    p->head = (p->head + 1) % IPC_QUEUE_DEPTH;
    p->count--;
}

/* ── Public API ──────────────────────────────────────────────────── */

void ipc_init(void) {
    memset(ports, 0, sizeof(ports));
    for (int i = 0; i < IPC_MAX_PORTS; i++) {
        ports[i].blocked_sender   = -1;
        ports[i].blocked_receiver = -1;
    }
    next_seq = 1;
    serial_print("[IPC] Message passing initialized (");
    serial_print_dec(IPC_MAX_PORTS);
    serial_print(" ports, depth=");
    serial_print_dec(IPC_QUEUE_DEPTH);
    serial_print(")\n");
}

int ipc_port_register(uint16_t port) {
    if (port >= IPC_MAX_PORTS)
        return IPC_ERR_INVAL;
    if (ports[port].registered)
        return IPC_ERR_BUSY;

    struct ipc_port *p = &ports[port];
    p->registered       = 1;
    p->owner_task_id    = sched_current_id();
    p->head             = 0;
    p->tail             = 0;
    p->count            = 0;
    p->blocked_sender   = -1;
    p->blocked_receiver = -1;

    serial_print("[IPC] Port ");
    serial_print_dec(port);
    serial_print(" registered by task ");
    serial_print_dec(p->owner_task_id);
    serial_print("\n");

    return IPC_OK;
}

int ipc_port_unregister(uint16_t port) {
    if (port >= IPC_MAX_PORTS)
        return IPC_ERR_INVAL;
    if (!ports[port].registered)
        return IPC_ERR_NOPORT;

    /* Only the owner can unregister */
    if (ports[port].owner_task_id != sched_current_id())
        return IPC_ERR_PERM;

    /* Wake any blocked tasks with an error condition */
    if (ports[port].blocked_sender >= 0)
        sched_unblock(ports[port].blocked_sender);
    if (ports[port].blocked_receiver >= 0)
        sched_unblock(ports[port].blocked_receiver);

    memset(&ports[port], 0, sizeof(struct ipc_port));
    ports[port].blocked_sender   = -1;
    ports[port].blocked_receiver = -1;

    return IPC_OK;
}

int ipc_send(uint16_t dest_port, const struct ipc_message *msg) {
    if (dest_port >= IPC_MAX_PORTS || !msg)
        return IPC_ERR_INVAL;
    if (!ports[dest_port].registered)
        return IPC_ERR_NOPORT;

    struct ipc_port *p = &ports[dest_port];

    /* [SAFE] Lost-wakeup deadlock fix. The full-check, the publishing of
     * blocked_sender, the self-block, and the enqueue must be ONE critical
     * section relative to a preempting receiver. Previously they were not:
     *   (a) a receiver draining the queue between the full-check and
     *       `blocked_sender = self` saw no parked sender, issued no wakeup, then
     *       this task blocked with free space and was never woken; and
     *   (b) a receiver running between `blocked_sender = self` and
     *       sched_block_current() called sched_unblock on a task still READY —
     *       a no-op (sched_unblock only flips TASK_BLOCKED) — again losing the
     *       wakeup. Either way: permanent deadlock. Masking interrupts across
     *       the whole sequence makes the queue/blocked_sender mutation atomic
     *       w.r.t. the receiver; blocking while masked is safe (see
     *       ipc_crit_enter). Re-check after wakeup since the queue may have
     *       changed while we were switched out. */
    uint64_t flags = ipc_crit_enter();

    /* If queue is full, block or return error */
    if (_queue_full(p)) {
        if (msg->flags & IPC_FLAG_NONBLOCK) {
            ipc_crit_leave(flags);
            return IPC_ERR_FULL;
        }

        /* The port has a single blocked-sender slot. If another task is already
         * parked here, overwriting it would orphan that task forever (its later
         * wakeup would target only the most recent id). Refuse the second sender
         * with a recoverable error. */
        if (p->blocked_sender >= 0 && p->blocked_sender != sched_current_id()) {
            ipc_crit_leave(flags);
            return IPC_ERR_FULL;
        }

        /* Block current task until space is available */
        p->blocked_sender = sched_current_id();
        sched_block_current();

        /* After wakeup: check if port is still valid */
        if (!p->registered) {
            ipc_crit_leave(flags);
            return IPC_ERR_NOPORT;
        }
        /* If still full after wakeup, return error (shouldn't happen normally) */
        if (_queue_full(p)) {
            ipc_crit_leave(flags);
            return IPC_ERR_FULL;
        }
    }

    /* Enqueue message */
    _queue_push(p, msg);

    /* Wake a blocked receiver if any */
    if (p->blocked_receiver >= 0) {
        int tid = p->blocked_receiver;
        p->blocked_receiver = -1;
        sched_unblock(tid);
    }

    ipc_crit_leave(flags);
    return IPC_OK;
}

int ipc_recv(uint16_t port, struct ipc_message *out, uint32_t flags) {
    if (port >= IPC_MAX_PORTS || !out)
        return IPC_ERR_INVAL;
    if (!ports[port].registered)
        return IPC_ERR_NOPORT;

    struct ipc_port *p = &ports[port];

    /* Only the owner can receive on this port */
    if (p->owner_task_id != sched_current_id())
        return IPC_ERR_PERM;

    /* [SAFE] Mirror of the ipc_send lost-wakeup fix: the empty-check, the
     * publishing of blocked_receiver, the self-block, and the dequeue form one
     * critical section relative to a preempting sender. A sender enqueuing
     * between the empty-check and `blocked_receiver = self` (or between that and
     * sched_block_current) would otherwise fail to wake this not-yet-BLOCKED
     * receiver, leaving a message queued and the receiver parked forever.
     * Masking serializes the queue/blocked_receiver mutation; blocking while
     * masked is safe (see ipc_crit_enter). `flags` here is the IPC_FLAG_*
     * argument; `crit` holds the saved IF state. */
    uint64_t crit = ipc_crit_enter();

    /* If queue is empty, block or return error */
    if (_queue_empty(p)) {
        if (flags & IPC_FLAG_NONBLOCK) {
            ipc_crit_leave(crit);
            return IPC_ERR_EMPTY;
        }

        /* Block current task until a message arrives */
        p->blocked_receiver = sched_current_id();
        sched_block_current();

        /* After wakeup */
        if (!p->registered) {
            ipc_crit_leave(crit);
            return IPC_ERR_NOPORT;
        }
        if (_queue_empty(p)) {
            ipc_crit_leave(crit);
            return IPC_ERR_EMPTY;
        }
    }

    /* Dequeue message */
    _queue_pop(p, out);

    /* Wake a blocked sender if any */
    if (p->blocked_sender >= 0) {
        int tid = p->blocked_sender;
        p->blocked_sender = -1;
        sched_unblock(tid);
    }

    ipc_crit_leave(crit);
    return IPC_OK;
}

int ipc_call(uint16_t dest_port, const struct ipc_message *request,
             struct ipc_message *reply) {
    if (!request || !reply)
        return IPC_ERR_INVAL;

    /* Allocate a temporary reply port for this call.
     * Use a port in the upper range (16-31) to avoid collision with services. */
    uint16_t reply_port = 0;
    for (uint16_t i = IPC_MAX_PORTS / 2; i < IPC_MAX_PORTS; i++) {
        if (!ports[i].registered) {
            reply_port = i;
            break;
        }
    }
    if (reply_port == 0)
        return IPC_ERR_BUSY; /* No free reply ports */

    /* Register temporary reply port */
    int rc = ipc_port_register(reply_port);
    if (rc != IPC_OK)
        return rc;

    /* Build request with reply port and sequence */
    struct ipc_message req_copy;
    memcpy(&req_copy, request, sizeof(struct ipc_message));
    req_copy.sender_pid  = (uint16_t)sched_current_id();
    req_copy.sender_port = reply_port;
    req_copy.type        = IPC_MSG_REQUEST;
    req_copy.seq         = next_seq++;

    /* Send request */
    rc = ipc_send(dest_port, &req_copy);
    if (rc != IPC_OK) {
        ipc_port_unregister(reply_port);
        return rc;
    }

    /* Block waiting for reply */
    rc = ipc_recv(reply_port, reply, 0);
    ipc_port_unregister(reply_port);

    return rc;
}

int ipc_port_owner(uint16_t port) {
    if (port >= IPC_MAX_PORTS || !ports[port].registered)
        return -1;
    return ports[port].owner_task_id;
}
