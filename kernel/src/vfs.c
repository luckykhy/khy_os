/* vfs.c — Minimal in-kernel VFS implementation * @pattern Composite
 */

#include "vfs.h"
#include "kheap.h"
#include "rtc.h"
#include "string.h"

struct vfs_node {
    char name[VFS_NAME_MAX];
    uint8_t type;
    struct vfs_node *parent;
    struct vfs_node *children;
    struct vfs_node *next;
    uint8_t *data;
    size_t size;
    size_t capacity;
    uint32_t owner_uid; /* DAC owner (Phase 13); 0 = root */
    uint32_t owner_gid;
    uint16_t mode;      /* 9-bit rwxrwxrwx permission triads */
    uint64_t mtime;     /* last content-modification time, Unix epoch s (Phase 28) */
    uint64_t atime;     /* last access (content read) time (Phase 29) */
    uint64_t ctime;     /* last status-change time: write/chmod/chown/rename (Phase 29) */
};

static struct vfs_node root_node;
static int vfs_ready;

static vfs_write_hook_t  write_hook;
static vfs_remove_hook_t remove_hook;
static vfs_mkdir_hook_t  mkdir_hook;
static vfs_symlink_hook_t symlink_hook;

void vfs_set_write_hook(vfs_write_hook_t hook)   { write_hook = hook; }
void vfs_set_remove_hook(vfs_remove_hook_t hook) { remove_hook = hook; }
void vfs_set_mkdir_hook(vfs_mkdir_hook_t hook)   { mkdir_hook = hook; }
void vfs_set_symlink_hook(vfs_symlink_hook_t hook) { symlink_hook = hook; }

/* Cap on symlink hops during one path resolution (POSIX SYMLOOP_MAX analogue).
 * Bounds work and breaks cyclic links (a -> b -> a) with an ELOOP-style error. */
#define VFS_SYMLOOP_MAX 32

static size_t name_len_limited(const char *s) {
    size_t n = 0;
    if (!s)
        return 0;
    while (s[n] && n < (VFS_NAME_MAX - 1))
        n++;
    return n;
}

static void copy_name(char *dst, const char *src) {
    size_t n = name_len_limited(src);
    for (size_t i = 0; i < n; i++)
        dst[i] = src[i];
    dst[n] = '\0';
}

static int next_component(const char **path, char out[VFS_NAME_MAX]) {
    const char *p = *path;
    while (*p == '/')
        p++;
    if (*p == '\0')
        return 0;

    size_t n = 0;
    while (*p && *p != '/') {
        if (n + 1 < VFS_NAME_MAX) {
            out[n++] = *p;
        }
        p++;
    }
    out[n] = '\0';
    *path = p;
    return 1;
}

static struct vfs_node *find_child(struct vfs_node *dir, const char *name) {
    if (!dir || dir->type != VFS_NODE_DIR)
        return 0;
    struct vfs_node *n = dir->children;
    while (n) {
        if (strcmp(n->name, name) == 0)
            return n;
        n = n->next;
    }
    return 0;
}

static struct vfs_node *lookup(const char *path) {
    if (!vfs_ready || !path || path[0] != '/')
        return 0;
    if (strcmp(path, "/") == 0)
        return &root_node;

    struct vfs_node *cur = &root_node;
    const char *p = path;
    char comp[VFS_NAME_MAX];
    while (next_component(&p, comp)) {
        cur = find_child(cur, comp);
        if (!cur)
            return 0;
    }
    return cur;
}

static int split_parent(const char *path, char leaf[VFS_NAME_MAX], struct vfs_node **out_parent) {
    if (!path || path[0] != '/')
        return -1;

    const char *p = path;
    struct vfs_node *cur = &root_node;
    char comp[VFS_NAME_MAX];
    char next[VFS_NAME_MAX];

    if (!next_component(&p, comp))
        return -2;

    for (;;) {
        const char *save = p;
        if (!next_component(&save, next)) {
            copy_name(leaf, comp);
            *out_parent = cur;
            return 0;
        }

        struct vfs_node *child = find_child(cur, comp);
        if (!child || child->type != VFS_NODE_DIR)
            return -3;
        cur = child;
        next_component(&p, comp);
    }
}

static struct vfs_node *create_child(struct vfs_node *parent, const char *name, uint8_t type) {
    if (!parent || parent->type != VFS_NODE_DIR)
        return 0;
    if (find_child(parent, name))
        return 0;

