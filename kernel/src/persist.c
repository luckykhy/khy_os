/* persist.c — Mirror the VFS /disk subtree onto KhyFS.
 * @pattern Adapter
 *
 * Policy lives here, not in vfs.c: the generic VFS change hooks tell us when a
 * file is written/removed or a directory is created; we persist the whole
 * subtree under /disk. KhyFS is a flat table, so a nested path like
 * "/disk/proj/notes.txt" is stored under the relative key "proj/notes.txt"
 * (slashes and all). Directories are persisted as zero-byte DIR markers so an
 * empty directory survives reboot, and at mount we replay every entry —
 * recreating each parent directory before its children — to rebuild the tree
 * in the RAM VFS (Phase 14).
 */

#include "persist.h"
#include "diskfs.h"
#include "vfs.h"
#include "ata.h"
#include "serial.h"
#include "string.h"

#define PERSIST_PREFIX     "/disk/"
#define PERSIST_PREFIX_LEN 6           /* strlen("/disk/") */

/* Scratch for loading a file off disk into the VFS at boot. */
static uint8_t load_buf[DISKFS_MAX_FILE_SIZE];

/* Return the relative path under "/disk/" (e.g. "proj/notes.txt"), or NULL if
 * `path` is not within /disk, is the directory itself, has a trailing slash, or
 * is too long to fit a KhyFS name. Unlike the old flat model, embedded slashes
 * are allowed — they encode directory nesting in the flat KhyFS key. */
static const char *disk_relpath(const char *path) {
    for (int i = 0; i < PERSIST_PREFIX_LEN; i++)
        if (path[i] != PERSIST_PREFIX[i])
            return 0;
    const char *name = path + PERSIST_PREFIX_LEN;
    if (*name == '\0')
        return 0;                      /* the directory itself */

    size_t len = 0;
    for (const char *q = name; *q; q++)
        len++;
    if (name[len - 1] == '/')
        return 0;                      /* trailing slash — not a concrete entry */
    if (len >= DISKFS_NAME_MAX)
        return 0;                      /* too long for the flat key (caller warns) */
    return name;
}

/* After persisting an entry's contents, copy the VFS node's current timestamps
 * into its on-disk slot so they survive a reboot. `path` is the absolute VFS
 * path, `name` the KhyFS relative key. KhyFS stores 32-bit epoch seconds, which
 * the wall clock will not exceed until 2106. */
static void persist_times(const char *path, const char *name) {
    uint64_t mtime = 0, atime = 0, ctime = 0;
    if (vfs_stat(path, 0, 0, 0, 0, 0, &mtime, &atime, &ctime) != 0)
        return;
    diskfs_set_times(name, (uint32_t)mtime, (uint32_t)atime, (uint32_t)ctime);
}

static void on_write(const char *path, const void *data, size_t size) {
    const char *name = disk_relpath(path);
    if (!name) {
        /* Honest about the silent-drop boundary: a path under /disk that we
         * cannot key (too long) is NOT persisted. */
        if (memcmp(path, PERSIST_PREFIX, PERSIST_PREFIX_LEN) == 0) {
            serial_print("[KHYFS] skip persist (path too long): ");
            serial_print(path);
            serial_print("\n");
        }
        return;
    }
    if (size > DISKFS_MAX_FILE_SIZE) {
        serial_print("[KHYFS] skip persist (too large): ");
        serial_print(path);
        serial_print("\n");
        return;
    }
    if (diskfs_save(name, data, (uint32_t)size) != 0) {
        serial_print("[KHYFS] persist failed: ");
        serial_print(path);
        serial_print("\n");
        return;
    }
    persist_times(path, name);
}

static void on_remove(const char *path) {
    const char *name = disk_relpath(path);
    if (name)
        diskfs_remove(name);
}

static void on_mkdir(const char *path) {
    const char *name = disk_relpath(path);
    if (!name)
        return;
    if (diskfs_save_dir(name) != 0) {
        serial_print("[KHYFS] persist mkdir failed: ");
        serial_print(path);
        serial_print("\n");
        return;
    }
    persist_times(path, name);
}

