/* agentbus.c — Agent ⇄ OS channel over COM2 (stage A6: control + decision + event planes)
 *
 * See agentbus.h and kernel/docs/架构-agent-os双向协议.md for the full design.
 *
 * Transport: COM2, physically separate from the human TTY on COM1. This task
 * drives the wire protocol — it accumulates incoming bytes, splits them into
 * frames on the 0x00 COBS delimiter, decodes/validates each frame
 * (agentframe.c), and dispatches it. Outgoing frames are encoded and written
 * back over COM2.
 *
 * Dispatch routes by frame type. An inbound REQUEST goes to the control plane
 * (agentctl.c), which runs the verb against the in-kernel VFS / process model
 * and returns a RESPONSE (agent → OS). An inbound DECISION_RESP goes to the
 * decision plane (agentask.c), which matches it to a blocked caller by seq and
 * wakes it (the reply half of an OS → agent ask). Every loop iteration also
 * pumps agentask_tick() so a pending decision still times out when the agent is
 * absent or silent, and agentevent_drain() so queued OS → agent lifecycle
 * events (spawn / exit / fault) are flushed out over COM2. The transport and
 * RX/TX plumbing are unchanged across stages; only the dispatch grows.
 *
 * Loose coupling (requirement 3): with no host on COM2 the channel is idle and
 * the kernel runs normally. Corrupt or oversized input is dropped and the RX
 * accumulator resynchronizes on the next delimiter — a malformed stream can
 * never wedge or crash the kernel.
 * @pattern Mediator
 */

#include "agentbus.h"
#include "agentask.h"
#include "agentctl.h"
#include "agentevent.h"
#include "agentframe.h"
#include "sched.h"
#include "serial.h"

/* RX accumulation across task iterations. Single consumer (this task), so plain
 * statics need no locking. rx_overflow latches when a frame exceeds the buffer
 * before a delimiter arrives; we then drop bytes until the next 0x00 to
 * resynchronize, rather than emit a truncated frame. */
static uint8_t rx_buf[AGENTFRAME_WIRE_MAX];
static size_t  rx_len;
static int     rx_overflow;

/* Scratch for the decoded request and the encoded reply. Static (not on the
 * task stack) because struct agentframe is ~1KB and kernel stacks are small. */
static struct agentframe in_frame;
static struct agentframe out_frame;
static uint8_t           tx_buf[AGENTFRAME_WIRE_MAX];

void agentbus_send_frame(const struct agentframe *f) {
    /* tx_buf is a shared static, and send_frame now has three callers on
     * different task contexts: the bridge task (control responses + event
     * drain), and any task blocked in agent_ask() emitting a DECISION_REQ. A
     * timer preempt mid-encode could otherwise let a second caller clobber
     * tx_buf. Serialize the encode+write under a short mask-interrupts crit;
     * COM2 TX is a bounded poll (serial.c gives up after SERIAL_TX_POLL_LIMIT
     * spins per byte) so the section is finite and never wedges. Nest-safe:
     * agent_ask already calls us inside its own cli section. */
    uint64_t flags;
    __asm__ volatile("pushfq; pop %0; cli" : "=r"(flags) :: "memory");

    int n = agentframe_encode(f, tx_buf, sizeof(tx_buf));
    if (n >= 0) {
        for (int i = 0; i < n; i++)
            serial_com2_putchar((char)tx_buf[i]);
    }
    /* n < 0: unencodable (shouldn't happen for our own frames); drop. */

    __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");
}

/* Handle one validated inbound frame, routing by type. A REQUEST is run by the
 * control plane (agentctl.c), which fills out_frame with the RESPONSE we send
 * back. A DECISION_RESP is the agent answering an OS → agent ask, handed to the
 * decision plane (agentask.c) to wake the blocked caller by seq. The OS-origin
 * types (RESPONSE / EVENT / DECISION_REQ) are never expected inbound and are
 * ignored. */
static void dispatch_frame(const struct agentframe *req) {
    switch (req->type) {
    case AGENTFRAME_TYPE_REQUEST:
        agentctl_handle(req, &out_frame);
        agentbus_send_frame(&out_frame);
        break;
    case AGENTFRAME_TYPE_DECISION_RESP:
        agentask_on_response(req);
        break;
    default:
        break;
    }
}

/* Feed one received byte into the RX accumulator; process a frame on delimiter. */
static void agentbus_rx_byte(uint8_t b) {
    if (b == 0x00) {
        /* Frame boundary. Decode unless this frame overflowed or was empty. */
        if (!rx_overflow && rx_len > 0) {
            if (agentframe_decode(rx_buf, rx_len, &in_frame) == 0)
                dispatch_frame(&in_frame);
            /* else: corrupt frame, silently dropped */
        }
        rx_len = 0;
        rx_overflow = 0;
        return;
    }

    if (rx_len < sizeof(rx_buf)) {
        rx_buf[rx_len++] = b;
    } else {
        rx_overflow = 1; /* drop until the next delimiter resynchronizes us */
    }
}

void agentbus_init(void) {
    serial_com2_init();
    rx_len = 0;
    rx_overflow = 0;
    agentask_init();    /* decision plane shares this bridge's RX/TX */
    agentevent_init();  /* event plane shares this bridge's TX */
    serial_print("[AGENTBUS] COM2 agent channel initialized (stage A6: control + decision + event planes)\n");
}

void agentbus_task(void) {
    serial_print("[AGENTBUS] Agent bridge running on COM2 (control: stat/list/read/write/mkdir/remove/ps; decision: ask; event: spawn/exit/fault)\n");

    for (;;) {
        /* Pump decision-plane timeouts first so a pending ask still expires when
         * the agent is absent or silent — even while RX has nothing to deliver.
         * Then flush any queued lifecycle events out over COM2. */
        agentask_tick();
        agentevent_drain();

        char c;
        if (serial_com2_getchar_nonblock(&c)) {
            agentbus_rx_byte((uint8_t)c);
            continue; /* drain any backlog before yielding */
        }
        /* Channel idle (no host, or nothing to read) — yield the quantum. The
         * agent's absence is normal and must never block the kernel. */
        yield();
    }
}
