/* capability.c — Per-process capability enforcement for IPC * @pattern Strategy
 */

#include "capability.h"
#include "serial.h"
#include "string.h"

void cap_init(void) {
    serial_print("[CAP] Capability subsystem initialized\n");
}

void cap_set_init(struct cap_set *cs) {
    memset(cs, 0, sizeof(struct cap_set));
}

int cap_grant(struct cap_set *cs, uint16_t port, uint16_t permissions) {
    if (!cs)
        return -1;

    /* Check if port already has an entry — merge permissions */
    for (int i = 0; i < cs->count; i++) {
        if (cs->caps[i].port == port) {
            cs->caps[i].permissions |= permissions;
            return 0;
        }
    }

    /* New entry */
    if (cs->count >= CAP_MAX_PER_PROCESS)
        return -1;

    cs->caps[cs->count].port        = port;
    cs->caps[cs->count].permissions = permissions;
    cs->count++;
    return 0;
}

void cap_revoke(struct cap_set *cs, uint16_t port) {
    if (!cs)
        return;

    for (int i = 0; i < cs->count; i++) {
        if (cs->caps[i].port == port) {
            /* Shift remaining entries down */
            for (int j = i; j + 1 < cs->count; j++)
                cs->caps[j] = cs->caps[j + 1];
            cs->count--;
            memset(&cs->caps[cs->count], 0, sizeof(struct capability));
            return;
        }
    }
}

int cap_check(const struct cap_set *cs, uint16_t port, uint16_t required_perm) {
    if (!cs)
        return 0;

    for (int i = 0; i < cs->count; i++) {
        if (cs->caps[i].port == port) {
            return (cs->caps[i].permissions & required_perm) == required_perm;
        }
    }
    return 0;
}
