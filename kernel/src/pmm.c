/* pmm.c — Physical Memory Manager for KHY OS
 *
 * Bitmap-based page allocator. Each bit represents one 4KB page.
 * Parses Multiboot2 memory map to determine available regions.
 * @pattern Strategy
 */

#include "pmm.h"
#include "string.h"
#include "serial.h"

/* Multiboot2 tag types */
#define MULTIBOOT2_TAG_TYPE_END     0
#define MULTIBOOT2_TAG_TYPE_MMAP    6

/* Multiboot2 memory map entry types */
#define MULTIBOOT2_MEMORY_AVAILABLE 1

/* Multiboot2 structures */
struct multiboot2_tag {
    uint32_t type;
    uint32_t size;
};

struct multiboot2_tag_mmap {
    uint32_t type;
    uint32_t size;
    uint32_t entry_size;
    uint32_t entry_version;
    /* Entries follow */
};

struct multiboot2_mmap_entry {
    uint64_t addr;
    uint64_t len;
    uint32_t type;
    uint32_t zero;
};

/* Bitmap: support up to 4GB of physical memory */
#define MAX_PHYS_MEMORY  (4ULL * 1024 * 1024 * 1024)
#define MAX_PAGES        (MAX_PHYS_MEMORY / PAGE_SIZE)
#define BITMAP_SIZE      (MAX_PAGES / 8)

/* Static bitmap — placed in BSS (zeroed, all pages marked as used initially) */
static uint8_t page_bitmap[BITMAP_SIZE];
#define ACTUAL_BITMAP_SIZE sizeof(page_bitmap)
#define ACTUAL_MAX_PAGES   (ACTUAL_BITMAP_SIZE * 8)

/* Per-frame reference count, parallel to the bitmap, to support shared physical
 * pages (copy-on-write fork). A frame handed out by pmm_alloc_page() starts at
 * refcount 1; vmm_clone_space() bumps it when a child shares the parent's page,
 * and pmm_free_page() only returns a frame to the bitmap once the count reaches
 * zero. Frames that are never shared keep refcount 1 and behave exactly as
 * before, so this is transparent to all existing alloc/free pairs. uint16_t
 * caps sharing at 65535 co-owners — unreachable in practice; a saturated count
 * simply pins the frame (it is never auto-freed), which cannot happen here. */
static uint16_t page_refcount[ACTUAL_BITMAP_SIZE * 8];

static uint64_t total_memory_bytes;
static uint64_t free_pages_count;
static uint64_t next_free_hint;

/* Bitmap operations */
static inline void bitmap_set(uint64_t page) {
    if (page < ACTUAL_MAX_PAGES)
        page_bitmap[page / 8] |= (1 << (page % 8));
}

static inline void bitmap_clear(uint64_t page) {
    if (page < ACTUAL_MAX_PAGES)
        page_bitmap[page / 8] &= ~(1 << (page % 8));
}

static inline int bitmap_test(uint64_t page) {
    if (page >= ACTUAL_MAX_PAGES)
        return 1; /* Treat out-of-range as used */
    return (page_bitmap[page / 8] >> (page % 8)) & 1;
}

/* External symbol from linker script */
extern uint8_t __kernel_end;

