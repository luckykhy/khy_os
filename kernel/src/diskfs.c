/* diskfs.c — KhyFS persistent filesystem over the ATA block driver.
 * @pattern Strategy
 *
 * See diskfs.h for the on-disk layout. The directory is cached in RAM at
 * mount time; mutations rewrite only the affected directory sector plus the
 * file's data extent. Every public mutating call runs inside a single-CPU
 * critical section so the ATA register sequence is never interleaved by a
 * preempting task (the kernel is single-core; ATA PIO has no IRQ).
 */

#include "diskfs.h"
#include "ata.h"
#include "serial.h"
#include "string.h"

#define DISKFS_MAGIC      "KHYFS1"   /* 6 chars + NUL + pad in an 8-byte field */
#define DISKFS_VERSION    2          /* v2 (Phase 30): 128-byte slots carry timestamps */
#define DISKFS_DIR_LBA    1
#define DISKFS_DIR_SECTS  (DISKFS_MAX_FILES / DISKFS_SLOTS_PER_SECTOR)
#define DISKFS_DATA_LBA   (DISKFS_DIR_LBA + DISKFS_DIR_SECTS)

/* On-disk superblock (lives in LBA 0; only the first sizeof bytes are used). */
struct diskfs_super {
    char     magic[8];
    uint32_t version;
    uint32_t max_files;
    uint32_t dir_lba;
    uint32_t dir_sectors;
    uint32_t data_lba;
    uint32_t sectors_per_file;
};

/* One 128-byte directory slot; 4 fit exactly in a 512-byte sector (Phase 30 grew
 * it from 64 bytes to make room for the three Unix-epoch timestamps). */
struct diskfs_slot {
    char     name[DISKFS_NAME_MAX];   /* 48 — may be a slash-separated relpath */
    uint32_t used;                    /*  4 */
    uint32_t size;                    /*  4 */
    uint32_t kind;                    /*  4 — DISKFS_KIND_FILE / _DIR / _SYMLINK */
    uint32_t mtime;                   /*  4 — last content change, epoch seconds */
    uint32_t atime;                   /*  4 — last content read */
    uint32_t ctime;                   /*  4 — last status change */
    uint32_t reserved[13];            /* 52 → 128 bytes total */
};

static int                 mounted;
static struct diskfs_slot  dir_cache[DISKFS_MAX_FILES];

/* Static IO scratch — kept off the caller's stack. */
static uint8_t sect_buf[512];
static uint8_t data_buf[DISKFS_MAX_FILE_SIZE];

/* Disable interrupts for the duration of an ATA register sequence so a timer
 * preemption can't splice another task's transfer into ours. Restores the
 * caller's prior IF (boot runs with interrupts already off). */
static inline uint64_t crit_enter(void) {
    uint64_t flags;
    __asm__ volatile("pushfq; pop %0; cli" : "=r"(flags) :: "memory");
    return flags;
}
static inline void crit_leave(uint64_t flags) {
    __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");
}

static uint32_t file_data_lba(int slot) {
    return (uint32_t)DISKFS_DATA_LBA + (uint32_t)slot * DISKFS_SECTORS_PER_FILE;
}

/* Read the directory sector that contains `slot` back to disk. */
static int flush_dir_sector(int slot) {
    int sect = slot / DISKFS_SLOTS_PER_SECTOR;     /* which directory sector */
    int base = sect * DISKFS_SLOTS_PER_SECTOR;     /* first slot in that sector */
    memcpy(sect_buf, &dir_cache[base], 512);       /* 4 * 128 = 512 bytes */
    return ata_write((uint32_t)DISKFS_DIR_LBA + sect, 1, sect_buf);
}

static int name_eq(const char *a, const char *b) {
    return strcmp(a, b) == 0;
}

static int find_slot(const char *name) {
    for (int i = 0; i < DISKFS_MAX_FILES; i++)
        if (dir_cache[i].used && name_eq(dir_cache[i].name, name))
            return i;
    return -1;
}

static int find_free(void) {
    for (int i = 0; i < DISKFS_MAX_FILES; i++)
        if (!dir_cache[i].used)
            return i;
    return -1;
}