    struct vfs_node *n = (struct vfs_node *)kmalloc(sizeof(struct vfs_node));
    if (!n)
        return 0;
    memset(n, 0, sizeof(*n));
    copy_name(n->name, name);
    n->type = type;
    n->parent = parent;
    /* Default ownership/permissions: owned by root (0/0), dirs rwxr-xr-x (0755),
     * files rw-r--r-- (0644), symlinks rwxrwxrwx (0777 — like Unix, the link's own
     * mode is unused; access control applies to the target and the parent dir).
     * The syscall layer re-owns user-created nodes. */
    n->owner_uid = 0;
    n->owner_gid = 0;
    n->mode = (type == VFS_NODE_DIR) ? 0755 : (type == VFS_NODE_SYMLINK) ? 0777 : 0644;
    n->mtime = rtc_unix_time();   /* born now (Phase 28); refreshed on each write */
    n->atime = n->ctime = n->mtime; /* all three timestamps start equal (Phase 29) */

    n->next = parent->children;
    parent->children = n;
    return n;
}

static int ensure_capacity(struct vfs_node *file, size_t needed) {
    if (!file || file->type != VFS_NODE_FILE)
        return -1;
    if (needed <= file->capacity)
        return 0;

    /* [SAFE] Overflow-safe growth. The old `new_cap *= 2` would wrap to 0 for a
     * `needed` above SIZE_MAX/2, making `new_cap < needed` loop forever (unbounded
     * loop / hang). Detect the wrap and fail closed instead; an over-large request
     * then returns an error rather than spinning or under-allocating. */
    size_t new_cap = file->capacity ? file->capacity : 64;
    while (new_cap < needed) {
        size_t doubled = new_cap * 2;
        if (doubled <= new_cap)
            return -2;
        new_cap = doubled;
    }

    uint8_t *new_data = (uint8_t *)realloc(file->data, new_cap);
    if (!new_data)
        return -2;
    file->data = new_data;
    file->capacity = new_cap;
    return 0;
}

int vfs_init(void) {
    memset(&root_node, 0, sizeof(root_node));
    root_node.type = VFS_NODE_DIR;
    root_node.name[0] = '/';
    root_node.name[1] = '\0';
    vfs_ready = 1;
    return 0;
}

int vfs_mkdir(const char *path) {
    if (!vfs_ready || !path || path[0] != '/')
        return -1;
    if (strcmp(path, "/") == 0)
        return 0;
    if (lookup(path))
        return 0;

    char leaf[VFS_NAME_MAX];
    struct vfs_node *parent = 0;
    if (split_parent(path, leaf, &parent) != 0)
        return -2;

    if (!create_child(parent, leaf, VFS_NODE_DIR))
        return -3;

    /* Mirror the new directory to durable storage if a hook is set. Fires only
     * on genuine creation — the lookup() above already returned for an existing
     * path, so persistence never sees a redundant mkdir. */
    if (mkdir_hook)
        mkdir_hook(path);
    return 0;
}

int vfs_write_file(const char *path, const void *data, size_t len, int append) {
    if (!vfs_ready || !path || path[0] != '/')
        return -1;

    struct vfs_node *node = lookup(path);
    if (!node) {
        char leaf[VFS_NAME_MAX];
        struct vfs_node *parent = 0;
        if (split_parent(path, leaf, &parent) != 0)
            return -2;
        node = create_child(parent, leaf, VFS_NODE_FILE);
        if (!node)
            return -3;
    }
    if (node->type != VFS_NODE_FILE)
        return -4;

    size_t start = append ? node->size : 0;
    /* [SAFE] Guard the size_t arithmetic below. `len` is caller-supplied and on
     * the write() syscall path is ultimately user-controlled; a value near
     * SIZE_MAX would wrap `start + len + 1` to a small `needed`, ensure_capacity
     * would allocate a tiny buffer, and the memcpy(node->data + start, data, len)
     * that follows would write `len` (huge) bytes — a kernel heap overflow
     * (OOB write) reachable from userspace. Reject any extent whose computation
     * would wrap before it can under-allocate. */
    if (len + 1 < len || start + (len + 1) < start)
        return -6;
    size_t needed = start + len + 1;
    if (ensure_capacity(node, needed) != 0)
        return -5;

    if (len && data)
        memcpy(node->data + start, data, len);
    node->size = start + len;
    node->data[node->size] = '\0';
    node->mtime = rtc_unix_time();   /* content changed -> bump mtime (Phase 28) */
    node->ctime = node->mtime;       /* ...which is also a status change (Phase 29) */

    /* Mirror the committed contents to durable storage if a hook is set. */
    if (write_hook)
        write_hook(path, node->data, node->size);
    return (int)len;
}

