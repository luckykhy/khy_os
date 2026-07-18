/* agentconf.h — in-system agent configuration, persisted at /disk/etc/agent.conf
 *
 * The OS-owned, reboot-surviving config that decides which agent/model the host
 * bridge talks to (requirement 4). It is a tiny line-based `key=value` file on
 * the persistent /disk subtree (KhyFS over ATA), so it survives reboot like any
 * other /disk file. Two parties touch it:
 *
 *   - the kernel writes/reads it here, driven by the natural-language `ai`
 *     command: "ai use model claude-opus" → the agent returns the structured
 *     action `SET model claude-opus` → cmd_ai calls agentconf_set("model", ...).
 *   - the host bridge reads it over the control plane (bridge.readConfig() does
 *     `read('/disk/etc/agent.conf')`) to decide which agent/model to connect.
 *
 * Loose coupling (requirement 3): if no disk is mounted (/disk absent) the
 * setters/getters fail with a negative code rather than wedging — the system
 * still runs, just without persisted config.
 */
#ifndef AGENTCONF_H
#define AGENTCONF_H

#include <stddef.h>

#define AGENTCONF_PATH    "/disk/etc/agent.conf"
#define AGENTCONF_MAX     1024  /* whole-file cap; the config is intentionally small */
#define AGENTCONF_KEY_MAX 64
#define AGENTCONF_VAL_MAX 256

/* Result codes (negative on failure). */
#define AGENTCONF_OK        0
#define AGENTCONF_ENODISK (-1)  /* /disk is not mounted (no persistence available) */
#define AGENTCONF_EINVAL  (-2)  /* bad key/value (empty, too long, illegal char)   */
#define AGENTCONF_EIO     (-3)  /* a vfs read/write/mkdir failed                    */
#define AGENTCONF_ENOENT  (-4)  /* (get only) the key is not present                */

/* Set key=value, creating /disk/etc and the file as needed. If `key` already
 * exists its line is replaced; otherwise the line is appended. Whole-file
 * rewrite (the config is tiny). Returns AGENTCONF_OK or a negative code. */
int agentconf_set(const char *key, const char *value);

/* Copy the value for `key` into out[0..cap) (NUL-terminated when there is room)
 * and return its length (>=0). Returns a negative code if /disk is absent, the
 * file or the key is missing, or `out` is too small. */
int agentconf_get(const char *key, char *out, size_t cap);

#endif /* AGENTCONF_H */
