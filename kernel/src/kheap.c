/* kheap.c — Simple kernel heap allocator for KHY OS
 *
 * First-fit free-list allocator operating on a statically allocated
 * heap region. Provides malloc/free symbols for MoonBit runtime.
 * @pattern Strategy
 */

#include "kheap.h"
#include "string.h"
#include "serial.h"
#include <stdint.h>

/* Heap configuration */
#define HEAP_SIZE       (512 * 1024) /* 512KB kernel heap */
#define BLOCK_MAGIC     0xBEEFCAFE  /* [SAFE] valid hex literal (was 0xKHY0HEAP) */
#define MIN_BLOCK_SIZE  32

/* Block header for free-list */
struct block_header {
    uint32_t magic;
    uint32_t size;       /* Usable size (excluding header) */
    uint8_t  is_free;
    uint8_t  _pad[3];
    struct block_header *next;
};

/* Static heap memory */
static uint8_t heap_memory[HEAP_SIZE] __attribute__((aligned(16)));
static struct block_header *free_list;
static int heap_initialized;

void kheap_init(void) {
    /* Initialize entire heap as one free block */
    free_list = (struct block_header *)heap_memory;
    free_list->magic   = 0xBEEFCAFE;
    free_list->size    = HEAP_SIZE - sizeof(struct block_header);
    free_list->is_free = 1;
    free_list->next    = (void *)0;
    heap_initialized = 1;

    serial_print("[HEAP] Kernel heap initialized: ");
    serial_print_dec(HEAP_SIZE / 1024);
    serial_print(" KB\n");
}

void *kmalloc(size_t size) {
    if (!heap_initialized)
        kheap_init();

    if (size == 0)
        return (void *)0;

    /* [SAFE] Reject any request that cannot physically fit in the heap before
     * touching it. This also forecloses the alignment overflow below: a size
     * within [HEAP_SIZE] can never wrap when 15 is added. */
    if (size > HEAP_SIZE - sizeof(struct block_header)) {
        serial_print("[HEAP] ERROR: allocation larger than heap rejected\n");
        return (void *)0;
    }

    /* Align to 16 bytes (overflow-safe: size is bounded above) */
    size = (size + 15) & ~(size_t)15;

    /* [SAFE] The free-list is shared mutable state and this allocator runs under
     * a preemptive scheduler (timer IRQ → schedule()). Without masking, a timer
     * preemption in the middle of a split (curr->next = new_block) would expose a
     * half-linked list to a re-entrant kmalloc/kfree → heap corruption / OOB.
     * Mask interrupts for the walk+split critical section. This is interrupt
     * masking, NOT a spinlock, so it is deadlock-immune; saving/restoring the
     * caller's flags keeps it correctly nested when called from an ISR. */
    uint64_t flags;
    __asm__ volatile("pushfq; pop %0; cli" : "=r"(flags) :: "memory");

    void *result = (void *)0;
    struct block_header *curr = free_list;
    while (curr) {
        if (curr->is_free && curr->size >= size) {
            /* Split block if remainder is large enough */
            if (curr->size >= size + sizeof(struct block_header) + MIN_BLOCK_SIZE) {
                struct block_header *new_block =
                    (struct block_header *)((uint8_t *)curr + sizeof(struct block_header) + size);
                new_block->magic   = 0xBEEFCAFE;
                new_block->size    = curr->size - size - sizeof(struct block_header);
                new_block->is_free = 1;
                new_block->next    = curr->next;
                curr->size = size;
                curr->next = new_block;
            }
            curr->is_free = 0;
            result = (void *)((uint8_t *)curr + sizeof(struct block_header));
            break;
        }
        curr = curr->next;
    }

    __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");

    if (!result) {
        serial_print("[HEAP] ERROR: Out of heap memory! Requested: ");
        serial_print_dec(size);
        serial_print(" bytes\n");
    }
    return result;
}

void kfree(void *ptr) {
    if (!ptr)
        return;

    struct block_header *block =
        (struct block_header *)((uint8_t *)ptr - sizeof(struct block_header));

    if (block->magic != 0xBEEFCAFE) {
        serial_print("[HEAP] ERROR: Invalid free (bad magic)\n");
        return;
    }

    /* [SAFE] Same shared-free-list hazard as kmalloc: marking the block free and
     * walking the list to coalesce must not be interrupted by a preempting
     * kmalloc/kfree mid-relink (curr->next = curr->next->next). Mask interrupts
     * for the mutation; deadlock-immune (masking, not a lock) and nest-safe. */
    uint64_t flags;
    __asm__ volatile("pushfq; pop %0; cli" : "=r"(flags) :: "memory");

    block->is_free = 1;

    /* Coalesce adjacent free blocks */
    struct block_header *curr = free_list;
    while (curr) {
        if (curr->is_free && curr->next && curr->next->is_free) {
            curr->size += sizeof(struct block_header) + curr->next->size;
            curr->next = curr->next->next;
            continue; /* Check again in case of multiple adjacent free blocks */
        }
        curr = curr->next;
    }

    __asm__ volatile("push %0; popfq" :: "r"(flags) : "memory", "cc");
}

/* Standard C symbols for MoonBit runtime compatibility */
void *malloc(size_t size) {
    return kmalloc(size);
}

void *realloc(void *ptr, size_t size) {
    if (!ptr)
        return kmalloc(size);
    if (size == 0) {
        kfree(ptr);
        return (void *)0;
    }

    struct block_header *block =
        (struct block_header *)((uint8_t *)ptr - sizeof(struct block_header));

    /* [SAFE] Validate the block before trusting its size field; a corrupt or
     * foreign pointer must not drive a memcpy of an attacker-chosen length. */
    if (block->magic != 0xBEEFCAFE) {
        serial_print("[HEAP] ERROR: Invalid realloc (bad magic)\n");
        return (void *)0;
    }

    if (block->size >= size)
        return ptr; /* Current block is large enough */

    /* Allocate new, copy, free old */
    void *new_ptr = kmalloc(size);
    if (new_ptr) {
        memcpy(new_ptr, ptr, block->size);
        kfree(ptr);
    }
    return new_ptr;
}

void free(void *ptr) {
    kfree(ptr);
}
