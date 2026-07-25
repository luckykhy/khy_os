/* agentask.c — Agent ⇄ OS decision plane (stage A5: OS → agent)
 *
 * A small wait-table couples a blocking caller to an asynchronous DECISION_RESP.
 * agent_ask allocates a slot, stamps it with a kernel-chosen seq and a deadline,
 * sends the DECISION_REQ, and blocks. Two events can complete the slot, both
 * running on the bridge task: agentask_on_response (the agent answered) and
 * agentask_tick (the deadline passed). Either sets the slot's state and unblocks
 * the caller, which then reads the result and frees the slot.
 *
 * Concurrency follows ipc.c exactly: the shared table is serialized by masking
 * interrupts (single CPU, no spinlock), and a caller may block WHILE masked —
 * the scheduler carries RFLAGS per task, so the switched-in bridge task runs
 * with interrupts enabled and the masked state is restored only when the caller
 * is later resumed. This closes the same lost-wakeup window ipc.c documents: the
 * slot publish, the send, and the self-block are one critical section relative
 * to the responder/timeout, so a reply can never be missed between arming and
 * blocking.
 * @pattern Mediator
 */

#include "agentask.h"
#include "agentbus.h"
#include "agentframe.h"
#include "sched.h"
#include "serial.h"
#include "string.h"
#include "timer.h"

/* A few concurrent decisions in flight is plenty (the shell, a couple of Ring 3
 * askers). Keep it small — the table is scanned linearly under the crit. */
#define AGENTASK_MAX_WAITERS        8
#define AGENTASK_DEFAULT_TIMEOUT_MS 3000

/* Slot state. */
#define WAIT_PENDING  0
#define WAIT_ANSWERED 1
#define WAIT_TIMEDOUT 2

struct waiter {
    int          in_use;
    uint32_t     seq;          /* kernel-chosen, matched against DECISION_RESP */
    int          task_id;      /* caller to unblock */
    volatile int state;        /* WAIT_* */
    uint64_t     deadline_tick;
    uint16_t     resp_len;
    uint8_t      resp[AGENTFRAME_PAYLOAD_MAX];
};

static struct waiter waiters[AGENTASK_MAX_WAITERS];
static uint32_t      ask_seq;  /* monotonic seq source for decision requests */

/* Decision-request seqs live in a high range so they never collide with the
 * agent's own REQUEST seqs (those are host-chosen and small in practice); it
 * also makes decision traffic easy to spot on the wire. */
#define AGENTASK_SEQ_BASE 0x80000000u

/* Send scratch: struct agentframe is ~1KB, so keep it off the caller stack. It
 * is only ever touched inside the crit (interrupts masked), so the single
 * static instance is safe across concurrent askers on this single-CPU kernel. */
static struct agentframe req_frame;

/* ── Single-CPU mutual exclusion (same discipline as ipc.c) ──────────────── */

static inline uint64_t ask_crit_enter(void) {
    uint64_t flags;
    __asm__ volatile("pushfq; pop %0; cli" : "=r"(flags) :: "memory");
    return flags;
}
static inline void ask_crit_leave(uint64_t flags) {
    __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");
}

/* ── Public API ──────────────────────────────────────────────────────────── */

void agentask_init(void) {
    memset(waiters, 0, sizeof(waiters));
    ask_seq = AGENTASK_SEQ_BASE;
    serial_print("[AGENTASK] Decision plane initialized (");
    serial_print_dec(AGENTASK_MAX_WAITERS);
    serial_print(" slots, default timeout ");
    serial_print_dec(AGENTASK_DEFAULT_TIMEOUT_MS);
    serial_print("ms)\n");
}

int agent_ask(uint16_t code, const uint8_t *payload, uint16_t len,
              uint8_t *out, uint16_t out_cap, uint16_t *out_len,
              uint32_t timeout_ms) {
    if (out_len)
        *out_len = 0;
    if (len > AGENTFRAME_PAYLOAD_MAX)
        return AGENT_ASK_EINVAL;
    if (timeout_ms == 0)
        timeout_ms = AGENTASK_DEFAULT_TIMEOUT_MS;

    /* ticks for the deadline; never zero so a sub-tick timeout still waits once */
    uint64_t ticks = ((uint64_t)timeout_ms * TIMER_HZ) / 1000;
    if (ticks == 0)
        ticks = 1;

    uint64_t flags = ask_crit_enter();

    /* Claim a free slot. */
    int idx = -1;
    for (int i = 0; i < AGENTASK_MAX_WAITERS; i++) {
        if (!waiters[i].in_use) {
            idx = i;
            break;
        }
    }
    if (idx < 0) {
        ask_crit_leave(flags);
        return AGENT_ASK_NOSLOT;
    }

    struct waiter *w = &waiters[idx];
    w->in_use        = 1;
    w->state         = WAIT_PENDING;
    w->seq           = ask_seq++;
    w->task_id       = sched_current_id();
    w->deadline_tick = timer_get_ticks() + ticks;
    w->resp_len      = 0;

    /* Build and send the DECISION_REQ. The send completes inside the crit, so it
     * cannot interleave with the bridge task's own TX, and it is published before
     * we block — closing the lost-wakeup window. serial TX is a bounded poll, so
     * sending while masked can never wedge. */
    req_frame.type = AGENTFRAME_TYPE_DECISION_REQ;
    req_frame.seq  = w->seq;
    req_frame.code = code;
    req_frame.len  = len;
    for (uint16_t i = 0; i < len; i++)
        req_frame.payload[i] = payload[i];
    agentbus_send_frame(&req_frame);

    /* Block until answered or timed out. Re-check after each wakeup: a spurious
     * unblock re-blocks; the deadline guarantees forward progress even with no
     * agent (agentask_tick will eventually mark us WAIT_TIMEDOUT). */
    while (w->state == WAIT_PENDING)
        sched_block_current();

    int rc;
    if (w->state == WAIT_ANSWERED) {
        uint16_t n = w->resp_len;
        if (out && out_cap) {
            if (n > out_cap)
                n = out_cap;
            for (uint16_t i = 0; i < n; i++)
                out[i] = w->resp[i];
            if (out_len)
                *out_len = n;
        }
        rc = AGENT_ASK_OK;
    } else {
        rc = AGENT_ASK_TIMEOUT;
    }

    w->in_use = 0;
    ask_crit_leave(flags);
    return rc;
}

void agentask_on_response(const struct agentframe *resp) {
    uint64_t flags = ask_crit_enter();
    for (int i = 0; i < AGENTASK_MAX_WAITERS; i++) {
        struct waiter *w = &waiters[i];
        if (w->in_use && w->state == WAIT_PENDING && w->seq == resp->seq) {
            uint16_t n = resp->len;
            if (n > AGENTFRAME_PAYLOAD_MAX)
                n = AGENTFRAME_PAYLOAD_MAX;
            for (uint16_t k = 0; k < n; k++)
                w->resp[k] = resp->payload[k];
            w->resp_len = n;
            w->state    = WAIT_ANSWERED;
            sched_unblock(w->task_id);
            break;
        }
    }
    ask_crit_leave(flags);
}

void agentask_tick(void) {
    uint64_t now   = timer_get_ticks();
    uint64_t flags = ask_crit_enter();
    for (int i = 0; i < AGENTASK_MAX_WAITERS; i++) {
        struct waiter *w = &waiters[i];
        if (w->in_use && w->state == WAIT_PENDING && now >= w->deadline_tick) {
            w->state = WAIT_TIMEDOUT;
            sched_unblock(w->task_id);
        }
    }
    ask_crit_leave(flags);
}
