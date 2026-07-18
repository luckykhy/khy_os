/* diskfs.h — KhyFS: a minimal persistent on-disk filesystem over ATA.
 * @pattern Strategy
 *
 * Layout (512-byte LBA sectors on the primary master):
 *   LBA 0            superblock (magic + geometry)
 *   LBA 1 .. 16      directory: 64 fixed 128-byte slots (4 per sector)
 *   LBA 17 ..        data region: each file owns a fixed 8-sector (4 KiB) extent
 *
 * No fragmentation, no allocator: slot i's data lives at a fixed LBA, so a
 * file's bytes never move. The namespace is a single flat table, but an entry's
 * `name` may itself be a slash-separated relative path (e.g. "proj/notes.txt"),
 * which is how persist.c models a nested directory tree on top of this flat
 * store (Phase 14). Each slot carries a `kind` so empty directories — which have
 * no data — persist as first-class entries, not just as a side effect of the
 * files inside them. Each slot also carries the entry's mtime/atime/ctime as
 * 32-bit Unix epoch seconds (Phase 30), so a file's timestamps survive a reboot
 * instead of being reborn as "now" on every mount. Deliberately simple and
 * robust, not a general-purpose FS.
 */
#ifndef DISKFS_H
#define DISKFS_H

#include <stdint.h>
#include <stddef.h>

#define DISKFS_NAME_MAX        48     /* matches VFS_NAME_MAX */
#define DISKFS_MAX_FILES       64
#define DISKFS_SLOTS_PER_SECTOR 4     /* 512 / sizeof(diskfs_slot) = 512 / 128 */
#define DISKFS_SECTORS_PER_FILE 8     /* 8 * 512 = 4096 bytes per file */
#define DISKFS_MAX_FILE_SIZE   (DISKFS_SECTORS_PER_FILE * 512)

/* Entry kind, stored per directory slot. Old (pre-Phase-14) disks wrote this
 * field as 0, so existing entries mount as plain files — format-compatible. */
#define DISKFS_KIND_FILE       0
#define DISKFS_KIND_DIR        1
#define DISKFS_KIND_SYMLINK    2     /* data region holds the link's target text */

/* Mount an already-formatted disk into the in-RAM directory cache.
 * Returns 0 if a valid KhyFS was found, <0 otherwise (e.g. blank disk). */
int diskfs_mount(void);

/* Lay down a fresh, empty KhyFS (superblock + zeroed directory) and mount it. */
int diskfs_format(void);

/* True once mount/format has succeeded. */
int diskfs_mounted(void);

/* Create or overwrite `name` with `len` bytes. len must be <= DISKFS_MAX_FILE_SIZE.
 * Returns 0 on success, <0 on error (no disk, too big, directory full). */
int diskfs_save(const char *name, const void *data, uint32_t len);

/* Persist a directory marker named `name` (a zero-byte DISKFS_KIND_DIR entry) so
 * an empty directory survives reboot. Returns 0 on success, <0 on error. */
int diskfs_save_dir(const char *name);

/* Persist a symbolic link named `name` whose stored data is the target path
 * string `target` (a DISKFS_KIND_SYMLINK entry). Returns 0 on success, <0 on
 * error. */
int diskfs_save_link(const char *name, const char *target);

/* Set the stored timestamps (Unix epoch seconds) of an existing entry and flush
 * its directory sector. Called by the persistence layer after a save so the
 * on-disk slot carries the VFS node's real mtime/atime/ctime. Returns 0 on
 * success, <0 if `name` is absent / no disk. */
int diskfs_set_times(const char *name, uint32_t mtime, uint32_t atime, uint32_t ctime);

/* Read `name` into `buf` (up to `max` bytes); *out_size gets the true size.
 * Returns 0 on success, <0 if not found / no disk. */
int diskfs_read(const char *name, void *buf, uint32_t max, uint32_t *out_size);

/* Remove `name`. Returns 0 if removed, <0 if absent / no disk. */
int diskfs_remove(const char *name);

/* Number of used directory slots. */
int diskfs_count(void);

/* Enumerate slots by index. Returns 1 and fills the out-params if slot `i` is
 * used, 0 if the slot is free, -1 if `i` is out of range. Any out-param may be
 * NULL. `kind_out` receives DISKFS_KIND_*; the time out-params receive the
 * stored mtime/atime/ctime (Unix epoch seconds, 0 on a pre-Phase-30 disk). */
int diskfs_entry(int i, char name_out[DISKFS_NAME_MAX], uint32_t *size_out,
                 uint32_t *kind_out, uint32_t *mtime_out, uint32_t *atime_out,
                 uint32_t *ctime_out);

#endif /* DISKFS_H */
