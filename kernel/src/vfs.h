/* vfs.h — Minimal in-kernel VFS interface * @pattern Strategy
 */
#ifndef VFS_H
#define VFS_H

#include <stddef.h>
#include <stdint.h>

#define VFS_NAME_MAX  48
#define VFS_PATH_MAX  256

enum vfs_node_type {
    VFS_NODE_FILE    = 1,
    VFS_NODE_DIR     = 2,
    VFS_NODE_SYMLINK = 3,   /* stores a target path string in its data buffer */
};

struct vfs_dirent {
    char name[VFS_NAME_MAX];
    uint8_t type;
    uint64_t size;
};

int vfs_init(void);
int vfs_mkdir(const char *path);
int vfs_write_file(const char *path, const void *data, size_t len, int append);

/* Resize the regular file at `path` to exactly `new_size` bytes. Growing extends
 * the file with zero bytes; shrinking discards the trailing bytes (the backing
 * buffer is kept, only the logical size changes). Fires the write hook so the new
 * contents are mirrored to durable storage. Returns 0 on success, -1 if the path
 * is not a regular file, the size arithmetic would overflow, or allocation fails. */
int vfs_truncate(const char *path, size_t new_size);

/* Move/rename a regular file or symlink. The node is relinked in place, so open
 * descriptors keep their data; only its tree position and leaf name change. The
 * destination must not already exist (no clobber) and its parent directory must
 * exist. Directory rename is rejected (subtree re-persistence is not yet
 * expressible through the single-key persist hooks). Returns 0 on success, -1 on
 * a bad/absent or directory/root source, a missing destination parent, or an
 * existing destination. */
int vfs_rename(const char *oldpath, const char *newpath);

int vfs_read_file(const char *path, void *buf, size_t len);
int vfs_read_file_at(const char *path, void *buf, size_t len, size_t offset);
int vfs_get_size(const char *path, size_t *out_size);
int vfs_list_dir(const char *path, struct vfs_dirent *out, size_t max_entries);
int vfs_list_dir_at(const char *path, size_t start, struct vfs_dirent *out,
                    size_t max_entries);
int vfs_is_dir(const char *path);
int vfs_exists(const char *path);

/* Resolve `in` against the base directory `cwd` into a normalized absolute path
 * in `out` (capacity `outsz`). An absolute `in` ignores `cwd`; a relative `in`
 * is taken relative to `cwd`. "." and empty components are dropped, ".." pops a
 * component (clamped at root). Returns 0 on success, -1 on a bad argument or if
 * the result would not fit. Pure string mechanism — does not touch the tree. */
int vfs_resolve(const char *cwd, const char *in, char *out, size_t outsz);

/* Symbolic links (Phase 17). A symlink is a node whose data buffer holds a target
 * path string (absolute or relative). vfs_symlink creates one at `path` storing
 * `target` verbatim (no resolution) — returns 0, or <0 if `path` exists, its
 * parent is missing, or allocation fails. vfs_readlink copies the raw target (up
 * to `len` bytes, NOT NUL-terminated, POSIX style) into `buf` and returns its
 * length, or <0 if `path` is not a symlink. */
int vfs_symlink(const char *path, const char *target);
int vfs_readlink(const char *path, char *buf, size_t len);

/* Canonicalize the absolute path `in` into `out` (capacity `outsz`), dereferencing
 * symbolic links. Intermediate symlink components are ALWAYS followed; the final
 * component is followed only when `follow_final` is set (so unlink/readlink can
 * act on the link itself). Relative link targets resolve against the directory
 * holding the link; absolute targets restart from the root. Non-existent
 * components are kept verbatim (so create paths like open(O_CREAT) work). Returns
 * 0 on success, -1 on a bad argument, an overflow, or a symlink loop (ELOOP). */
int vfs_realpath(const char *in, char *out, size_t outsz, int follow_final);

/* Remove a regular file. Returns 0 on success, <0 if absent or it is a
 * directory. Frees the node and its backing buffer. */
int vfs_remove(const char *path);

/* Remove an EMPTY directory (POSIX rmdir). Returns 0 on success, <0 if the path
 * is absent, is not a directory, still has children, or is the root. Fires the
 * remove hook so persistence drops the directory's marker. */
int vfs_rmdir(const char *path);

/* Recursively remove a file or a whole directory subtree (POSIX `rm -r`). For a
 * file this is vfs_remove; for a directory it removes every descendant
 * depth-first and then the directory itself, firing the remove hook for each
 * node so persistence drops every corresponding entry. Returns 0 on success, <0
 * if the path is absent or is the root. */
int vfs_remove_tree(const char *path);

/* Ownership & permission metadata (Phase 13 — DAC). Each node carries an owner
 * uid/gid and a 9-bit rwxrwxrwx mode. New files default to 0644, directories to
 * 0755, both owned by root (0); the syscall layer re-owns a user-created file to
 * its creator. These accessors are pure mechanism — they enforce no policy, so
 * kernel callers (services, persistence replay) are unaffected; the syscall
 * layer applies the access checks. vfs_get_meta returns 0 and fills any non-NULL
 * out-param, or -1 if the path does not exist. */
int vfs_get_meta(const char *path, uint32_t *uid_out, uint32_t *gid_out, uint16_t *mode_out);
int vfs_chown(const char *path, uint32_t uid, uint32_t gid);
int vfs_chmod(const char *path, uint16_t mode);

/* One-shot metadata snapshot for stat(2): a single lookup filling any non-NULL
 * out-param — node type (a VFS_NODE_* value), size in bytes (file contents,
 * symlink target length, or 0 for a directory), owner uid/gid, 9-bit mode, and
 * the three POSIX timestamps in Unix epoch seconds: mtime (last content/size
 * change), atime (last content read) and ctime (last status change: write,
 * chmod, chown or rename). All three are stamped equal at creation. Returns 0 on
 * success, -1 if the path does not exist. Pure mechanism (no access checks),
 * like the other vfs_get_* accessors. */
int vfs_stat(const char *path, uint8_t *type_out, uint64_t *size_out,
             uint32_t *uid_out, uint32_t *gid_out, uint16_t *mode_out,
             uint64_t *mtime_out, uint64_t *atime_out, uint64_t *ctime_out);

/* Restore a node's mtime/atime/ctime (Unix epoch seconds) directly, firing no
 * change hook — used by the persistence replay to put back a file's real
 * timestamps after recreating it. Returns 0 on success, -1 if absent. */
int vfs_set_times(const char *path, uint64_t mtime, uint64_t atime, uint64_t ctime);

/* Change hooks let a higher layer (e.g. a persistence bridge) mirror file
 * mutations to durable storage without the VFS depending on it. The write hook
 * fires after a file's contents are committed in RAM; the remove hook fires
 * after a file is unlinked; the mkdir hook fires after a new directory is
 * created (not when the path already existed); the symlink hook fires after a
 * new symbolic link is created, carrying its target. Any may be NULL to disable. */
typedef void (*vfs_write_hook_t)(const char *path, const void *data, size_t size);
typedef void (*vfs_remove_hook_t)(const char *path);
typedef void (*vfs_mkdir_hook_t)(const char *path);
typedef void (*vfs_symlink_hook_t)(const char *path, const char *target);
void vfs_set_write_hook(vfs_write_hook_t hook);
void vfs_set_remove_hook(vfs_remove_hook_t hook);
void vfs_set_mkdir_hook(vfs_mkdir_hook_t hook);
void vfs_set_symlink_hook(vfs_symlink_hook_t hook);

#endif
