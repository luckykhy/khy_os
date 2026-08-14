/* kheap.h — Kernel heap allocator * @pattern Strategy
 */
#ifndef KHEAP_H
#define KHEAP_H

#include <stddef.h>

/* Initialize the kernel heap */
void kheap_init(void);

/* Kernel-level allocation */
void *kmalloc(size_t size);
void  kfree(void *ptr);

/* C standard symbols (for MoonBit runtime compatibility) */
void *malloc(size_t size);
void *realloc(void *ptr, size_t size);
void  free(void *ptr);

#endif