void pmm_init(uint32_t multiboot_info_addr) {
    /* Mark all pages as used initially */
    memset(page_bitmap, 0xFF, ACTUAL_BITMAP_SIZE);
    total_memory_bytes = 0;
    free_pages_count = 0;
    next_free_hint = 0;

    serial_print("[PMM] Parsing Multiboot2 memory map...\n");

    /* Parse Multiboot2 info structure */
    uint32_t mb_total_size = *(uint32_t *)(uint64_t)multiboot_info_addr;

    /* [SAFE] Bound the entire tag region against the declared total size so a
     * malformed Multiboot2 structure cannot let us walk off into arbitrary
     * memory. A minimum sane size guards against a bogus/zero header. */
    if (mb_total_size < 8)
        mb_total_size = 8;
    uint64_t mb_base = (uint64_t)multiboot_info_addr;
    uint64_t mb_limit = mb_base + mb_total_size;

    struct multiboot2_tag *tag = (struct multiboot2_tag *)(mb_base + 8);

    /* [SAFE] Hard iteration cap: even if size fields conspire to keep the tag
     * pointer "advancing" within bounds, a fixed ceiling guarantees the boot
     * path always terminates (constraint: no unbounded loops). */
    uint32_t tag_guard = 0;
    const uint32_t TAG_WALK_MAX = 4096;

    while ((uint64_t)tag + sizeof(struct multiboot2_tag) <= mb_limit &&
           tag->type != MULTIBOOT2_TAG_TYPE_END &&
           tag_guard++ < TAG_WALK_MAX) {
        /* [SAFE] A tag must be at least its own header; a zero/short size would
         * otherwise stall the advance below in an infinite loop. */
        if (tag->size < sizeof(struct multiboot2_tag))
            break;
        if (tag->type == MULTIBOOT2_TAG_TYPE_MMAP) {
            struct multiboot2_tag_mmap *mmap_tag = (struct multiboot2_tag_mmap *)tag;
            uint32_t entry_size = mmap_tag->entry_size;
            uint8_t *entries_start = (uint8_t *)mmap_tag + sizeof(struct multiboot2_tag_mmap);
            uint8_t *entries_end = (uint8_t *)mmap_tag + mmap_tag->size;

            /* [SAFE] A zero (or sub-entry) entry_size would never advance the
             * cursor below — reject the whole malformed tag instead of hanging. */
            if (entry_size < sizeof(struct multiboot2_mmap_entry)) {
                serial_print("[PMM] WARN: bad mmap entry_size, skipping tag\n");
                goto next_tag;
            }
            /* [SAFE] Clamp the entry window to the validated tag region. */
            if ((uint64_t)entries_end > mb_limit)
                entries_end = (uint8_t *)mb_limit;

            for (uint8_t *p = entries_start; p + entry_size <= entries_end; p += entry_size) {
                struct multiboot2_mmap_entry *entry = (struct multiboot2_mmap_entry *)p;

                serial_print("  Region: addr=");
                serial_print_hex(entry->addr);
                serial_print(" len=");
                serial_print_hex(entry->len);
                serial_print(entry->type == MULTIBOOT2_MEMORY_AVAILABLE ? " [AVAILABLE]\n" : " [RESERVED]\n");

                total_memory_bytes += entry->len;

                if (entry->type == MULTIBOOT2_MEMORY_AVAILABLE) {
                    /* Mark available pages as free */
                    uint64_t start = entry->addr;
                    uint64_t end = entry->addr + entry->len;

                    /* Align start up to page boundary */
                    if (start % PAGE_SIZE != 0)
                        start = (start + PAGE_SIZE - 1) & ~(PAGE_SIZE - 1);

                    /* Align end down to page boundary */
                    end &= ~(PAGE_SIZE - 1);

                    for (uint64_t addr = start; addr < end; addr += PAGE_SIZE) {
                        uint64_t page = addr / PAGE_SIZE;
                        if (page < ACTUAL_MAX_PAGES) {
                            bitmap_clear(page);
                            free_pages_count++;
                        }
                    }
                }
            }
        }

    next_tag:;
        /* Advance to next tag (8-byte aligned) */
        uint64_t next = ((uint64_t)tag + tag->size + 7) & ~7ULL;
        /* [SAFE] Guarantee forward progress: the aligned advance must move past
         * the current tag, otherwise a crafted size could pin the pointer. */
        if (next <= (uint64_t)tag)
            break;
        tag = (struct multiboot2_tag *)next;
    }

    /* Protect pages 0-1MB (BIOS, VGA, bootloader) */
    for (uint64_t page = 0; page < (1024 * 1024) / PAGE_SIZE; page++) {
        if (!bitmap_test(page)) {
            bitmap_set(page);
            free_pages_count--;
        }
    }

    /* Protect kernel image pages */
    uint64_t kernel_end_addr = (uint64_t)&__kernel_end;
    uint64_t kernel_end_page = (kernel_end_addr + PAGE_SIZE - 1) / PAGE_SIZE;
    for (uint64_t page = (1024 * 1024) / PAGE_SIZE; page < kernel_end_page; page++) {
        if (!bitmap_test(page)) {
            bitmap_set(page);
            free_pages_count--;
        }
    }

    serial_print("[PMM] Total memory: ");
    serial_print_dec(total_memory_bytes / (1024 * 1024));
    serial_print(" MB\n");
    serial_print("[PMM] Free pages: ");
    serial_print_dec(free_pages_count);
    serial_print(" (");
    serial_print_dec(free_pages_count * PAGE_SIZE / 1024);
    serial_print(" KB)\n");
}

uint64_t pmm_alloc_page(void) {
    for (uint64_t i = next_free_hint; i < ACTUAL_MAX_PAGES; i++) {
        if (!bitmap_test(i)) {
            bitmap_set(i);
            page_refcount[i] = 1;
            free_pages_count--;
            next_free_hint = i + 1;
            return i * PAGE_SIZE;
        }
    }
    for (uint64_t i = 0; i < next_free_hint; i++) {
        if (!bitmap_test(i)) {
            bitmap_set(i);
            page_refcount[i] = 1;
            free_pages_count--;
            next_free_hint = i + 1;
            return i * PAGE_SIZE;
        }
    }
    serial_print("[PMM] ERROR: Out of physical memory!\n");
    return 0;
}

void pmm_incref(uint64_t addr) {
    uint64_t page = addr / PAGE_SIZE;
    if (page >= ACTUAL_MAX_PAGES)
        return;
    if (page_refcount[page] < 0xFFFF)
        page_refcount[page]++;
}

uint16_t pmm_refcount(uint64_t addr) {
    uint64_t page = addr / PAGE_SIZE;
    if (page >= ACTUAL_MAX_PAGES)
        return 0;
    return page_refcount[page];
}

void pmm_free_page(uint64_t addr) {
    uint64_t page = addr / PAGE_SIZE;
    if (page >= ACTUAL_MAX_PAGES || !bitmap_test(page))
        return;
    /* Drop one reference; the frame only returns to the free pool when the last
     * owner releases it (copy-on-write may have several owners). */
    if (page_refcount[page] > 1) {
        page_refcount[page]--;
        return;
    }
    page_refcount[page] = 0;
    bitmap_clear(page);
    free_pages_count++;
    if (page < next_free_hint)
        next_free_hint = page;
}

uint64_t pmm_total_memory(void) {
    return total_memory_bytes;
}

uint64_t pmm_free_memory(void) {
    return free_pages_count * PAGE_SIZE;
}
