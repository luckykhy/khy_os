/* agentconf.c — read/write the persisted agent config at /disk/etc/agent.conf.
 *
 * Format: one `key=value` per line, '\n'-separated. Whole-file rewrite on set
 * (the config is tiny, AGENTCONF_MAX bytes). All persistence rides the ordinary
 * VFS calls under /disk, which the persist.c hooks mirror to KhyFS — so the file
 * survives reboot with no special-casing here.
 */
#include "agentconf.h"
#include "vfs.h"
#include "string.h"

/* A key is a simple token: 1..AGENTCONF_KEY_MAX bytes, no '=', no whitespace,
 * no newline (so it can never be confused with the separator or a line break). */
static int key_ok(const char *key, size_t *out_len) {
    if (!key)
        return 0;
    size_t n = 0;
    for (const char *c = key; *c; c++, n++) {
        if (n >= AGENTCONF_KEY_MAX)
            return 0;
        char ch = *c;
        if (ch == '=' || ch == '\n' || ch == '\r' || ch == ' ' || ch == '\t')
            return 0;
    }
    if (n == 0)
        return 0;
    *out_len = n;
    return 1;
}

/* A value is the rest of the line: any bytes except '\n'/'\r', up to VAL_MAX. */
static int val_ok(const char *val, size_t *out_len) {
    if (!val)
        return 0;
    size_t n = 0;
    for (const char *c = val; *c; c++, n++) {
        if (n >= AGENTCONF_VAL_MAX)
            return 0;
        if (*c == '\n' || *c == '\r')
            return 0;
    }
    *out_len = n;
    return 1;
}

/* /disk present and a directory? Setters/getters degrade (not wedge) without it. */
static int disk_ready(void) {
    return vfs_exists("/disk") && vfs_is_dir("/disk");
}

/* Does buffer line [start,end) begin with "key="? Returns 1 on match. */
static int line_has_key(const char *buf, size_t start, size_t end,
                        const char *key, size_t klen) {
    if (end - start < klen + 1)        /* need at least key + '=' */
        return 0;
    for (size_t i = 0; i < klen; i++) {
        if (buf[start + i] != key[i])
            return 0;
    }
    return buf[start + klen] == '=';
}

int agentconf_set(const char *key, const char *value) {
    size_t klen = 0, vlen = 0;
    if (!key_ok(key, &klen) || !val_ok(value, &vlen))
        return AGENTCONF_EINVAL;
    if (!disk_ready())
        return AGENTCONF_ENODISK;

    /* Ensure /disk/etc exists (no-op if already there). */
    vfs_mkdir("/disk/etc");
    if (!vfs_is_dir("/disk/etc"))
        return AGENTCONF_EIO;

    /* Load the current file (absent file = empty). */
    char old[AGENTCONF_MAX];
    size_t oldlen = 0;
    size_t fsize = 0;
    if (vfs_get_size(AGENTCONF_PATH, &fsize) == 0) {
        if (fsize > sizeof(old))
            fsize = sizeof(old);           /* defensive clamp; never overrun */
        int r = vfs_read_file(AGENTCONF_PATH, old, fsize);
        if (r < 0)
            return AGENTCONF_EIO;
        oldlen = (size_t)r;
    }

    /* Rewrite: copy every line whose key differs, then append the new line. */
    char out[AGENTCONF_MAX];
    size_t outlen = 0;
    size_t i = 0;
    while (i < oldlen) {
        size_t j = i;
        while (j < oldlen && old[j] != '\n')
            j++;
        size_t line_end = (j < oldlen) ? j + 1 : j;   /* include the '\n' if any */
        if (!line_has_key(old, i, j, key, klen)) {
            size_t span = line_end - i;
            if (outlen + span > sizeof(out))
                return AGENTCONF_EIO;                  /* would overflow; refuse */
            memcpy(out + outlen, old + i, span);
            outlen += span;
        }
        i = line_end;
    }

    /* Append "key=value\n". */
    if (outlen + klen + 1 + vlen + 1 > sizeof(out))
        return AGENTCONF_EIO;
    memcpy(out + outlen, key, klen);          outlen += klen;
    out[outlen++] = '=';
    memcpy(out + outlen, value, vlen);        outlen += vlen;
    out[outlen++] = '\n';

    if (vfs_write_file(AGENTCONF_PATH, out, outlen, 0 /* overwrite */) < 0)
        return AGENTCONF_EIO;
    return AGENTCONF_OK;
}

int agentconf_get(const char *key, char *out, size_t cap) {
    size_t klen = 0;
    if (!key_ok(key, &klen) || !out || cap == 0)
        return AGENTCONF_EINVAL;
    if (!disk_ready())
        return AGENTCONF_ENODISK;

    char buf[AGENTCONF_MAX];
    size_t fsize = 0;
    if (vfs_get_size(AGENTCONF_PATH, &fsize) != 0)
        return AGENTCONF_ENOENT;                       /* file not created yet */
    if (fsize > sizeof(buf))
        fsize = sizeof(buf);
    int r = vfs_read_file(AGENTCONF_PATH, buf, fsize);
    if (r < 0)
        return AGENTCONF_EIO;
    size_t len = (size_t)r;

    size_t i = 0;
    while (i < len) {
        size_t j = i;
        while (j < len && buf[j] != '\n')
            j++;
        if (line_has_key(buf, i, j, key, klen)) {
            size_t vstart = i + klen + 1;              /* past "key=" */
            size_t vlen = j - vstart;
            if (vlen + 1 > cap)
                return AGENTCONF_EINVAL;                /* caller buffer too small */
            memcpy(out, buf + vstart, vlen);
            out[vlen] = '\0';
            return (int)vlen;
        }
        i = (j < len) ? j + 1 : j;
    }
    return AGENTCONF_ENOENT;
}