int vfs_truncate(const char *path, size_t new_size) {
    if (!vfs_ready || !path)
        return -1;
    struct vfs_node *node = lookup(path);
    if (!node || node->type != VFS_NODE_FILE)
        return -1;
    if (new_size + 1 < new_size)        /* size_t wrap guard (see vfs_write_file) */
        return -1;
    if (new_size > node->size) {
        if (ensure_capacity(node, new_size + 1) != 0)
            return -1;
        memset(node->data + node->size, 0, new_size - node->size);
    }
    node->size = new_size;
    if (node->data)
        node->data[node->size] = '\0';
    node->mtime = rtc_unix_time();   /* size changed -> bump mtime (Phase 28) */
    node->ctime = node->mtime;       /* ...a status change too (Phase 29) */
    if (write_hook)
        write_hook(path, node->data, node->size);
    return 0;
}

/* Move/rename a regular file or symlink from `oldpath` to `newpath`. The node is
 * relinked in place (no copy): it is unhooked from its current parent's child
 * list and prepended to the destination directory's list under the new leaf name,
 * so open descriptors keep pointing at the same data — only the tree position and
 * name change. Neither final component is dereferenced by the caller, so a symlink
 * is moved as itself rather than through its target.
 *
 * Directory rename is deliberately rejected: relocating a subtree would require
 * re-persisting every descendant under the /disk prefix, which the single-key
 * persist hooks cannot express today. Returns 0 on success, -1 on a bad/absent
 * source, a directory or root source, a missing destination parent, or a
 * destination that already exists (this rename never clobbers). */
int vfs_rename(const char *oldpath, const char *newpath) {
    if (!vfs_ready || !oldpath || !newpath)
        return -1;

    char old_leaf[VFS_NAME_MAX];
    struct vfs_node *old_parent = 0;
    if (split_parent(oldpath, old_leaf, &old_parent) != 0)
        return -1;
    struct vfs_node *node = find_child(old_parent, old_leaf);
    if (!node || node == &root_node)
        return -1;
    if (node->type != VFS_NODE_FILE && node->type != VFS_NODE_SYMLINK)
        return -1;                 /* directory move deferred (see comment) */

    char new_leaf[VFS_NAME_MAX];
    struct vfs_node *new_parent = 0;
    if (split_parent(newpath, new_leaf, &new_parent) != 0)
        return -1;                 /* destination parent component missing */
    if (!new_parent || new_parent->type != VFS_NODE_DIR)
        return -1;
    if (find_child(new_parent, new_leaf))
        return -1;                 /* refuse to overwrite an existing target */

    /* Detach from the current parent's singly-linked child list. */
    struct vfs_node **link = &old_parent->children;
    while (*link && *link != node)
        link = &(*link)->next;
    if (!*link)
        return -1;                 /* tree inconsistency — should not happen */
    *link = node->next;

    /* Rename and reattach under the destination (prepend, like create_child). */
    copy_name(node->name, new_leaf);
    node->parent = new_parent;
    node->next = new_parent->children;
    new_parent->children = node;
    node->ctime = rtc_unix_time();  /* a rename changes the inode's status (its name/
                                     * link), so ctime advances but mtime does not (Phase 29) */

    /* Persistence: drop the old /disk key, then emit the node under its new name.
     * Non-/disk paths no-op inside the hooks, so this is safe for /tmp too. */
    if (remove_hook)
        remove_hook(oldpath);
    if (node->type == VFS_NODE_SYMLINK) {
        if (symlink_hook && node->data)
            symlink_hook(newpath, (const char *)node->data);
    } else if (write_hook) {
        write_hook(newpath, node->data, node->size);
    }
    return 0;
}