int diskfs_mount(void) {
    mounted = 0;
    if (!ata_present())
        return -1;

    uint64_t f = crit_enter();

    if (ata_read(0, 1, sect_buf) != 0) {
        crit_leave(f);
        return -2;
    }
    struct diskfs_super sb;
    memcpy(&sb, sect_buf, sizeof(sb));

    if (memcmp(sb.magic, DISKFS_MAGIC, 6) != 0 ||
        sb.version != DISKFS_VERSION ||
        sb.max_files != DISKFS_MAX_FILES ||
        sb.dir_lba != DISKFS_DIR_LBA ||
        sb.dir_sectors != DISKFS_DIR_SECTS ||
        sb.data_lba != DISKFS_DATA_LBA ||
        sb.sectors_per_file != DISKFS_SECTORS_PER_FILE) {
        crit_leave(f);
        return -3;   /* unformatted or geometry mismatch */
    }

    /* Pull the whole directory into the RAM cache. */
    for (int s = 0; s < DISKFS_DIR_SECTS; s++) {
        if (ata_read((uint32_t)DISKFS_DIR_LBA + s, 1, sect_buf) != 0) {
            crit_leave(f);
            return -4;
        }
        memcpy(&dir_cache[s * DISKFS_SLOTS_PER_SECTOR], sect_buf, 512);
    }

    /* [SAFE] On-disk directory metadata is untrusted: a corrupted or crafted
     * disk can carry any 32-bit slot size. An out-of-range size would later
     * make diskfs_read compute a sector count that, truncated to the uint8_t
     * ata_read count, drives a multi-sector PIO transfer far past the
     * 4096-byte data_buf — a kernel BSS overflow (and an oversized memcpy back
     * to the caller). Enforce the per-file extent invariant here at the single
     * mount gate, so every later consumer (diskfs_read, diskfs_entry) sees a
     * size bounded by DISKFS_MAX_FILE_SIZE. Writes after mount already cap len
     * at entry, so this is the only place an illegal size can enter. */
    for (int i = 0; i < DISKFS_MAX_FILES; i++) {
        if (dir_cache[i].used && dir_cache[i].size > DISKFS_MAX_FILE_SIZE)
            dir_cache[i].size = DISKFS_MAX_FILE_SIZE;
        /* An out-of-range kind from a crafted/old disk falls back to FILE so
         * replay treats it as data, never as an unexpected control value. */
        if (dir_cache[i].used && dir_cache[i].kind > DISKFS_KIND_SYMLINK)
            dir_cache[i].kind = DISKFS_KIND_FILE;
    }

    crit_leave(f);
    mounted = 1;
    return 0;
}

int diskfs_format(void) {
    if (!ata_present())
        return -1;

    uint64_t f = crit_enter();

    /* Superblock. */
    struct diskfs_super sb;
    memset(&sb, 0, sizeof(sb));
    memcpy(sb.magic, DISKFS_MAGIC, 6);
    sb.version          = DISKFS_VERSION;
    sb.max_files        = DISKFS_MAX_FILES;
    sb.dir_lba          = DISKFS_DIR_LBA;
    sb.dir_sectors      = DISKFS_DIR_SECTS;
    sb.data_lba         = DISKFS_DATA_LBA;
    sb.sectors_per_file = DISKFS_SECTORS_PER_FILE;

    memset(sect_buf, 0, 512);
    memcpy(sect_buf, &sb, sizeof(sb));
    if (ata_write(0, 1, sect_buf) != 0) {
        crit_leave(f);
        return -2;
    }

    /* Zero the directory region (on disk and in the RAM cache). */
    memset(dir_cache, 0, sizeof(dir_cache));
    memset(sect_buf, 0, 512);
    for (int s = 0; s < DISKFS_DIR_SECTS; s++) {
        if (ata_write((uint32_t)DISKFS_DIR_LBA + s, 1, sect_buf) != 0) {
            crit_leave(f);
            return -3;
        }
    }

    crit_leave(f);
    mounted = 1;
    serial_print("[KHYFS] formatted fresh filesystem\n");
    return 0;
}

int diskfs_mounted(void) {
    return mounted;
}

static int save_entry(const char *name, const void *data, uint32_t len, uint32_t kind);

int diskfs_save(const char *name, const void *data, uint32_t len) {
    return save_entry(name, data, len, DISKFS_KIND_FILE);
}

int diskfs_save_dir(const char *name) {
    /* A directory has no data extent; persist a zero-byte marker carrying the
     * DIR kind so the empty directory reappears on the next mount. */
    return save_entry(name, 0, 0, DISKFS_KIND_DIR);
}

int diskfs_save_link(const char *name, const char *target) {
    /* A symlink's "data" is its target path text; store it under the SYMLINK
     * kind so mount/replay recreates the link rather than a plain file. */
    if (!target)
        return -1;
    uint32_t len = (uint32_t)strlen(target);
    return save_entry(name, target, len, DISKFS_KIND_SYMLINK);
}

