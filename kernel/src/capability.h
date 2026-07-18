/* capability.h — Per-process capability system for IPC access control
 *
 * Each process holds up to CAP_MAX capabilities, each granting
 * specific permissions on a specific IPC port.
 * @pattern Strategy
 */
#ifndef CAPABILITY_H
#define CAPABILITY_H

#include <stdint.h>

#define CAP_MAX_PER_PROCESS  16

/* Permission bits */
#define CAP_PERM_SEND   (1 << 0)   /* Can send to this port */
#define CAP_PERM_RECV   (1 << 1)   /* Can receive on this port */
#define CAP_PERM_ADMIN  (1 << 2)   /* Can register/unregister the port */

/* A single capability entry */
struct capability {
    uint16_t port;        /* IPC port number */
    uint16_t permissions; /* Bitmask of CAP_PERM_* */
};

/* Per-process capability set */
struct cap_set {
    struct capability caps[CAP_MAX_PER_PROCESS];
    int count;
};

/* Initialize capability subsystem */
void cap_init(void);

/* Initialize a cap_set (zero it out) */
void cap_set_init(struct cap_set *cs);

/* Grant a capability to a process's cap_set. Returns 0 on success, -1 if full. */
int cap_grant(struct cap_set *cs, uint16_t port, uint16_t permissions);

/* Revoke all capabilities for a given port from a cap_set. */
void cap_revoke(struct cap_set *cs, uint16_t port);

/* Check if a cap_set has the given permission on a port. Returns 1 if allowed, 0 if denied. */
int cap_check(const struct cap_set *cs, uint16_t port, uint16_t required_perm);

#endif
