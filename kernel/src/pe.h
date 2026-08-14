/* pe.h — PE32+/PE64 format loader for Windows executable compatibility
 *
 * Parses PE format: DOS header → PE signature → COFF header →
 * Optional header → Section table → Import table.
 * Loads .text/.data/.rdata/.bss sections into user address space.
 * @pattern Strategy
 */
#ifndef PE_H
#define PE_H

#include <stddef.h>
#include <stdint.h>
#include "vmm.h"

/* PE image info (analogous to elf_image) */
struct pe_image {
    uint64_t entry;          /* Entry point virtual address */
    uint64_t image_base;     /* Preferred image base */
    uint64_t image_size;     /* Total virtual size */
    uint16_t sections;       /* Number of sections loaded */
    uint16_t subsystem;      /* PE subsystem (GUI/CUI) */
    uint16_t imports_count;  /* Number of imported DLLs */
};

/* PE subsystem values */
#define PE_SUBSYSTEM_CONSOLE  3
#define PE_SUBSYSTEM_GUI      2

/* Validate a PE image in memory. Returns 0 on success, negative on error. */
int pe_validate_image(const uint8_t *image, size_t size);

/* Load a PE image into a user address space.
 * Handles section mapping, base relocation, and import resolution.
 * Returns 0 on success, negative on error. */
int pe_load_user_image(const uint8_t *image, size_t size,
                       struct vm_space *space, struct pe_image *out);

/* Get the name of a PE subsystem */
const char *pe_subsystem_name(uint16_t subsystem);

#endif
