/* elf.c — Minimal ELF64 loader for user processes * @pattern Interpreter
 */

#include "elf.h"
#include "serial.h"
#include "string.h"

#define ELF_MAGIC0 0x7F
#define ELF_MAGIC1 'E'
#define ELF_MAGIC2 'L'
#define ELF_MAGIC3 'F'

#define ELFCLASS64 2
#define ELFDATA2LSB 1
#define EV_CURRENT 1
#define EM_X86_64 62
#define ET_EXEC 2
#define ET_DYN 3

#define PT_LOAD 1

#define PF_X 1
#define PF_W 2

struct elf64_ehdr {
    uint8_t  e_ident[16];
    uint16_t e_type;
    uint16_t e_machine;
    uint32_t e_version;
    uint64_t e_entry;
    uint64_t e_phoff;
    uint64_t e_shoff;
    uint32_t e_flags;
    uint16_t e_ehsize;
    uint16_t e_phentsize;
    uint16_t e_phnum;
    uint16_t e_shentsize;
    uint16_t e_shnum;
    uint16_t e_shstrndx;
} __attribute__((packed));

struct elf64_phdr {
    uint32_t p_type;
    uint32_t p_flags;
    uint64_t p_offset;
    uint64_t p_vaddr;
    uint64_t p_paddr;
    uint64_t p_filesz;
    uint64_t p_memsz;
    uint64_t p_align;
} __attribute__((packed));

static uint64_t min_u64(uint64_t a, uint64_t b) {
    return a < b ? a : b;
}

static uint64_t max_u64(uint64_t a, uint64_t b) {
    return a > b ? a : b;
}

static uint64_t align_down_u64(uint64_t v, uint64_t align) {
    return v & ~(align - 1);
}

static uint64_t align_up_u64(uint64_t v, uint64_t align) {
    return (v + align - 1) & ~(align - 1);
}

int elf_validate_image(const uint8_t *image, size_t size) {
    if (!image || size < sizeof(struct elf64_ehdr))
        return -1;

    const struct elf64_ehdr *eh = (const struct elf64_ehdr *)image;
    if (eh->e_ident[0] != ELF_MAGIC0 || eh->e_ident[1] != ELF_MAGIC1 ||
        eh->e_ident[2] != ELF_MAGIC2 || eh->e_ident[3] != ELF_MAGIC3)
        return -2;
    if (eh->e_ident[4] != ELFCLASS64 || eh->e_ident[5] != ELFDATA2LSB)
        return -3;
    if (eh->e_ident[6] != EV_CURRENT || eh->e_version != EV_CURRENT)
        return -4;
    if (eh->e_machine != EM_X86_64)
        return -5;
    if (eh->e_type != ET_EXEC && eh->e_type != ET_DYN)
        return -6;
    if (eh->e_phentsize != sizeof(struct elf64_phdr))
        return -7;

    uint64_t ph_end = eh->e_phoff + (uint64_t)eh->e_phnum * (uint64_t)eh->e_phentsize;
    if (eh->e_phnum == 0) {
        if (eh->e_phoff > size)
            return -8;
    } else {
        if (eh->e_phoff >= size || ph_end > size)
            return -8;
    }

    return 0;
}

int elf_load_user_image(const uint8_t *image, size_t size, struct vm_space *space, struct elf_image *out) {
    if (!space || !out)
        return -1;

    int valid = elf_validate_image(image, size);
    if (valid != 0)
        return valid;

    const struct elf64_ehdr *eh = (const struct elf64_ehdr *)image;
    const struct elf64_phdr *ph = (const struct elf64_phdr *)(image + eh->e_phoff);

    uint64_t high_brk = 0;
    uint16_t seg_count = 0;

    for (uint16_t i = 0; i < eh->e_phnum; i++) {
        if (ph[i].p_type != PT_LOAD || ph[i].p_memsz == 0)
            continue;
        if (ph[i].p_filesz > ph[i].p_memsz)
            return -20;
        /* [SAFE] Overflow-safe file-extent check. p_offset and p_filesz are
         * attacker-controlled; the naive (p_offset + p_filesz) can wrap past
         * UINT64_MAX and slip a malformed segment past this bound, after which
         * the memcpy below would read far outside the image (kernel memory
         * disclosure / fault). Compare without ever adding. */
        if (ph[i].p_filesz > size || ph[i].p_offset > size - ph[i].p_filesz)
            return -21;

        uint64_t seg_base = ph[i].p_vaddr;
        if (seg_base < VMM_USER_BASE)
            seg_base += VMM_USER_BASE;

        uint64_t seg_mem_start = seg_base;
        uint64_t seg_mem_end = seg_base + ph[i].p_memsz;
        uint64_t seg_file_end = seg_base + ph[i].p_filesz;
        if (seg_mem_end <= seg_mem_start)
            return -22;
        /* [SAFE] Confine the loadable segment to the user address window. A
         * crafted p_vaddr (already in the kernel half, so the +USER_BASE rebase
         * above does not fire) would otherwise map USER-accessible pages over
         * kernel space — a privilege breach baked into the binary. */
        if (seg_base < VMM_USER_BASE || seg_mem_end > VMM_USER_LIMIT)
            return -25;

        uint64_t page_start = align_down_u64(seg_mem_start, VMM_PAGE_SIZE);
        uint64_t page_end = align_up_u64(seg_mem_end, VMM_PAGE_SIZE);

        uint64_t flags = VMM_FLAG_USER;
        if (ph[i].p_flags & PF_W)
            flags |= VMM_FLAG_WRITABLE;
        if ((ph[i].p_flags & PF_X) == 0)
            flags |= VMM_FLAG_NO_EXEC;

        for (uint64_t va = page_start; va < page_end; va += VMM_PAGE_SIZE) {
            uint64_t phys = vmm_alloc_owned_page(space);
            if (!phys)
                return -23;
            uint8_t *page = (uint8_t *)vmm_phys_to_virt(phys);
            memset(page, 0, VMM_PAGE_SIZE);

            uint64_t copy_start = max_u64(va, seg_mem_start);
            uint64_t copy_end = min_u64(va + VMM_PAGE_SIZE, seg_file_end);
            if (copy_end > copy_start) {
                uint64_t page_off = copy_start - va;
                uint64_t file_off = ph[i].p_offset + (copy_start - seg_base);
                uint64_t copy_len = copy_end - copy_start;
                memcpy(page + page_off, image + file_off, (size_t)copy_len);
            }

            if (vmm_map_page(space, va, phys, flags | VMM_FLAG_PRESENT) != 0)
                return -24;
        }

        if (seg_mem_end > high_brk)
            high_brk = seg_mem_end;
        seg_count++;
    }

    out->segments = seg_count;
    out->entry = eh->e_entry < VMM_USER_BASE ? (eh->e_entry + VMM_USER_BASE) : eh->e_entry;
    out->brk = align_up_u64(high_brk, VMM_PAGE_SIZE);

    serial_print("[ELF] Loaded segments: ");
    serial_print_dec(out->segments);
    serial_print(" entry=");
    serial_print_hex(out->entry);
    serial_print("\n");
    return 0;
}
