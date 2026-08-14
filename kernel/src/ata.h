/* ata.h — Minimal ATA (IDE) PIO block driver for KHY OS * @pattern Adapter
 *
 * Polling-mode 28-bit LBA access to the primary-bus master drive (ports
 * 0x1F0-0x1F7 / control 0x3F6). No IRQ is used: reads and writes spin on the
 * status register, which keeps the driver self-contained and reentrancy-free.
 * Provides the persistent block storage the in-RAM ramfs cannot.
 */
#ifndef ATA_H
#define ATA_H

#include <stdint.h>

#define ATA_SECTOR_SIZE 512

/* Detect and identify the primary master. Returns 0 if a disk is present,
 * negative otherwise. Safe to call when no disk is attached (bounded polling). */
int ata_init(void);

/* 1 if a usable disk was found by ata_init(), else 0. */
int ata_present(void);

/* Total addressable 512-byte sectors reported by IDENTIFY (LBA28). */
uint32_t ata_sector_count(void);

/* Read `count` sectors (count>=1) starting at `lba` into `buf`
 * (count*512 bytes). Returns 0 on success, negative on error. */
int ata_read(uint32_t lba, uint8_t count, void *buf);

/* Write `count` sectors (count>=1) starting at `lba` from `buf`, then flush the
 * drive write cache. Returns 0 on success, negative on error. */
int ata_write(uint32_t lba, uint8_t count, const void *buf);

#endif /* ATA_H */
