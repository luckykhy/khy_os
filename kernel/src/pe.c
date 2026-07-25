/* pe.c — PE32+/PE64 loader for the KHY OS hybrid kernel
 *
 * Loads Windows PE executables into user address space.
 * Supports:
 *   - PE32+ (64-bit) format
 *   - Section loading (.text, .data, .rdata, .bss)
 *   - Base relocation processing
 *   - Import table parsing (resolved via wincompat layer)
 * @pattern Interpreter
 */

#include "pe.h"
#include "serial.h"
#include "string.h"

/* ── PE Format Structures ────────────────────────────────────── */

#define PE_DOS_MAGIC      0x5A4D    /* "MZ" */
#define PE_SIGNATURE      0x00004550 /* "PE\0\0" */
#define PE_MACHINE_AMD64  0x8664
#define PE_OPT_MAGIC_64   0x020B    /* PE32+ */

/* Characteristics */
#define PE_FILE_EXECUTABLE_IMAGE  0x0002
#define PE_FILE_LARGE_ADDRESS_AWARE 0x0020

/* Section flags */
#define PE_SCN_MEM_EXECUTE  0x20000000
#define PE_SCN_MEM_READ     0x40000000
#define PE_SCN_MEM_WRITE    0x80000000
#define PE_SCN_CNT_CODE     0x00000020
#define PE_SCN_CNT_DATA     0x00000040
#define PE_SCN_CNT_BSS      0x00000080

/* Data directory indices */
#define PE_DIR_IMPORT       1
#define PE_DIR_BASERELOC    5

struct pe_dos_header {
    uint16_t e_magic;
    uint8_t  reserved[58];
    uint32_t e_lfanew;      /* Offset to PE signature */
} __attribute__((packed));

struct pe_coff_header {
    uint16_t machine;
    uint16_t number_of_sections;
    uint32_t time_date_stamp;
    uint32_t pointer_to_symbol_table;
    uint32_t number_of_symbols;
    uint16_t size_of_optional_header;
    uint16_t characteristics;
} __attribute__((packed));

struct pe_data_directory {
    uint32_t virtual_address;
    uint32_t size;
} __attribute__((packed));

struct pe_optional_header64 {
    uint16_t magic;
    uint8_t  major_linker_version;
    uint8_t  minor_linker_version;
    uint32_t size_of_code;
    uint32_t size_of_initialized_data;
    uint32_t size_of_uninitialized_data;
    uint32_t address_of_entry_point;
    uint32_t base_of_code;
    uint64_t image_base;
    uint32_t section_alignment;
    uint32_t file_alignment;
    uint16_t major_os_version;
    uint16_t minor_os_version;
    uint16_t major_image_version;
    uint16_t minor_image_version;
    uint16_t major_subsystem_version;
    uint16_t minor_subsystem_version;
    uint32_t win32_version_value;
    uint32_t size_of_image;
    uint32_t size_of_headers;
    uint32_t checksum;
    uint16_t subsystem;
    uint16_t dll_characteristics;
    uint64_t size_of_stack_reserve;
    uint64_t size_of_stack_commit;
    uint64_t size_of_heap_reserve;
    uint64_t size_of_heap_commit;
    uint32_t loader_flags;
    uint32_t number_of_rva_and_sizes;
    struct pe_data_directory data_directory[16];
} __attribute__((packed));

struct pe_section_header {
    char     name[8];
    uint32_t virtual_size;
    uint32_t virtual_address;
    uint32_t size_of_raw_data;
    uint32_t pointer_to_raw_data;
    uint32_t pointer_to_relocations;
    uint32_t pointer_to_linenumbers;
    uint16_t number_of_relocations;
    uint16_t number_of_linenumbers;
    uint32_t characteristics;
} __attribute__((packed));

/* Import Directory Table */
struct pe_import_descriptor {
    uint32_t original_first_thunk;  /* RVA to INT (Import Name Table) */
    uint32_t time_date_stamp;
    uint32_t forwarder_chain;
    uint32_t name;                  /* RVA to DLL name */
    uint32_t first_thunk;           /* RVA to IAT (Import Address Table) */
} __attribute__((packed));