static int save_entry(const char *name, const void *data, uint32_t len, uint32_t kind) {
    if (!mounted || !name || name[0] == '\0')
        return -1;
    if (len > DISKFS_MAX_FILE_SIZE)
        return -2;

    uint32_t sectors = (len + 511) / 512;
    if (sectors == 0)
        sectors = 1;

    /* [SAFE] The whole save — slot selection, the shared data_buf fill, the ATA
     * write, and the dir_cache commit — must be ONE atomic critical section.
     * Previously data_buf was filled OUTSIDE crit, so a timer preemption between
     * the fill and the ata_write let a second diskfs caller overwrite the shared
     * scratch and persist the wrong file's bytes (cross-task data corruption /
     * isolation breach); find_free() was likewise racy (two new files could claim
     * the same slot). Mask interrupts across the entire operation. Work is bounded
     * (≤ DISKFS_MAX_FILE_SIZE copy) so interrupt latency stays bounded, and
     * masking is deadlock-immune (not a lock). */
    uint64_t f = crit_enter();

    int slot = find_slot(name);
    if (slot < 0) {
        slot = find_free();
        if (slot < 0) {
            crit_leave(f);
            return -3;   /* directory full */
        }
    }

    /* Assemble the data extent: payload then zero pad to a sector boundary. */
    memset(data_buf, 0, (size_t)sectors * 512);
    if (len && data)
        memcpy(data_buf, data, len);

    if (ata_write(file_data_lba(slot), (uint8_t)sectors, data_buf) != 0) {
        crit_leave(f);
        return -4;
    }

    /* Commit the directory slot. */
    memset(&dir_cache[slot], 0, sizeof(dir_cache[slot]));
    size_t nl = 0;
    while (name[nl] && nl < DISKFS_NAME_MAX - 1) {
        dir_cache[slot].name[nl] = name[nl];
        nl++;
    }
    dir_cache[slot].name[nl] = '\0';
    dir_cache[slot].used = 1;
    dir_cache[slot].size = len;
    dir_cache[slot].kind = kind;

    int rc = flush_dir_sector(slot);
    crit_leave(f);
    return rc == 0 ? 0 : -5;
}

int diskfs_read(const char *name, void *buf, uint32_t max, uint32_t *out_size) {
    if (!mounted || !name || !buf)
        return -1;

    /* [SAFE] Hold crit across the slot lookup, the ATA read into the shared
     * data_buf, AND the drain into the caller's buffer. The old code dropped crit
     * right after ata_read, so a preempting diskfs call could overwrite data_buf
     * before this memcpy ran — handing the caller another file's bytes. Keeping
     * the memcpy inside the section closes that window; n is bounded by both the
     * (mount-clamped) file size and the caller's max, so latency stays bounded. */
    uint64_t f = crit_enter();

    int slot = find_slot(name);
    if (slot < 0) {
        crit_leave(f);
        return -2;
    }

    uint32_t size = dir_cache[slot].size;
    uint32_t sectors = (size + 511) / 512;
    if (sectors == 0)
        sectors = 1;

    int rc = ata_read(file_data_lba(slot), (uint8_t)sectors, data_buf);
    if (rc != 0) {
        crit_leave(f);
        return -3;
    }

    uint32_t n = (size < max) ? size : max;
    memcpy(buf, data_buf, n);
    crit_leave(f);

    if (out_size)
        *out_size = size;
    return 0;
}

int diskfs_set_times(const char *name, uint32_t mtime, uint32_t atime, uint32_t ctime) {
    if (!mounted || !name)
        return -1;
    uint64_t f = crit_enter();
    int slot = find_slot(name);
    if (slot < 0) {
        crit_leave(f);
        return -2;
    }
    dir_cache[slot].mtime = mtime;
    dir_cache[slot].atime = atime;
    dir_cache[slot].ctime = ctime;
    int rc = flush_dir_sector(slot);
    crit_leave(f);
    return rc == 0 ? 0 : -3;
}

int diskfs_remove(const char *name) {
    if (!mounted || !name)
        return -1;

    /* [SAFE] Look up and clear the slot inside one critical section so the
     * lookup can't race a concurrent diskfs_save reusing the same slot. */
    uint64_t f = crit_enter();
    int slot = find_slot(name);
    if (slot < 0) {
        crit_leave(f);
        return -2;
    }
    memset(&dir_cache[slot], 0, sizeof(dir_cache[slot]));
    int rc = flush_dir_sector(slot);
    crit_leave(f);
    return rc == 0 ? 0 : -3;
}

int diskfs_count(void) {
    int n = 0;
    for (int i = 0; i < DISKFS_MAX_FILES; i++)
        if (dir_cache[i].used)
            n++;
    return n;
}

int diskfs_entry(int i, char name_out[DISKFS_NAME_MAX], uint32_t *size_out,
                 uint32_t *kind_out, uint32_t *mtime_out, uint32_t *atime_out,
                 uint32_t *ctime_out) {
    if (i < 0 || i >= DISKFS_MAX_FILES)
        return -1;
    if (!dir_cache[i].used)
        return 0;
    if (name_out) {
        size_t k = 0;
        while (dir_cache[i].name[k] && k < DISKFS_NAME_MAX - 1) {
            name_out[k] = dir_cache[i].name[k];
            k++;
        }
        name_out[k] = '\0';
    }
    if (size_out)
        *size_out = dir_cache[i].size;
    if (kind_out)
        *kind_out = dir_cache[i].kind;
    if (mtime_out)
        *mtime_out = dir_cache[i].mtime;
    if (atime_out)
        *atime_out = dir_cache[i].atime;
    if (ctime_out)
        *ctime_out = dir_cache[i].ctime;
    return 1;
}
