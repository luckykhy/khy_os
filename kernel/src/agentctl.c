/* agentctl.c — Agent ⇄ OS control plane (stage A3: read-only verbs)
 *
 * Each verb decodes its request payload, calls the in-kernel VFS directly, and
 * serializes the result into the response payload. All access is from the kernel
 * side (no per-process uid/gid checks), so these are pure mechanism — the agent
 * sees the filesystem as the kernel does.
 *
 * Safety: every path is length-checked before use and copied into a bounded,
 * NUL-terminated buffer; every emitted byte stays within AGENTFRAME_PAYLOAD_MAX
 * by construction (see the page/clamp bounds). A malformed request can only ever
 * produce an AGENTCTL_EINVAL reply — it can never overrun a buffer or wedge the
 * bridge task.
 * @pattern Command
 */

#include "agentctl.h"
#include "agentframe.h"
#include "process.h"
#include "string.h"
#include "vfs.h"

/* Mutating verbs (WRITE/MKDIR/REMOVE) are refused on this subtree so the agent
 * cannot overwrite or delete the embedded Ring 3 programs the system depends on.
 * The path is canonicalized first, so "/bin/../bin/x" cannot slip past. */
#define AGENTCTL_PROTECTED_DIR "/bin"

/* ── Little-endian writers / readers ─────────────────────────────────────── */

static void w_u16(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
}

static void w_u32(uint8_t *p, uint32_t v) {
    for (int i = 0; i < 4; i++)
        p[i] = (uint8_t)((v >> (8 * i)) & 0xFF);
}

static void w_u64(uint8_t *p, uint64_t v) {
    for (int i = 0; i < 8; i++)
        p[i] = (uint8_t)((v >> (8 * i)) & 0xFF);
}