int vfs_read_file_at(const char *path, void *buf, size_t len, size_t offset) {
    if (!vfs_ready || !path || !buf)
        return -1;

    struct vfs_node *node = lookup(path);
    if (!node || node->type != VFS_NODE_FILE)
        return -2;
    if (offset >= node->size)
        return 0;

    size_t n = node->size - offset;
    if (n > len)
        n = len;
    if (n > 0) {
        memcpy(buf, node->data + offset, n);
        node->atime = rtc_unix_time();  /* content was accessed -> bump atime only,
                                         * never mtime/ctime (POSIX read) (Phase 29) */
    }
    return (int)n;
}

int vfs_read_file(const char *path, void *buf, size_t len) {
    return vfs_read_file_at(path, buf, len, 0);
}

int vfs_get_size(const char *path, size_t *out_size) {
    if (!out_size)
        return -1;
    struct vfs_node *node = lookup(path);
    if (!node || node->type != VFS_NODE_FILE)
        return -2;
    *out_size = node->size;
    return 0;
}

int vfs_list_dir(const char *path, struct vfs_dirent *out, size_t max_entries) {
    struct vfs_node *dir = lookup(path);
    if (!dir || dir->type != VFS_NODE_DIR)
        return -1;

    size_t count = 0;
    struct vfs_node *child = dir->children;
    while (child && count < max_entries) {
        copy_name(out[count].name, child->name);
        out[count].type = child->type;
        out[count].size = child->size;
        count++;
        child = child->next;
    }
    return (int)count;
}

/* Like vfs_list_dir but starts after skipping the first `start` children, so a
 * caller can page through a directory larger than its buffer by advancing a
 * cursor (start += returned count) across calls. The child list is walked from
 * the head each call; in this single-core, synchronous-syscall kernel the list
 * does not mutate mid-enumeration, so index-based paging is stable. Returns the
 * number of entries written (0 once `start` reaches or passes the end), or -1 if
 * `path` is not a directory. */
int vfs_list_dir_at(const char *path, size_t start, struct vfs_dirent *out,
                    size_t max_entries) {
    struct vfs_node *dir = lookup(path);
    if (!dir || dir->type != VFS_NODE_DIR)
        return -1;

    struct vfs_node *child = dir->children;
    for (size_t i = 0; i < start && child; i++)
        child = child->next;

    size_t count = 0;
    while (child && count < max_entries) {
        copy_name(out[count].name, child->name);
        out[count].type = child->type;
        out[count].size = child->size;
        count++;
        child = child->next;
    }
    return (int)count;
}

int vfs_is_dir(const char *path) {
    struct vfs_node *node = lookup(path);
    return (node && node->type == VFS_NODE_DIR) ? 1 : 0;
}

int vfs_exists(const char *path) {
    return lookup(path) ? 1 : 0;
}

/* Append one already-isolated path component to the normalized path being built
 * in `out` (current length *plen, capacity outsz). Handles "." (ignored), ".."
 * (pop the last component, clamped at root "/") and ordinary names. `out` always
 * holds an absolute path with no trailing slash except the root itself.
 * Returns 0 on success, -1 if appending would overflow. */
static int path_push(char *out, size_t outsz, size_t *plen, const char *comp, size_t clen) {
    if (clen == 0)
        return 0;                                   /* empty (collapsed "//") */
    if (clen == 1 && comp[0] == '.')
        return 0;                                   /* current directory */
    if (clen == 2 && comp[0] == '.' && comp[1] == '.') {
        size_t l = *plen;
        while (l > 1 && out[l - 1] != '/')          /* strip the last component */
            l--;
        if (l > 1)
            l--;                                    /* drop its leading '/' too */
        if (l == 0)
            l = 1;                                  /* never below root */
        out[l] = '\0';
        *plen = l;
        return 0;
    }
    size_t sep = (*plen > 1) ? 1 : 0;               /* no extra '/' right after root */
    if (*plen + sep + clen + 1 > outsz)
        return -1;                                  /* would not fit */
    if (sep)
        out[(*plen)++] = '/';
    for (size_t i = 0; i < clen; i++)
        out[(*plen)++] = comp[i];
    out[*plen] = '\0';
    return 0;
}

/* Split `s` on '/' and push each component through path_push. */
static int path_walk(const char *s, char *out, size_t outsz, size_t *plen) {
    const char *p = s;
    while (*p) {
        while (*p == '/')
            p++;
        const char *start = p;
        while (*p && *p != '/')
            p++;
        if (p > start && path_push(out, outsz, plen, start, (size_t)(p - start)) != 0)
            return -1;
    }
    return 0;
}