/* Base Relocation Block */
struct pe_base_reloc_block {
    uint32_t page_rva;
    uint32_t block_size;
} __attribute__((packed));

#define PE_REL_BASED_DIR64  10  /* 64-bit address relocation */

/* ── Helpers ─────────────────────────────────────────────────── */

static uint64_t _align_up(uint64_t v, uint64_t align) {
    return (v + align - 1) & ~(align - 1);
}

/* Read a null-terminated string from image at RVA, returns pointer into image */
static const char *_rva_to_str(const uint8_t *image, size_t size, uint32_t rva) {
    if (rva >= size)
        return "(invalid)";
    return (const char *)(image + rva);
}

/* ── Validation ──────────────────────────────────────────────── */

int pe_validate_image(const uint8_t *image, size_t size) {
    if (!image || size < sizeof(struct pe_dos_header))
        return -1;

    const struct pe_dos_header *dos = (const struct pe_dos_header *)image;
    if (dos->e_magic != PE_DOS_MAGIC)
        return -2; /* Not a DOS/PE file */

    uint32_t pe_offset = dos->e_lfanew;
    if (pe_offset + 4 + sizeof(struct pe_coff_header) > size)
        return -3;

    const uint32_t *pe_sig = (const uint32_t *)(image + pe_offset);
    if (*pe_sig != PE_SIGNATURE)
        return -4; /* Invalid PE signature */

    const struct pe_coff_header *coff =
        (const struct pe_coff_header *)(image + pe_offset + 4);

    if (coff->machine != PE_MACHINE_AMD64)
        return -5; /* Only x86_64 PE supported */

    uint32_t opt_offset = pe_offset + 4 + sizeof(struct pe_coff_header);
    if (opt_offset + sizeof(struct pe_optional_header64) > size)
        return -6;

    const struct pe_optional_header64 *opt =
        (const struct pe_optional_header64 *)(image + opt_offset);

    if (opt->magic != PE_OPT_MAGIC_64)
        return -7; /* Only PE32+ (64-bit) supported */

    return 0;
}

/* ── Loading ─────────────────────────────────────────────────── */