static uint32_t r_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint64_t r_u64(const uint8_t *p) {
    uint64_t v = 0;
    for (int i = 0; i < 8; i++)
        v |= (uint64_t)p[i] << (8 * i);
    return v;
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/* Fill `resp` with just a status byte (the error/empty reply shape). type/seq/
 * code were already set by agentctl_handle before the switch. */
static void reply_status(struct agentframe *resp, uint8_t status) {
    resp->payload[0] = status;
    resp->len = 1;
}

/* Copy the path portion of the request payload (bytes from `off` to the end)
 * into a NUL-terminated C string `out` of capacity `outsz`. Returns 0 on
 * success, -1 if the offset is past the payload or the path does not fit. */
static int extract_path(const struct agentframe *req, uint16_t off,
                        char *out, size_t outsz) {
    if (off > req->len)
        return -1;
    uint16_t n = (uint16_t)(req->len - off);
    if ((size_t)n + 1 > outsz)
        return -1;
    for (uint16_t i = 0; i < n; i++)
        out[i] = (char)req->payload[off + i];
    out[n] = '\0';
    return 0;
}

/* Canonicalize `in` into `canon` and apply the mutation guard. Returns
 * AGENTCTL_OK with `canon` filled when the path is usable and unprotected;
 * otherwise an error status (EINVAL for a path that will not canonicalize, EPERM
 * for the protected subtree) to reply with. Callers then operate on `canon`, so
 * the op runs against the exact path that was checked (no TOCTOU on the name). */
static uint8_t guard_mutation(const char *in, char *canon, size_t sz) {
    if (vfs_realpath(in, canon, sz, 0) != 0)
        return AGENTCTL_EINVAL;

    size_t plen = strlen(AGENTCTL_PROTECTED_DIR);
    if (strcmp(canon, AGENTCTL_PROTECTED_DIR) == 0)
        return AGENTCTL_EPERM;                 /* the directory itself */
    if (strncmp(canon, AGENTCTL_PROTECTED_DIR, plen) == 0 && canon[plen] == '/')
        return AGENTCTL_EPERM;                 /* anything beneath it   */
    return AGENTCTL_OK;
}

/* ── Verb handlers ───────────────────────────────────────────────────────── */

static void do_stat(const struct agentframe *req, struct agentframe *resp) {
    char path[VFS_PATH_MAX];
    if (extract_path(req, 0, path, sizeof(path)) != 0) {
        reply_status(resp, AGENTCTL_EINVAL);
        return;
    }

    uint8_t  type;
    uint64_t size, mtime, atime, ctime;
    uint32_t uid, gid;
    uint16_t mode;
    if (vfs_stat(path, &type, &size, &uid, &gid, &mode,
                 &mtime, &atime, &ctime) != 0) {
        reply_status(resp, AGENTCTL_ENOENT);
        return;
    }

    uint8_t *p = resp->payload;
    size_t n = 0;
    p[n++] = AGENTCTL_OK;
    p[n++] = type;
    w_u16(&p[n], mode);  n += 2;
    w_u32(&p[n], uid);   n += 4;
    w_u32(&p[n], gid);   n += 4;
    w_u64(&p[n], size);  n += 8;
    w_u64(&p[n], mtime); n += 8;
    w_u64(&p[n], atime); n += 8;
    w_u64(&p[n], ctime); n += 8;
    resp->len = (uint16_t)n;
}

static void do_list(const struct agentframe *req, struct agentframe *resp) {
    if (req->len < 4) {                /* need the start index */
        reply_status(resp, AGENTCTL_EINVAL);
        return;
    }
    uint32_t start = r_u32(req->payload);

    char path[VFS_PATH_MAX];
    if (extract_path(req, 4, path, sizeof(path)) != 0) {
        reply_status(resp, AGENTCTL_EINVAL);
        return;
    }
    if (!vfs_exists(path)) {
        reply_status(resp, AGENTCTL_ENOENT);
        return;
    }
    if (vfs_is_dir(path) != 1) {
        reply_status(resp, AGENTCTL_EINVAL);
        return;
    }

    struct vfs_dirent ents[AGENTCTL_LIST_PAGE];
    int got = vfs_list_dir_at(path, (size_t)start, ents, AGENTCTL_LIST_PAGE);
    if (got < 0) {
        reply_status(resp, AGENTCTL_EINVAL);
        return;
    }

    uint8_t *p = resp->payload;
    size_t n = 0;
    p[n++] = AGENTCTL_OK;
    w_u16(&p[n], (uint16_t)got); n += 2;
    for (int e = 0; e < got; e++) {
        uint8_t namelen = 0;
        while (namelen < VFS_NAME_MAX && ents[e].name[namelen] != '\0')
            namelen++;
        p[n++] = ents[e].type;
        w_u64(&p[n], ents[e].size); n += 8;
        p[n++] = namelen;
        for (uint8_t i = 0; i < namelen; i++)
            p[n++] = (uint8_t)ents[e].name[i];
    }
    resp->len = (uint16_t)n;
}

static void do_read(const struct agentframe *req, struct agentframe *resp) {
    if (req->len < 12) {               /* need offset(8) + len(4) */
        reply_status(resp, AGENTCTL_EINVAL);
        return;
    }
    uint64_t offset = r_u64(req->payload);
    uint32_t want   = r_u32(req->payload + 8);

    char path[VFS_PATH_MAX];
    if (extract_path(req, 12, path, sizeof(path)) != 0) {
        reply_status(resp, AGENTCTL_EINVAL);
        return;
    }
    if (!vfs_exists(path)) {
        reply_status(resp, AGENTCTL_ENOENT);
        return;
    }
    if (vfs_is_dir(path) == 1) {
        reply_status(resp, AGENTCTL_EINVAL);
        return;
    }

    /* Clamp to what one frame can carry past the status(1)+nread(4) header. */
    const uint32_t cap = AGENTFRAME_PAYLOAD_MAX - 5;
    if (want > cap)
        want = cap;

    int nread = vfs_read_file_at(path, resp->payload + 5, want, (size_t)offset);
    if (nread < 0) {
        reply_status(resp, AGENTCTL_EINVAL);
        return;
    }

    resp->payload[0] = AGENTCTL_OK;
    w_u32(&resp->payload[1], (uint32_t)nread);
    resp->len = (uint16_t)(5 + nread);
}

/* WRITE: [mode:1][pathlen:2][path][data...]. mode 0 = overwrite, 1 = append. */
static void do_write(const struct agentframe *req, struct agentframe *resp) {
    if (req->len < 3) {                /* need mode(1) + pathlen(2) */
        reply_status(resp, AGENTCTL_EINVAL);
        return;
    }
    uint8_t  mode    = req->payload[0];
    uint16_t pathlen = (uint16_t)(req->payload[1] | ((uint16_t)req->payload[2] << 8));
    if (mode > 1 || pathlen == 0 || pathlen >= VFS_PATH_MAX ||
        (size_t)3 + pathlen > req->len) {
        reply_status(resp, AGENTCTL_EINVAL);
        return;
    }

    char path[VFS_PATH_MAX];
    for (uint16_t i = 0; i < pathlen; i++)
        path[i] = (char)req->payload[3 + i];
    path[pathlen] = '\0';

    char canon[VFS_PATH_MAX];
    uint8_t g = guard_mutation(path, canon, sizeof(canon));
    if (g != AGENTCTL_OK) {
        reply_status(resp, g);
        return;
    }

    const uint8_t *data = req->payload + 3 + pathlen;
    size_t datalen = (size_t)req->len - 3 - pathlen;
    int written = vfs_write_file(canon, data, datalen, mode == 1 ? 1 : 0);
    if (written < 0) {
        reply_status(resp, AGENTCTL_EINVAL);
        return;
    }

    resp->payload[0] = AGENTCTL_OK;
    w_u32(&resp->payload[1], (uint32_t)written);
    resp->len = 5;
}

/* MKDIR: [path]. Reports EEXIST if the path is already present. */
static void do_mkdir(const struct agentframe *req, struct agentframe *resp) {
    char path[VFS_PATH_MAX];
    if (extract_path(req, 0, path, sizeof(path)) != 0 || path[0] == '\0') {
        reply_status(resp, AGENTCTL_EINVAL);
        return;
    }

    char canon[VFS_PATH_MAX];
    uint8_t g = guard_mutation(path, canon, sizeof(canon));
    if (g != AGENTCTL_OK) {
        reply_status(resp, g);
        return;
    }
    if (vfs_exists(canon)) {
        reply_status(resp, AGENTCTL_EEXIST);
        return;
    }
    reply_status(resp, vfs_mkdir(canon) == 0 ? AGENTCTL_OK : AGENTCTL_EINVAL);
}

/* REMOVE: [path]. Unlinks a file or removes an empty directory. */
static void do_remove(const struct agentframe *req, struct agentframe *resp) {
    char path[VFS_PATH_MAX];
    if (extract_path(req, 0, path, sizeof(path)) != 0 || path[0] == '\0') {
        reply_status(resp, AGENTCTL_EINVAL);
        return;
    }

    char canon[VFS_PATH_MAX];
    uint8_t g = guard_mutation(path, canon, sizeof(canon));
    if (g != AGENTCTL_OK) {
        reply_status(resp, g);
        return;
    }
    if (!vfs_exists(canon)) {
        reply_status(resp, AGENTCTL_ENOENT);
        return;
    }

    int rc = (vfs_is_dir(canon) == 1) ? vfs_rmdir(canon) : vfs_remove(canon);
    reply_status(resp, rc == 0 ? AGENTCTL_OK : AGENTCTL_EINVAL);
}

/* PS: [start:4]. Returns a page of the process table, paged like LIST. The full
 * table is snapshotted once (process_list) and the requested window serialized;
 * the snapshot buffer is static to keep it off the small bridge-task stack. */
static void do_ps(const struct agentframe *req, struct agentframe *resp) {
    if (req->len < 4) {
        reply_status(resp, AGENTCTL_EINVAL);
        return;
    }
    uint32_t start = r_u32(req->payload);

    static struct process_info procs[PROCESS_MAX];
    size_t total = process_list(procs, PROCESS_MAX);

    uint8_t *p = resp->payload;
    size_t n = 0;
    p[n++] = AGENTCTL_OK;
    size_t cnt_at = n;          /* backfill count after we know how many fit */
    n += 2;

    uint16_t emitted = 0;
    for (size_t i = start; i < total && emitted < AGENTCTL_LIST_PAGE; i++) {
        const struct process_info *pi = &procs[i];
        uint8_t namelen = 0;
        while (namelen < PROCESS_NAME_MAX && pi->name[namelen] != '\0')
            namelen++;
        w_u32(&p[n], pi->pid);     n += 4;
        w_u32(&p[n], pi->task_id); n += 4;
        p[n++] = pi->state;
        p[n++] = pi->is_user;
        p[n++] = namelen;
        for (uint8_t j = 0; j < namelen; j++)
            p[n++] = (uint8_t)pi->name[j];
        emitted++;
    }
    w_u16(&p[cnt_at], emitted);
    resp->len = (uint16_t)n;
}

/* ── Dispatch ────────────────────────────────────────────────────────────── */

void agentctl_handle(const struct agentframe *req, struct agentframe *resp) {
    resp->type = AGENTFRAME_TYPE_RESPONSE;
    resp->seq  = req->seq;
    resp->code = req->code;
    resp->len  = 0;

    switch (req->code) {
    case AGENTCTL_CODE_STAT:   do_stat(req, resp);   break;
    case AGENTCTL_CODE_LIST:   do_list(req, resp);   break;
    case AGENTCTL_CODE_READ:   do_read(req, resp);   break;
    case AGENTCTL_CODE_WRITE:  do_write(req, resp);  break;
    case AGENTCTL_CODE_MKDIR:  do_mkdir(req, resp);  break;
    case AGENTCTL_CODE_REMOVE: do_remove(req, resp); break;
    case AGENTCTL_CODE_PS:     do_ps(req, resp);     break;
    default:                   reply_status(resp, AGENTCTL_EINVAL); break;
    }
}