int vfs_resolve(const char *cwd, const char *in, char *out, size_t outsz) {
    if (!in || !out || outsz < 2)
        return -1;
    out[0] = '/';
    out[1] = '\0';
    size_t plen = 1;
    /* A relative path starts from cwd; an absolute one starts from the root. */
    if (in[0] != '/' && cwd && cwd[0] == '/') {
        if (path_walk(cwd, out, outsz, &plen) != 0)
            return -1;
    }
    return path_walk(in, out, outsz, &plen);
}

int vfs_symlink(const char *path, const char *target) {
    if (!vfs_ready || !path || path[0] != '/' || !target || target[0] == '\0')
        return -1;
    if (lookup(path))
        return -2;                 /* EEXIST — link path already taken */

    char leaf[VFS_NAME_MAX];
    struct vfs_node *parent = 0;
    if (split_parent(path, leaf, &parent) != 0)
        return -3;                 /* a parent component is missing */

    struct vfs_node *n = create_child(parent, leaf, VFS_NODE_SYMLINK);
    if (!n)
        return -4;

    /* Store the target string verbatim (POSIX keeps the literal text, resolving
     * it only at traversal time). */
    size_t tlen = 0;
    while (target[tlen])
        tlen++;
    n->data = (uint8_t *)kmalloc(tlen + 1);
    if (!n->data) {
        /* Roll back the just-created node (create_child prepended it as head). */
        parent->children = n->next;
        kfree(n);
        return -5;
    }
    for (size_t i = 0; i < tlen; i++)
        n->data[i] = (uint8_t)target[i];
    n->data[tlen] = '\0';
    n->size = tlen;
    n->capacity = tlen + 1;

    if (symlink_hook)
        symlink_hook(path, target);
    return 0;
}

int vfs_readlink(const char *path, char *buf, size_t len) {
    if (!path || !buf || len == 0)
        return -1;
    struct vfs_node *node = lookup(path);
    if (!node || node->type != VFS_NODE_SYMLINK)
        return -1;
    size_t n = node->size;
    if (n > len)
        n = len;                   /* POSIX readlink truncates, does not NUL-end */
    for (size_t i = 0; i < n; i++)
        buf[i] = (char)node->data[i];
    return (int)n;
}

int vfs_realpath(const char *in, char *out, size_t outsz, int follow_final) {
    if (!in || in[0] != '/' || !out || outsz < 2)
        return -1;

    /* `out` accumulates the fully-dereferenced canonical prefix; `todo` holds the
     * components still to process. Both start from the input's root. */
    char todo[VFS_PATH_MAX];
    size_t ti = 0;
    while (in[ti] && ti < VFS_PATH_MAX - 1) {
        todo[ti] = in[ti];
        ti++;
    }
    todo[ti] = '\0';

    out[0] = '/';
    out[1] = '\0';
    size_t olen = 1;
    int hops = 0;
    size_t pos = 0;

    while (todo[pos]) {
        while (todo[pos] == '/')
            pos++;
        if (!todo[pos])
            break;
        size_t start = pos;
        while (todo[pos] && todo[pos] != '/')
            pos++;
        size_t clen = pos - start;

        /* Is any further component still queued after this one? */
        size_t q = pos;
        while (todo[q] == '/')
            q++;
        int has_more = (todo[q] != '\0');

        /* "." and ".." are pure-string operations on the resolved prefix. */
        if (clen == 1 && todo[start] == '.')
            continue;
        if (clen == 2 && todo[start] == '.' && todo[start + 1] == '.') {
            while (olen > 1 && out[olen - 1] != '/')
                olen--;
            if (olen > 1)
                olen--;
            if (olen == 0)
                olen = 1;
            out[olen] = '\0';
            continue;
        }

        /* Build candidate = out + "/" + component. `out` is already symlink-free,
         * so a plain lookup never silently traverses an intermediate symlink. */
        char cand[VFS_PATH_MAX];
        size_t ci = 0;
        for (; ci < olen; ci++)
            cand[ci] = out[ci];
        if (olen > 1 && ci < VFS_PATH_MAX - 1)
            cand[ci++] = '/';
        for (size_t k = 0; k < clen && ci < VFS_PATH_MAX - 1; k++)
            cand[ci++] = todo[start + k];
        cand[ci] = '\0';

        struct vfs_node *node = lookup(cand);
        if (node && node->type == VFS_NODE_SYMLINK && (has_more || follow_final)) {
            if (++hops > VFS_SYMLOOP_MAX)
                return -1;          /* ELOOP — too many indirections / a cycle */

            const char *tgt = (const char *)node->data;
            size_t tlen = node->size;
            size_t rest_len = 0;
            for (size_t k = pos; todo[k]; k++)
                rest_len++;
            /* Splice the target in front of the unprocessed remainder. */
            size_t need = tlen + (rest_len ? 1 + rest_len : 0);
            if (need >= VFS_PATH_MAX)
                return -1;          /* would overflow the work buffer */

            char nt[VFS_PATH_MAX];
            size_t ni = 0;
            for (size_t k = 0; k < tlen; k++)
                nt[ni++] = tgt[k];
            if (rest_len) {
                nt[ni++] = '/';
                for (size_t k = pos; todo[k]; k++)
                    nt[ni++] = todo[k];
            }
            nt[ni] = '\0';
            for (size_t k = 0; k <= ni; k++)
                todo[k] = nt[k];
            pos = 0;
            /* An absolute target restarts resolution from the root; a relative one
             * continues from the directory currently holding the link. */
            if (tgt[0] == '/') {
                out[0] = '/';
                out[1] = '\0';
                olen = 1;
            }
            continue;
        }

        /* Ordinary name (or an unfollowed final symlink, or a not-yet-existent
         * component): append it literally to the resolved prefix. */
        if (path_push(out, outsz, &olen, &todo[start], clen) != 0)
            return -1;
    }
    return 0;
}

