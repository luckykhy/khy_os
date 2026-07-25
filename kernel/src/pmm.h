/* pmm.h — Physical Memory Manager (bitmap allocator) * @pattern Strategy
 */
#ifndef PMM_H
#define PMM_H

#include <stdint.h>
#include <stddef.h>

#define PAGE_SIZE 4096

/* Initialize PMM using Multiboot2 memory map */
void pmm_init(uint32_t multiboot_info_addr);

/* Allocate a single 4KB physical page, returns physical address or 0 on failure */
uint64_t pmm_alloc_page(void);

/* Free a previously allocated physical page */
void pmm_free_page(uint64_t addr);

/* Reference-counting for shared frames (copy-on-write). pmm_incref adds an
 * owner to an already-allocated frame; pmm_free_page drops one owner and only
 * reclaims the frame at zero. pmm_refcount reports the current owner count
 * (1 for a normal unshared page), used to decide whether a COW write fault can
 * reclaim the page in place instead of copying it. */
void pmm_incref(uint64_t addr);
uint16_t pmm_refcount(uint64_t addr);

/* Get total and free memory statistics */
uint64_t pmm_total_memory(void);
uint64_t pmm_free_memory(void);

#endif
