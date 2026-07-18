/* agentevent.c — Agent ⇄ OS event plane (stage A6). See agentevent.h.
 *
 * A bounded single-ring producer/consumer. Producers (exit / fault / process
 * creation paths) push compact records with agentevent_post(); the agent-bridge
 * task drains them with agentevent_drain() and emits one EVENT frame each over
 * COM2. The split keeps all serial I/O on the bridge task and keeps the
 * producer O(1) and safe to call from interrupt-masked contexts.
 * @pattern Producer-Consumer
 */

#include "agentevent.h"
#include "agentbus.h"
#include "agentframe.h"
#include "process.h"   /* PROCESS_NAME_MAX */

/* Compact in-ring record. Fixed size, no pointers — copied by value on push so
 * the producer never reaches into freed process slots later. */
struct agentevent_rec {
    uint16_t code;
    uint32_t pid;
    uint32_t aux;
    int32_t  info;
    uint8_t  namelen;
    char     name[PROCESS_NAME_MAX];
};

/* Power-of-two capacity so head/tail wrap with a mask. 64 records absorbs a
 * burst of spawns/exits between two bridge quanta with room to spare. */
#define AGENTEVENT_RING_CAP 64
#define AGENTEVENT_RING_MASK (AGENTEVENT_RING_CAP - 1)

/* Event-frame seq base, kept clear of the agent's REQUEST seqs and the decision
 * plane's 0x80000000 base, so a debugger can tell the three apart at a glance.
 * For a fire-and-forget plane the value is informational only (no correlation). */
#define AGENTEVENT_SEQ_BASE 0x40000000u

static struct agentevent_rec ring[AGENTEVENT_RING_CAP];
static uint32_t ring_head;   /* next slot to write (producer) */
static uint32_t ring_tail;   /* next slot to read  (consumer) */
static uint32_t event_seq;   /* monotonic, for frame ordering/debug */
static uint32_t dropped;     /* events lost to a full ring (honest accounting) */

/* Encode scratch for the drained frame. Static (not on the bridge task stack)
 * because struct agentframe is ~1KB. Touched only by agentevent_drain(), which
 * runs solely on the bridge task, so no locking is needed for it. */
static struct agentframe ev_frame;

/* Mirror the mask-interrupts critical section used across the kernel (ipc.c,
 * process.c). Nest-safe: it saves the caller's RFLAGS and restores them, so a
 * caller that is already inside a cli section stays cli'd afterward. */
static inline uint64_t ev_crit_enter(void) {
    uint64_t flags;
    __asm__ volatile("pushfq; pop %0; cli" : "=r"(flags) :: "memory");
    return flags;
}
static inline void ev_crit_leave(uint64_t flags) {
    __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");
}

void agentevent_init(void) {
    ring_head = 0;
    ring_tail = 0;
    event_seq = AGENTEVENT_SEQ_BASE;
    dropped = 0;
}

void agentevent_post(uint16_t code, uint32_t pid, uint32_t aux, int32_t info,
                     const char *name) {
    uint64_t flags = ev_crit_enter();

    uint32_t used = ring_head - ring_tail;   /* unsigned: correct across wrap */
    if (used >= AGENTEVENT_RING_CAP) {
        /* Full. Drop this event rather than block or overwrite an unread one. */
        dropped++;
        ev_crit_leave(flags);
        return;
    }

    struct agentevent_rec *r = &ring[ring_head & AGENTEVENT_RING_MASK];
    r->code = code;
    r->pid  = pid;
    r->aux  = aux;
    r->info = info;

    /* Bounded copy of the name (no libc strnlen dependency in this context). */
    uint8_t n = 0;
    if (name) {
        while (n < PROCESS_NAME_MAX - 1 && name[n] != '\0') {
            r->name[n] = name[n];
            n++;
        }
    }
    r->namelen = n;

    ring_head++;
    ev_crit_leave(flags);
}

/* Pop one record into `out`. Returns 1 if a record was dequeued, 0 if empty.
 * The pop runs under the crit; the caller sends the frame outside it. */
static int agentevent_pop(struct agentevent_rec *out) {
    uint64_t flags = ev_crit_enter();
    if (ring_tail == ring_head) {
        ev_crit_leave(flags);
        return 0;
    }
    *out = ring[ring_tail & AGENTEVENT_RING_MASK];
    ring_tail++;
    ev_crit_leave(flags);
    return 1;
}

void agentevent_drain(void) {
    /* Bounded by capacity: even if a producer keeps posting, we leave after at
     * most one ring's worth so the bridge loop keeps servicing RX and timeouts. */
    for (int budget = 0; budget < AGENTEVENT_RING_CAP; budget++) {
        struct agentevent_rec rec;
        if (!agentevent_pop(&rec))
            return;

        /* Uniform payload: [pid:4][aux:4][info:4][namelen:1][name:namelen].
         * Field meaning depends on rec.code (see agentevent.h). */
        struct agentframe *f = &ev_frame;
        f->type = AGENTFRAME_TYPE_EVENT;
        f->seq  = event_seq++;
        f->code = rec.code;

        uint16_t off = 0;
        uint32_t pid = rec.pid, aux = rec.aux;
        uint32_t info = (uint32_t)rec.info;
        f->payload[off++] = (uint8_t)(pid);
        f->payload[off++] = (uint8_t)(pid >> 8);
        f->payload[off++] = (uint8_t)(pid >> 16);
        f->payload[off++] = (uint8_t)(pid >> 24);
        f->payload[off++] = (uint8_t)(aux);
        f->payload[off++] = (uint8_t)(aux >> 8);
        f->payload[off++] = (uint8_t)(aux >> 16);
        f->payload[off++] = (uint8_t)(aux >> 24);
        f->payload[off++] = (uint8_t)(info);
        f->payload[off++] = (uint8_t)(info >> 8);
        f->payload[off++] = (uint8_t)(info >> 16);
        f->payload[off++] = (uint8_t)(info >> 24);
        f->payload[off++] = rec.namelen;
        for (uint8_t i = 0; i < rec.namelen; i++)
            f->payload[off++] = (uint8_t)rec.name[i];
        f->len = off;

        agentbus_send_frame(f);   /* fire-and-forget; no reply expected */
    }
}
