/* agentask.h — Agent ⇄ OS decision plane (stage A5: OS → agent)
 *
 * The reverse of the control plane. Where agentctl lets the agent drive the OS
 * (agent → OS), this module lets the OS ask the agent to make a decision
 * (OS → agent): a kernel subsystem or a Ring 3 process poses a question (natural
 * language or a structured intent), the bridge sends it to the host as a
 * DECISION_REQ frame, the caller blocks, and the agent's DECISION_RESP wakes it
 * with the answer.
 *
 * Loose coupling (requirement 3) is non-negotiable here: a missing or silent
 * agent must NEVER wedge the kernel. Every ask carries a deadline; if no
 * DECISION_RESP arrives in time the bridge task times the waiter out and the
 * caller returns AGENT_ASK_TIMEOUT so it can apply a safe default. The kernel
 * keeps running whether or not a host is on COM2.
 * @pattern Mediator
 */
#ifndef AGENTASK_H
#define AGENTASK_H

#include <stddef.h>
#include <stdint.h>

struct agentframe;

/* Decision-plane intent codes (the frame `code` carried on DECISION_REQ). They
 * tell the agent how to read the question and what shape of answer to return:
 *   GENERIC — a yes/no-style decision (the `agentask` command); the agent replies
 *             with a short verdict string (e.g. "ALLOW" / "DENY").
 *   NL      — a free-form natural-language command (the `ai` command); the agent
 *             replies with one structured action line the kernel then executes
 *             (SAY / SET / GET — see cmd_ai in shell.c). This is requirement 4:
 *             configure the model and talk to KHY in natural language, in-system. */
#define AGENT_INTENT_GENERIC 0x0000
#define AGENT_INTENT_NL      0x0001

/* Result of agent_ask (also the negative return of SYSCALL_AGENT_ASK). */
#define AGENT_ASK_OK       0   /* agent answered; *out_len bytes copied to out  */
#define AGENT_ASK_TIMEOUT (-1) /* no answer before the deadline (apply default) */
#define AGENT_ASK_NOSLOT  (-2) /* the wait-table is full; try again later       */
#define AGENT_ASK_EINVAL  (-3) /* bad arguments                                 */

/* Reset the wait-table. Called once during boot from agentbus_init(). */
void agentask_init(void);

/* Ask the connected agent to decide. Sends a DECISION_REQ frame carrying
 * (code, payload[0..len)) over COM2 and blocks the calling task until the agent
 * replies with a matching DECISION_RESP or `timeout_ms` elapses (0 = default).
 * On AGENT_ASK_OK the decision bytes are copied into out[0..out_cap) and
 * *out_len is set to the number copied. With no agent connected — or a silent
 * one — the call returns AGENT_ASK_TIMEOUT after the deadline; it never wedges
 * the caller or the kernel. Safe to call from a kernel task or a syscall. */
int agent_ask(uint16_t code, const uint8_t *payload, uint16_t len,
              uint8_t *out, uint16_t out_cap, uint16_t *out_len,
              uint32_t timeout_ms);

/* RX hook: the bridge calls this for every inbound DECISION_RESP frame. It
 * matches the frame to a pending waiter by seq, copies its payload, and wakes
 * the blocked caller. An unknown seq (a late or duplicate reply for a request
 * that already timed out) is ignored. */
void agentask_on_response(const struct agentframe *resp);

/* Timeout pump: the bridge task calls this every loop iteration. Any waiter
 * past its deadline is marked timed-out and its caller unblocked, so a missing
 * agent can never leave a caller blocked forever. */
void agentask_tick(void);

#endif