static void on_symlink(const char *path, const char *target) {
    const char *name = disk_relpath(path);
    if (!name)
        return;
    if (diskfs_save_link(name, target) != 0) {
        serial_print("[KHYFS] persist symlink failed: ");
        serial_print(path);
        serial_print("\n");
        return;
    }
    persist_times(path, name);
}

/* Build "/disk/<relname>" into out (VFS_PATH_MAX). */
static void build_path(char *out, const char *relname) {
    int i = 0;
    for (; PERSIST_PREFIX[i]; i++)
        out[i] = PERSIST_PREFIX[i];
    int j = 0;
    while (relname[j] && i < VFS_PATH_MAX - 1)
        out[i++] = relname[j++];
    out[i] = '\0';
}

/* Create every ancestor directory of `path` in the VFS (idempotent). For
 * "/disk/a/b/c.txt" this mkdirs "/disk", "/disk/a", "/disk/a/b" — but not the
 * leaf. vfs_mkdir on an existing path is a no-op, so order across entries does
 * not matter: a child's parents are always materialised before the child. */
static void make_parents(const char *path) {
    char buf[VFS_PATH_MAX];
    int n = 0;
    while (path[n] && n < VFS_PATH_MAX - 1) {
        buf[n] = path[n];
        n++;
    }
    buf[n] = '\0';

    /* Walk slashes after the leading one; terminate at each to mkdir the prefix. */
    for (int i = 1; i < n; i++) {
        if (buf[i] == '/') {
            buf[i] = '\0';
            vfs_mkdir(buf);
            buf[i] = '/';
        }
    }
}

int persist_init(void) {
    if (!ata_present()) {
        serial_print("[KHYFS] no disk; /disk is not persistent\n");
        return -1;
    }

    /* Mount an existing filesystem, or lay down a fresh one. */
    if (diskfs_mount() != 0) {
        serial_print("[KHYFS] no valid filesystem; formatting\n");
        if (diskfs_format() != 0) {
            serial_print("[KHYFS] format failed; /disk is not persistent\n");
            return -2;
        }
    } else {
        serial_print("[KHYFS] mounted existing filesystem (");
        serial_print_dec(diskfs_count());
        serial_print(" entries)\n");
    }

    /* Expose the persistent root and replay every entry into the RAM tree,
     * recreating parent directories first. Hooks are installed AFTER the replay
     * so this reconstruction does not re-persist what it just read. */
    vfs_mkdir(PERSIST_PREFIX);   /* "/disk/" → creates "/disk" */

    char path[VFS_PATH_MAX];
    char name[DISKFS_NAME_MAX];
    for (int i = 0; i < DISKFS_MAX_FILES; i++) {
        uint32_t size = 0;
        uint32_t kind = DISKFS_KIND_FILE;
        uint32_t mtime = 0, atime = 0, ctime = 0;
        if (diskfs_entry(i, name, &size, &kind, &mtime, &atime, &ctime) != 1)
            continue;
        build_path(path, name);
        make_parents(path);
        if (kind == DISKFS_KIND_DIR) {
            vfs_mkdir(path);
        } else if (kind == DISKFS_KIND_SYMLINK) {
            /* The link's stored data is its target text; force a NUL terminator
             * (KhyFS keeps the raw bytes without one) before recreating it. */
            uint32_t got = 0;
            if (diskfs_read(name, load_buf, DISKFS_MAX_FILE_SIZE - 1, &got) != 0)
                continue;
            load_buf[got] = '\0';
            vfs_symlink(path, (const char *)load_buf);
        } else {
            uint32_t got = 0;
            if (diskfs_read(name, load_buf, DISKFS_MAX_FILE_SIZE, &got) != 0)
                continue;
            vfs_write_file(path, load_buf, got, 0);
        }
        /* Recreating the node above stamped it with "now"; put back the persisted
         * timestamps. A zero mtime means a pre-Phase-30 slot carried no times, so
         * leave the just-stamped "now" rather than rewriting the epoch to 1970. */
        if (mtime != 0)
            vfs_set_times(path, mtime, atime, ctime);
    }

    vfs_set_write_hook(on_write);
    vfs_set_remove_hook(on_remove);
    vfs_set_mkdir_hook(on_mkdir);
    vfs_set_symlink_hook(on_symlink);
    serial_print("[KHYFS] /disk is persistent\n");
    return 0;
}