int vfs_get_meta(const char *path, uint32_t *uid_out, uint32_t *gid_out, uint16_t *mode_out) {
    struct vfs_node *node = lookup(path);
    if (!node)
        return -1;
    if (uid_out)
        *uid_out = node->owner_uid;
    if (gid_out)
        *gid_out = node->owner_gid;
    if (mode_out)
        *mode_out = node->mode;
    return 0;
}

int vfs_chown(const char *path, uint32_t uid, uint32_t gid) {
    struct vfs_node *node = lookup(path);
    if (!node)
        return -1;
    node->owner_uid = uid;
    node->owner_gid = gid;
    node->ctime = rtc_unix_time();  /* ownership is inode status -> ctime only (Phase 29) */
    return 0;
}

int vfs_chmod(const char *path, uint16_t mode) {
    struct vfs_node *node = lookup(path);
    if (!node)
        return -1;
    node->mode = mode & 0777;
    node->ctime = rtc_unix_time();  /* permission is inode status -> ctime only,
                                     * never mtime (POSIX chmod) (Phase 29) */
    return 0;
}

/* Overwrite a node's three timestamps directly (Unix epoch seconds). Used by the
 * persistence replay to restore a file's real mtime/atime/ctime after recreating
 * it — without this, a replayed node would carry the reboot-time "now" stamp that
 * create_child/vfs_write_file just set. Pure mechanism: fires no change hook, so a
 * caller can correct the timestamps during mount without re-persisting them.
 * Returns 0 on success, -1 if the path does not exist. */
int vfs_set_times(const char *path, uint64_t mtime, uint64_t atime, uint64_t ctime) {
    struct vfs_node *node = lookup(path);
    if (!node)
        return -1;
    node->mtime = mtime;
    node->atime = atime;
    node->ctime = ctime;
    return 0;
}

int vfs_stat(const char *path, uint8_t *type_out, uint64_t *size_out,
             uint32_t *uid_out, uint32_t *gid_out, uint16_t *mode_out,
             uint64_t *mtime_out, uint64_t *atime_out, uint64_t *ctime_out) {
    struct vfs_node *node = lookup(path);
    if (!node)
        return -1;
    if (type_out)
        *type_out = node->type;
    /* A directory reports size 0; a file reports its byte length; a symlink
     * reports the length of its stored target path (POSIX lstat semantics). */
    if (size_out)
        *size_out = (node->type == VFS_NODE_DIR) ? 0 : (uint64_t)node->size;
    if (uid_out)
        *uid_out = node->owner_uid;
    if (gid_out)
        *gid_out = node->owner_gid;
    if (mode_out)
        *mode_out = node->mode;
    if (mtime_out)
        *mtime_out = node->mtime;
    if (atime_out)
        *atime_out = node->atime;
    if (ctime_out)
        *ctime_out = node->ctime;
    return 0;
}

