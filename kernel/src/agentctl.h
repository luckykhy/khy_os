/* agentctl.h — Agent ⇄ OS control plane (stages A3–A4)
 *
 * The control plane is the agent -> OS direction: the agent issues a REQUEST
 * frame whose `code` names a verb and whose payload carries the arguments; the
 * OS performs it by calling the in-kernel VFS / process model directly
 * (from_user = 0, so no per-process permission checks apply) and answers with a
 * RESPONSE frame.
 *
 * agentbus.c owns the COM2 transport and the frame machine; this module owns the
 * verb semantics, so the two layers stay independent. Stage A3 wired the three
 * read-only verbs; stage A4 adds the mutating verbs (write / mkdir / remove) and
 * the process verb (ps). Mutations are gated by a protected-path guard so the
 * agent cannot corrupt the system program area.
 *
 * Wire layouts (after the frame header; all integers little-endian). Paths are
 * absolute strings, NOT NUL-terminated on the wire (their length is implied by
 * the payload / a length prefix):
 *
 *   STAT  request  [path...]
 *         response [status:1] then, on OK:
 *                  [ftype:1][mode:2][uid:4][gid:4][size:8][mtime:8][atime:8][ctime:8]
 *
 *   LIST  request  [start:4][path...]            (start = first entry index)
 *         response [status:1] then, on OK:
 *                  [count:2] followed by `count` entries, each
 *                  [ftype:1][size:8][namelen:1][name:namelen].
 *                  The agent pages by re-requesting with start += count until a
 *                  page returns count == 0.
 *
 *   READ  request  [offset:8][len:4][path...]
 *         response [status:1] then, on OK: [nread:4][bytes:nread].
 *                  `len` is clamped to what one frame can carry; the agent pages
 *                  by advancing offset until nread == 0.
 *
 *   WRITE request  [mode:1][pathlen:2][path:pathlen][data...]
 *                  mode 0 = overwrite (create/replace), 1 = append.
 *         response [status:1] then, on OK: [written:4].
 *
 *   MKDIR request  [path...]
 *         response [status:1]   (EEXIST if it already exists)
 *
 *   REMOVE request [path...]    (file -> unlink, empty dir -> rmdir)
 *         response [status:1]
 *
 *   PS    request  [start:4]                      (start = first process index)
 *         response [status:1] then, on OK:
 *                  [count:2] followed by `count` entries, each
 *                  [pid:4][task_id:4][state:1][is_user:1][namelen:1][name:namelen].
 *                  Paged like LIST.
 *
 * Every RESPONSE payload begins with a single status byte (AGENTCTL_OK or an
 * error). On error the payload is just that byte — there is no verb-specific
 * body, so the host parses status first and stops on anything non-zero.
 * @pattern Command
 */
#ifndef AGENTCTL_H
#define AGENTCTL_H

#include "agentframe.h"

/* Control-plane verbs (the frame `code` field). */
#define AGENTCTL_CODE_STAT   0x0001  /* A3 read-only  */
#define AGENTCTL_CODE_LIST   0x0002
#define AGENTCTL_CODE_READ   0x0003
#define AGENTCTL_CODE_WRITE  0x0004  /* A4 mutating   */
#define AGENTCTL_CODE_MKDIR  0x0005
#define AGENTCTL_CODE_REMOVE 0x0006
#define AGENTCTL_CODE_PS     0x0007  /* A4 process    */

/* Response status — the first payload byte of every control-plane RESPONSE. */
#define AGENTCTL_OK     0x00  /* success; a verb-specific body follows          */
#define AGENTCTL_ENOENT 0x01  /* the path does not exist                        */
#define AGENTCTL_EINVAL 0x02  /* malformed request, wrong node type, or bad verb*/
#define AGENTCTL_EEXIST 0x03  /* mkdir target already exists                     */
#define AGENTCTL_EPERM  0x04  /* mutation denied by the protected-path guard    */

/* Directory / process entries returned per page. Bounded so a full page always
 * fits one frame: 16 * (1+8+1+48) + status + count = 931 <= PAYLOAD_MAX, and the
 * process entry (max 1+4+4+1+1+32 = 43) is smaller still. */
#define AGENTCTL_LIST_PAGE 16

/* Handle one inbound REQUEST and build its RESPONSE. `resp` is fully populated
 * (type/seq/code/len/payload); agentbus.c encodes and sends it. Never fails —
 * any bad input yields an error-status RESPONSE rather than no reply, so the
 * agent's request always gets correlated by seq. */
void agentctl_handle(const struct agentframe *req, struct agentframe *resp);

#endif