int pe_load_user_image(const uint8_t *image, size_t size,
                       struct vm_space *space, struct pe_image *out) {
    if (!space || !out)
        return -1;

    int rc = pe_validate_image(image, size);
    if (rc != 0)
        return rc;

    const struct pe_dos_header *dos = (const struct pe_dos_header *)image;
    uint32_t pe_offset = dos->e_lfanew;

    const struct pe_coff_header *coff =
        (const struct pe_coff_header *)(image + pe_offset + 4);

    const struct pe_optional_header64 *opt =
        (const struct pe_optional_header64 *)(image + pe_offset + 4 + sizeof(struct pe_coff_header));

    /* Determine load base address (in user space) */
    uint64_t preferred_base = opt->image_base;
    uint64_t load_base = preferred_base;
    if (load_base < VMM_USER_BASE)
        load_base = VMM_USER_BASE; /* Ensure in user address range */

    uint64_t delta = load_base - preferred_base; /* Relocation delta */

    serial_print("[PE] Loading PE64 image\n");
    serial_print("  ImageBase=");
    serial_print_hex(preferred_base);
    serial_print(" LoadBase=");
    serial_print_hex(load_base);
    serial_print(" Entry=");
    serial_print_hex((uint64_t)opt->address_of_entry_point);
    serial_print("\n");

    /* ── Load sections ───────────────────────────────────── */

    uint32_t section_offset = pe_offset + 4 + sizeof(struct pe_coff_header) +
                              coff->size_of_optional_header;
    const struct pe_section_header *sections =
        (const struct pe_section_header *)(image + section_offset);

    /* [SAFE] The section header array is sized by attacker-controlled fields
     * (number_of_sections, size_of_optional_header). Without bounding the whole
     * table against the image, sections[i] below reads far past the buffer and
     * the OOB-read headers would then drive page mapping. Compute the table
     * extent in 64-bit to avoid wrap and reject anything exceeding the image. */
    uint64_t sec_table_end = (uint64_t)section_offset +
        (uint64_t)coff->number_of_sections * sizeof(struct pe_section_header);
    if (sec_table_end > size)
        return -12;

    uint16_t loaded_sections = 0;

    for (uint16_t i = 0; i < coff->number_of_sections; i++) {
        const struct pe_section_header *sec = &sections[i];

        if (sec->virtual_size == 0 && sec->size_of_raw_data == 0)
            continue;

        uint64_t sec_va = load_base + sec->virtual_address;
        uint64_t sec_size = sec->virtual_size;
        if (sec_size == 0)
            sec_size = sec->size_of_raw_data;

        /* Determine permissions */
        uint64_t flags = VMM_FLAG_USER;
        if (sec->characteristics & PE_SCN_MEM_WRITE)
            flags |= VMM_FLAG_WRITABLE;
        if (!(sec->characteristics & PE_SCN_MEM_EXECUTE))
            flags |= VMM_FLAG_NO_EXEC;

        /* Map pages for this section */
        uint64_t page_start = sec_va & ~(VMM_PAGE_SIZE - 1);
        uint64_t page_end = _align_up(sec_va + sec_size, VMM_PAGE_SIZE);

        for (uint64_t va = page_start; va < page_end; va += VMM_PAGE_SIZE) {
            uint64_t phys = vmm_alloc_owned_page(space);
            if (!phys)
                return -10;
            uint8_t *page = (uint8_t *)vmm_phys_to_virt(phys);
            memset(page, 0, VMM_PAGE_SIZE);

            /* Copy file data into this page */
            if (sec->size_of_raw_data > 0 && sec->pointer_to_raw_data > 0) {
                uint64_t sec_file_start = (uint64_t)sec->pointer_to_raw_data;
                uint64_t sec_file_end = sec_file_start + sec->size_of_raw_data;

                uint64_t copy_start_va = (va > sec_va) ? va : sec_va;
                uint64_t copy_end_va = (va + VMM_PAGE_SIZE < sec_va + sec->size_of_raw_data)
                                        ? va + VMM_PAGE_SIZE : sec_va + sec->size_of_raw_data;

                if (copy_end_va > copy_start_va) {
                    uint64_t page_off = copy_start_va - va;
                    uint64_t file_off = sec_file_start + (copy_start_va - sec_va);
                    uint64_t copy_len = copy_end_va - copy_start_va;

                    if (file_off + copy_len <= size && file_off >= sec_file_start &&
                        file_off < sec_file_end) {
                        memcpy(page + page_off, image + file_off, (size_t)copy_len);
                    }
                }
            }

            if (vmm_map_page(space, va, phys, flags | VMM_FLAG_PRESENT) != 0)
                return -11;
        }

        serial_print("  Section '");
        /* Print section name (may not be null-terminated) */
        for (int j = 0; j < 8 && sec->name[j]; j++)
            serial_putchar(sec->name[j]);
        serial_print("' VA=");
        serial_print_hex(sec_va);
        serial_print(" size=");
        serial_print_dec(sec_size);
        serial_print("\n");

        loaded_sections++;
    }

    /* ── Process base relocations (if load_base != preferred_base) ── */

    if (delta != 0 && opt->number_of_rva_and_sizes > PE_DIR_BASERELOC &&
        opt->data_directory[PE_DIR_BASERELOC].virtual_address != 0 &&
        opt->data_directory[PE_DIR_BASERELOC].size > 0) {

        uint32_t reloc_rva = opt->data_directory[PE_DIR_BASERELOC].virtual_address;
        uint32_t reloc_size = opt->data_directory[PE_DIR_BASERELOC].size;

        if (reloc_rva + reloc_size <= (uint32_t)size) {
            uint32_t offset = 0;
            while (offset < reloc_size) {
                /* [SAFE] The 8-byte block header must lie fully inside the
                 * relocation region before we dereference it. */
                if (offset + sizeof(struct pe_base_reloc_block) > reloc_size)
                    break;

                const struct pe_base_reloc_block *block =
                    (const struct pe_base_reloc_block *)(image + reloc_rva + offset);

                /* [SAFE] A block_size below the header size would underflow the
                 * unsigned num_entries computation below into a huge value,
                 * driving the inner entries[e] loop far out of bounds. Reject a
                 * block that does not even cover its own header (0 included). */
                if (block->block_size < sizeof(struct pe_base_reloc_block))
                    break;
                /* [SAFE] The block's entry array must also stay within the
                 * relocation region. */
                if (offset + block->block_size > reloc_size)
                    break;

                uint32_t num_entries = (block->block_size - sizeof(struct pe_base_reloc_block)) / 2;
                const uint16_t *entries = (const uint16_t *)((const uint8_t *)block +
                                           sizeof(struct pe_base_reloc_block));

                for (uint32_t e = 0; e < num_entries; e++) {
                    uint16_t entry = entries[e];
                    uint8_t type = (entry >> 12) & 0x0F;
                    uint16_t page_offset = entry & 0x0FFF;

                    if (type == PE_REL_BASED_DIR64) {
                        /* 64-bit relocation: add delta to the 8-byte value */
                        uint32_t target_rva = block->page_rva + page_offset;
                        if (target_rva + 8 <= (uint32_t)size) {
                            /* Note: in a real implementation, we'd need to write to the
                             * mapped user page. For now, this modifies the in-memory image
                             * before it gets copied to pages. Since we already loaded sections,
                             * we'd need a second pass. This is a placeholder for full relocation. */
                            serial_print("  Reloc @RVA ");
                            serial_print_hex(target_rva);
                            serial_print(" delta=");
                            serial_print_hex(delta);
                            serial_print("\n");
                        }
                    }
                    /* Type 0 = padding, skip */
                }

                offset += block->block_size;
            }
        }
    }

    /* ── Parse import table ──────────────────────────────── */

    uint16_t import_count = 0;
    if (opt->number_of_rva_and_sizes > PE_DIR_IMPORT &&
        opt->data_directory[PE_DIR_IMPORT].virtual_address != 0 &&
        opt->data_directory[PE_DIR_IMPORT].size > 0) {

        uint32_t import_rva = opt->data_directory[PE_DIR_IMPORT].virtual_address;

        if (import_rva + sizeof(struct pe_import_descriptor) <= (uint32_t)size) {
            const struct pe_import_descriptor *imp =
                (const struct pe_import_descriptor *)(image + import_rva);

            /* Iterate until null-terminated entry. [SAFE] The in-bounds check
             * is evaluated BEFORE imp->name so a descriptor that has advanced
             * past the image is never dereferenced (read-before-check OOB). */
            while ((uint32_t)((const uint8_t *)imp - image) + sizeof(*imp) <= size && imp->name != 0) {
                const char *dll_name = _rva_to_str(image, size, imp->name);
                serial_print("  Import DLL: ");
                serial_print(dll_name);
                serial_print("\n");
                import_count++;
                imp++;

                if (import_count > 64)
                    break; /* Safety limit */
            }
        }
    }

    /* ── Fill output ─────────────────────────────────────── */

    out->entry = load_base + opt->address_of_entry_point;
    out->image_base = load_base;
    out->image_size = opt->size_of_image;
    out->sections = loaded_sections;
    out->subsystem = opt->subsystem;
    out->imports_count = import_count;

    serial_print("[PE] Load complete: ");
    serial_print_dec(loaded_sections);
    serial_print(" sections, ");
    serial_print_dec(import_count);
    serial_print(" imports, entry=");
    serial_print_hex(out->entry);
    serial_print("\n");

    return 0;
}

const char *pe_subsystem_name(uint16_t subsystem) {
    switch (subsystem) {
    case PE_SUBSYSTEM_CONSOLE: return "Console (CUI)";
    case PE_SUBSYSTEM_GUI:     return "Windows GUI";
    default:                   return "Unknown";
    }
}