int vfs_remove(const char *path) {
    if (!vfs_ready || !path || path[0] != '/')
        return -1;

    struct vfs_node *node = lookup(path);
    /* unlink() removes a regular file or a symbolic link (the link itself, never
     * its target — the caller resolves with follow_final=0). A directory needs
     * rmdir / remove_tree instead. */
    if (!node || (node->type != VFS_NODE_FILE && node->type != VFS_NODE_SYMLINK))
        return -2;

    struct vfs_node *parent = node->parent;
    if (!parent)
        return -3;

    /* Unlink from the parent's singly-linked child list. */
    struct vfs_node **link = &parent->children;
    while (*link && *link != node)
        link = &(*link)->next;
    if (*link != node)
        return -4;
    *link = node->next;

    if (node->data)
        kfree(node->data);
    kfree(node);

    if (remove_hook)
        remove_hook(path);
    return 0;
}

int vfs_rmdir(const char *path) {
    if (!vfs_ready || !path || path[0] != '/')
        return -1;
    if (strcmp(path, "/") == 0)
        return -2;                 /* never remove the root */

    struct vfs_node *node = lookup(path);
    if (!node || node->type != VFS_NODE_DIR)
        return -3;
    if (node->children)
        return -4;                 /* POSIX rmdir refuses a non-empty directory */

    struct vfs_node *parent = node->parent;
    if (!parent)
        return -5;

    struct vfs_node **link = &parent->children;
    while (*link && *link != node)
        link = &(*link)->next;
    if (*link != node)
        return -6;
    *link = node->next;

    kfree(node);                   /* a directory owns no data buffer */

    if (remove_hook)
        remove_hook(path);
    return 0;
}

/* Depth-first removal of the directory `dir`, whose absolute path occupies the
 * first `base` chars of the scratch buffer `path` (capacity VFS_PATH_MAX). Each
 * child is removed in turn — a file directly, a sub-directory by recursion — and
 * then `dir` itself is unlinked from its parent and freed. remove_hook fires for
 * every node so the persistence layer drops each corresponding entry. `dir` is
 * never the root (the public entry point rejects "/"). */
static void remove_subtree(struct vfs_node *dir, char *path, size_t base) {
    while (dir->children) {
        struct vfs_node *child = dir->children;
        size_t name_len = name_len_limited(child->name);
        /* Build the child's absolute path: path + "/" + name. If it would not
         * fit the buffer, drop the node without a hook rather than overflow or
         * leak — pathological given VFS_NAME_MAX/VFS_PATH_MAX, but fail-safe. */
        if (base + 1 + name_len + 1 > VFS_PATH_MAX) {
            dir->children = child->next;
            if (child->data)
                kfree(child->data);
            kfree(child);
            continue;
        }
        size_t len = base;
        path[len++] = '/';
        for (size_t i = 0; i < name_len; i++)
            path[len++] = child->name[i];
        path[len] = '\0';

        if (child->type == VFS_NODE_DIR) {
            remove_subtree(child, path, len);   /* unlinks + frees child itself */
        } else {
            dir->children = child->next;
            if (child->data)
                kfree(child->data);
            kfree(child);
            if (remove_hook)
                remove_hook(path);
        }
        path[base] = '\0';                      /* restore to dir's own path */
    }

    /* The directory is now empty: unlink it from its parent and free it. */
    struct vfs_node *parent = dir->parent;
    if (parent) {
        struct vfs_node **link = &parent->children;
        while (*link && *link != dir)
            link = &(*link)->next;
        if (*link == dir)
            *link = dir->next;
    }
    kfree(dir);
    if (remove_hook)
        remove_hook(path);                      /* path == dir's path (base len) */
}

int vfs_remove_tree(const char *path) {
    if (!vfs_ready || !path || path[0] != '/')
        return -1;
    if (strcmp(path, "/") == 0)
        return -2;                 /* never remove the root */

    struct vfs_node *node = lookup(path);
    if (!node)
        return -3;
    if (node->type == VFS_NODE_FILE)
        return vfs_remove(path);

    char buf[VFS_PATH_MAX];
    size_t n = 0;
    while (path[n] && n + 1 < VFS_PATH_MAX) {
        buf[n] = path[n];
        n++;
    }
    buf[n] = '\0';
    remove_subtree(node, buf, n);
    return 0;
}
