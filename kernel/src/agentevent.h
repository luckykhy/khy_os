/* agentevent.h — Agent ⇄ OS *event* plane (stage A6): the OS → agent one-way push.
 *
 * The third plane of the agent channel. The control plane (agentctl.c) is
 * agent → OS request/response; the decision plane (agentask.c) is OS → agent
 * ask/answer (the kernel blocks for a reply). This plane is OS → agent only and
 * fire-and-forget: the kernel notifies the agent of asynchronous process
 * lifecycle events (a new process spawned, a process exited, a process faulted)
 * and never waits for — or expects — a reply. An absent or silent agent simply
 * misses the notifications; the kernel is never blocked and never wedged.
 *
 * The hard problem is *where* events originate. A process exits or faults deep
 * inside contexts where serial I/O is unsafe or forbidden:
 *   - process_mark_exited() and the fault path run with interrupts masked;
 *   - the reaper runs inside schedule() with the run-queue locked.
 * Doing a bounded-but-real COM2 write there would lengthen a critical section
 * (and the reaper must do no I/O at all). So this module is split:
 *
 *   producer  agentevent_post()  — O(1), allocation-free, interrupt-safe. Copies
 *             a compact record into a fixed ring under a short mask-interrupts
 *             critical section (nest-safe: save/restore RFLAGS). No I/O. Safe to
 *             call from exit / fault / creation paths already holding a cli lock.
 *
 *   consumer  agentevent_drain() — runs only on the agent-bridge task. Pops
 *             records off the ring (each pop under the same short crit) and
 *             encodes/sends one EVENT frame per record over COM2, OUTSIDE the
 *             crit. The bridge already owns COM2 TX, so all serial output stays
 *             on one task.
 *
 * Ring overflow under an event storm drops records (counted, never corrupts) —
 * losing a notification is acceptable for a fire-and-forget plane; wedging the
 * kernel to guarantee delivery is not.
 * @pattern Producer-Consumer
 */
#ifndef AGENTEVENT_H
#define AGENTEVENT_H

#include <stdint.h>

/* Event codes — carried in the EVENT frame's `code` field. The host maps each
 * to a JSON event kind. */
#define AGENTEVENT_SPAWN 0x0001  /* a new user process was created  */
#define AGENTEVENT_EXIT  0x0002  /* a process exited normally/by signal */
#define AGENTEVENT_FAULT 0x0003  /* a process was killed by a CPU fault */

/* Reset the event ring. Call once during agentbus_init(), before the bridge
 * task starts draining. */
void agentevent_init(void);

/* Producer: enqueue one lifecycle event. O(1), no I/O, interrupt-safe and
 * nest-safe — callable from exit/fault/creation paths that already hold a
 * mask-interrupts critical section. `name` may be NULL (encoded as empty).
 *
 * The three integer fields are interpreted per `code`:
 *   SPAWN: pid=child pid,  aux=parent pid, info=task id
 *   EXIT : pid=exited pid, aux=task id,    info=exit code
 *   FAULT: pid=faulted pid,aux=task id,    info=fault vector
 * If the ring is full the event is dropped and an internal counter is bumped;
 * the kernel is never blocked. */
void agentevent_post(uint16_t code, uint32_t pid, uint32_t aux, int32_t info,
                     const char *name);

/* Consumer: drain pending events, sending one EVENT frame per record over COM2.
 * Call once per agent-bridge loop iteration. Bounded (drains at most the ring
 * capacity per call) so a flooding producer can never trap the bridge in this
 * function. Does nothing when the ring is empty. */
void agentevent_drain(void);

#endif
