/* elf.h — Minimal ELF64 loader for user processes * @pattern Strategy
 */
#ifndef ELF_H
#define ELF_H

#include <stddef.h>
#include <stdint.h>
#include "vmm.h"

struct elf_image {
    uint64_t entry;
    uint64_t brk;
    uint16_t segments;
};

int elf_validate_image(const uint8_t *image, size_t size);
int elf_load_user_image(const uint8_t *image, size_t size, struct vm_space *space, struct elf_image *out);

#endif
