/* agentbus.h — Agent ⇄ OS control channel over COM2
 *
 * The bridge between the host-side agent (built-in KHY Node agent or an external
 * agent such as Claude Code) and the kernel. It runs on COM2, physically
 * separate from the human TTY on COM1, so the agent frame protocol never fights
 * the shell for bytes. See kernel/docs/架构-agent-os双向协议.md.
 *
 * STAGE A1 (this revision): physical-channel bring-up only. agentbus_task()
 * raw-echoes every COM2 byte straight back, proving bidirectional transport on
 * the isolated channel. The COBS/CRC16 frame machine and the control/decision/
 * event planes replace this echo loop in stage A2 onward; the file and its
 * init/task entry points stay, only the loop body grows.
 *
 * Loose coupling (requirement 3): when no host is connected to COM2, the channel
 * is simply idle — the kernel runs completely normally. The agent's absence is
 * never an error and never blocks the kernel.
 * @pattern Mediator
 */
#ifndef AGENTBUS_H
#define AGENTBUS_H

/* Bring up the COM2 UART for the agent channel. Call once during boot, after
 * serial_init(). */
void agentbus_init(void);

/* Kernel task entry: services the agent channel forever. Created like the other
 * in-kernel service tasks (vfs-service, net-service). Cooperatively yields when
 * the channel is idle so it never hogs a quantum. */
void agentbus_task(void);

/* Encode `f` and write it out over COM2. Used by the bridge for control-plane
 * responses and by the decision plane (agentask.c) to emit DECISION_REQ frames.
 * Exposed (stage A5) so OS → agent traffic can originate outside this file. */
struct agentframe;
void agentbus_send_frame(const struct agentframe *f);

#endif
