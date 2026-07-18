/* ata.c — ATA (IDE) PIO block driver, primary master, 28-bit LBA, polling.
 * @pattern Adapter
 */

#include "ata.h"
#include "serial.h"
#include "string.h"

/* Primary bus I/O ports */
#define ATA_REG_DATA      0x1F0
#define ATA_REG_ERROR     0x1F1
#define ATA_REG_SECCOUNT  0x1F2
#define ATA_REG_LBA_LO    0x1F3
#define ATA_REG_LBA_MID   0x1F4
#define ATA_REG_LBA_HI    0x1F5
#define ATA_REG_DRIVE     0x1F6
#define ATA_REG_STATUS    0x1F7   /* read */
#define ATA_REG_COMMAND   0x1F7   /* write */
#define ATA_CTRL          0x3F6   /* device control / alt status */

/* Status register bits */
#define ATA_SR_BSY  0x80   /* busy */
#define ATA_SR_DRDY 0x40   /* drive ready */
#define ATA_SR_DRQ  0x08   /* data request ready */
#define ATA_SR_ERR  0x01   /* error */

/* Commands */
#define ATA_CMD_READ_PIO  0x20
#define ATA_CMD_WRITE_PIO 0x30
#define ATA_CMD_FLUSH     0xE7
#define ATA_CMD_IDENTIFY  0xEC

/* Bounded spin so a missing/wedged drive can never hang the kernel. */
#define ATA_POLL_LIMIT 1000000

static int      have_disk;
static uint32_t total_sectors;

static inline void outb(uint16_t port, uint8_t val) {
    __asm__ volatile("outb %0, %1" : : "a"(val), "Nd"(port));
}

static inline uint8_t inb(uint16_t port) {
    uint8_t ret;
    __asm__ volatile("inb %1, %0" : "=a"(ret) : "Nd"(port));
    return ret;
}

static inline uint16_t inw(uint16_t port) {
    uint16_t ret;
    __asm__ volatile("inw %1, %0" : "=a"(ret) : "Nd"(port));
    return ret;
}

static inline void outw(uint16_t port, uint16_t val) {
    __asm__ volatile("outw %0, %1" : : "a"(val), "Nd"(port));
}

/* ~400ns settle after a command/drive select: four alt-status reads. */
static void ata_io_delay(void) {
    for (int i = 0; i < 4; i++)
        (void)inb(ATA_CTRL);
}

/* Spin until BSY clears. Returns 0 on success, -1 on timeout. */
static int ata_wait_not_busy(void) {
    for (uint32_t i = 0; i < ATA_POLL_LIMIT; i++) {
        if (!(inb(ATA_REG_STATUS) & ATA_SR_BSY))
            return 0;
    }
    return -1;
}

/* Wait for BSY clear then DRQ set; fail on ERR or timeout. */
static int ata_wait_drq(void) {
    for (uint32_t i = 0; i < ATA_POLL_LIMIT; i++) {
        uint8_t s = inb(ATA_REG_STATUS);
        if (s & ATA_SR_ERR)
            return -1;
        if (!(s & ATA_SR_BSY) && (s & ATA_SR_DRQ))
            return 0;
    }
    return -1;
}

int ata_init(void) {
    have_disk = 0;
    total_sectors = 0;

    /* Select primary master (LBA mode bit set, drive 0). */
    outb(ATA_REG_DRIVE, 0xA0);
    ata_io_delay();

    /* Zero the addressing registers, then issue IDENTIFY. */
    outb(ATA_REG_SECCOUNT, 0);
    outb(ATA_REG_LBA_LO, 0);
    outb(ATA_REG_LBA_MID, 0);
    outb(ATA_REG_LBA_HI, 0);
    outb(ATA_REG_COMMAND, ATA_CMD_IDENTIFY);

    /* Status 0 → no drive present on this bus. */
    uint8_t status = inb(ATA_REG_STATUS);
    if (status == 0) {
        serial_print("[ATA] No primary master present\n");
        return -1;
    }

    if (ata_wait_not_busy() != 0) {
        serial_print("[ATA] IDENTIFY: BSY timeout\n");
        return -2;
    }

    /* Non-zero LBA_MID/HI after IDENTIFY = ATAPI/SATA, not a plain ATA disk. */
    if (inb(ATA_REG_LBA_MID) != 0 || inb(ATA_REG_LBA_HI) != 0) {
        serial_print("[ATA] Primary master is not a plain ATA disk\n");
        return -3;
    }

    if (ata_wait_drq() != 0) {
        serial_print("[ATA] IDENTIFY: DRQ/ERR timeout\n");
        return -4;
    }

    /* Read the 256-word IDENTIFY block; words 60-61 hold the LBA28 capacity. */
    uint16_t id[256];
    for (int i = 0; i < 256; i++)
        id[i] = inw(ATA_REG_DATA);

    total_sectors = (uint32_t)id[60] | ((uint32_t)id[61] << 16);
    have_disk = 1;

    serial_print("[ATA] Primary master ready, sectors=");
    serial_print_dec(total_sectors);
    serial_print(" (");
    serial_print_dec((uint64_t)total_sectors * ATA_SECTOR_SIZE / (1024 * 1024));
    serial_print(" MB)\n");
    return 0;
}

int ata_present(void) {
    return have_disk;
}

uint32_t ata_sector_count(void) {
    return total_sectors;
}

/* Program the addressing registers for a count-sector transfer at `lba`. */
static void ata_setup_lba(uint32_t lba, uint8_t count) {
    outb(ATA_REG_DRIVE, 0xE0 | ((lba >> 24) & 0x0F)); /* master + LBA bits 24-27 */
    outb(ATA_REG_SECCOUNT, count);
    outb(ATA_REG_LBA_LO, (uint8_t)(lba & 0xFF));
    outb(ATA_REG_LBA_MID, (uint8_t)((lba >> 8) & 0xFF));
    outb(ATA_REG_LBA_HI, (uint8_t)((lba >> 16) & 0xFF));
}

int ata_read(uint32_t lba, uint8_t count, void *buf) {
    if (!have_disk || count == 0 || !buf)
        return -1;
    if (ata_wait_not_busy() != 0)
        return -2;

    ata_setup_lba(lba, count);
    outb(ATA_REG_COMMAND, ATA_CMD_READ_PIO);

    uint16_t *out = (uint16_t *)buf;
    for (uint8_t s = 0; s < count; s++) {
        if (ata_wait_drq() != 0)
            return -3;
        for (int i = 0; i < ATA_SECTOR_SIZE / 2; i++)
            *out++ = inw(ATA_REG_DATA);
    }
    return 0;
}

int ata_write(uint32_t lba, uint8_t count, const void *buf) {
    if (!have_disk || count == 0 || !buf)
        return -1;
    if (ata_wait_not_busy() != 0)
        return -2;

    ata_setup_lba(lba, count);
    outb(ATA_REG_COMMAND, ATA_CMD_WRITE_PIO);

    const uint16_t *in = (const uint16_t *)buf;
    for (uint8_t s = 0; s < count; s++) {
        if (ata_wait_drq() != 0)
            return -3;
        for (int i = 0; i < ATA_SECTOR_SIZE / 2; i++)
            outw(ATA_REG_DATA, *in++);
    }

    /* Flush the write cache so data reaches the medium (survives reboot). */
    outb(ATA_REG_COMMAND, ATA_CMD_FLUSH);
    if (ata_wait_not_busy() != 0)
        return -4;
    return 0;
}
