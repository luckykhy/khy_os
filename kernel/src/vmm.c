/* vmm.c — Virtual memory manager and address-space abstraction * @pattern Strategy
 */

#include "vmm.h"
#include "kheap.h"
#include "pmm.h"
#include "serial.h"
#include "string.h"

static struct vm_space kernel_space;
static int vmm_ready;

static uint64_t align_up_u64(uint64_t v, uint64_t align) {
    return (v + align - 1) & ~(align - 1);
}

static int vmm_track_page(struct vm_space *space, uint64_t phys) {
    if (!space)
        return 0;
    if (space->tracked_count >= VMM_TRACKED_PAGES_MAX) {
        serial_print("[VMM] ERROR: tracked page table full\n");
        return -1;
    }
    space->tracked_pages[space->tracked_count++] = phys;
    return 0;
}

void *vmm_phys_to_virt(uint64_t phys_addr) {
    return (void *)(uint64_t)phys_addr;
}

uint64_t vmm_get_cr3(void) {
    uint64_t cr3;
    __asm__ volatile("mov %%cr3, %0" : "=r"(cr3));
    return cr3;
}

void vmm_switch_space(struct vm_space *space) {
    if (!space || !space->pml4_phys)
        return;
    __asm__ volatile("mov %0, %%cr3" : : "r"(space->pml4_phys) : "memory");
}

uint64_t vmm_alloc_owned_page(struct vm_space *space) {
    uint64_t phys = pmm_alloc_page();
    if (!phys)
        return 0;
    if (vmm_track_page(space, phys) != 0) {
        pmm_free_page(phys);
        return 0;
    }
    memset(vmm_phys_to_virt(phys), 0, VMM_PAGE_SIZE);
    return phys;
}

struct vm_space *vmm_kernel_space(void) {
    if (!vmm_ready)
        return 0;
    return &kernel_space;
}

void vmm_init(void) {
    memset(&kernel_space, 0, sizeof(kernel_space));
    kernel_space.pml4_phys = vmm_get_cr3() & ~0xFFFULL;
    kernel_space.pml4 = (uint64_t *)vmm_phys_to_virt(kernel_space.pml4_phys);
    kernel_space.next_user_va = VMM_USER_BASE;
    vmm_ready = 1;

    serial_print("[VMM] Initialized. CR3=");
    serial_print_hex(kernel_space.pml4_phys);
    serial_print("\n");
}

struct vm_space *vmm_create_user_space(void) {
    if (!vmm_ready)
        return 0;

    struct vm_space *space = (struct vm_space *)kmalloc(sizeof(struct vm_space));
    if (!space)
        return 0;
    memset(space, 0, sizeof(struct vm_space));
    space->next_user_va = VMM_USER_BASE;

    uint64_t pml4_phys = vmm_alloc_owned_page(space);
    if (!pml4_phys) {
        kfree(space);
        return 0;
    }

    space->pml4_phys = pml4_phys;
    space->pml4 = (uint64_t *)vmm_phys_to_virt(pml4_phys);

    /* Copy kernel mappings so kernel text/data remains reachable on traps. */
    memcpy(space->pml4, kernel_space.pml4, VMM_PAGE_SIZE);
    return space;
}

void vmm_destroy_space(struct vm_space *space) {
    if (!space || space == &kernel_space)
        return;

    for (size_t i = 0; i < space->tracked_count; i++) {
        if (space->tracked_pages[i]) {
            pmm_free_page(space->tracked_pages[i]);
        }
    }
    kfree(space);
}

static uint64_t *next_table(struct vm_space *space, uint64_t *table, uint16_t idx, uint64_t child_flags) {
    uint64_t entry = table[idx];
    if (entry & VMM_FLAG_PRESENT) {
        /* Reject huge-page entries on walk path. */
        if (entry & (1ULL << 7))
            return 0;
        return (uint64_t *)vmm_phys_to_virt(entry & ~0xFFFULL);
    }

    uint64_t phys = vmm_alloc_owned_page(space);
    if (!phys)
        return 0;

    table[idx] = phys | VMM_FLAG_PRESENT | VMM_FLAG_WRITABLE | (child_flags & VMM_FLAG_USER);
    return (uint64_t *)vmm_phys_to_virt(phys);
}

int vmm_map_page(struct vm_space *space, uint64_t virt_addr, uint64_t phys_addr, uint64_t flags) {
    if (!space || !space->pml4)
        return -1;
    if ((virt_addr & 0xFFFULL) || (phys_addr & 0xFFFULL))
        return -2;

    uint16_t pml4_i = (virt_addr >> 39) & 0x1FF;
    uint16_t pdpt_i = (virt_addr >> 30) & 0x1FF;
    uint16_t pd_i   = (virt_addr >> 21) & 0x1FF;
    uint16_t pt_i   = (virt_addr >> 12) & 0x1FF;

    uint64_t *pdpt = next_table(space, space->pml4, pml4_i, flags);
    if (!pdpt)
        return -3;
    uint64_t *pd = next_table(space, pdpt, pdpt_i, flags);
    if (!pd)
        return -4;
    uint64_t *pt = next_table(space, pd, pd_i, flags);
    if (!pt)
        return -5;

    uint64_t pte = (phys_addr & ~0xFFFULL) | VMM_FLAG_PRESENT;
    pte |= (flags & (VMM_FLAG_WRITABLE | VMM_FLAG_USER | VMM_FLAG_COW | VMM_FLAG_NO_EXEC));
    pt[pt_i] = pte;

    if ((vmm_get_cr3() & ~0xFFFULL) == space->pml4_phys) {
        __asm__ volatile("invlpg (%0)" : : "r"((void *)(uint64_t)virt_addr) : "memory");
    }

    return 0;
}

int vmm_map_anonymous(struct vm_space *space, uint64_t virt_addr, size_t size, uint64_t flags) {
    if (!space || size == 0)
        return -1;

    uint64_t start = virt_addr & ~0xFFFULL;
    uint64_t end = align_up_u64(virt_addr + size, VMM_PAGE_SIZE);

    for (uint64_t va = start; va < end; va += VMM_PAGE_SIZE) {
        uint64_t phys = vmm_alloc_owned_page(space);
        if (!phys)
            return -2;
        int rc = vmm_map_page(space, va, phys, flags | VMM_FLAG_PRESENT);
        if (rc != 0)
            return rc;
    }
    return 0;
}

int vmm_grow_user_stack(struct vm_space *space, uint64_t fault_va) {
    if (!space)
        return -1;

    /* Only faults inside the growth window [STACK_TOP - STACK_MAX, STACK_TOP)
     * are legitimate growth. Anything at/above the top or below the window is a
     * real wild access (e.g. true stack overflow) and stays fatal. */
    if (fault_va >= VMM_USER_STACK_TOP)
        return -1;
    if (fault_va < VMM_USER_STACK_TOP - VMM_USER_STACK_MAX)
        return -1;

    uint64_t page = fault_va & ~0xFFFULL;

    /* Already mapped → this was not a missing-page fault we should service;
     * let the caller treat it as fatal (e.g. a permission violation). */
    if (vmm_translate(space, page) != 0)
        return -1;

    uint64_t phys = vmm_alloc_owned_page(space); /* tracked + zeroed */
    if (!phys)
        return -1;

    /* Writable, user-accessible, non-executable — a data stack page. The map
     * runs while the faulting process's CR3 is active, so vmm_map_page issues
     * the invlpg itself and the retried instruction sees the fresh mapping. */
    if (vmm_map_page(space, page, phys,
                     VMM_FLAG_PRESENT | VMM_FLAG_WRITABLE | VMM_FLAG_USER | VMM_FLAG_NO_EXEC) != 0)
        return -1;

    return 0;
}

int vmm_map_user_buffer(struct vm_space *space, uint64_t virt_addr, const void *src, size_t len, uint64_t flags) {
    if (!space || !src || len == 0)
        return -1;

    const uint8_t *in = (const uint8_t *)src;
    size_t mapped = 0;

    while (mapped < len) {
        uint64_t page_va = (virt_addr + mapped) & ~0xFFFULL;
        size_t page_off = (size_t)((virt_addr + mapped) & 0xFFFULL);
        size_t chunk = VMM_PAGE_SIZE - page_off;
        if (chunk > (len - mapped))
            chunk = len - mapped;

        uint64_t phys = vmm_alloc_owned_page(space);
        if (!phys)
            return -2;

        uint8_t *page = (uint8_t *)vmm_phys_to_virt(phys);
        memset(page, 0, VMM_PAGE_SIZE);
        memcpy(page + page_off, in + mapped, chunk);

        int rc = vmm_map_page(space, page_va, phys, flags | VMM_FLAG_PRESENT | VMM_FLAG_USER);
        if (rc != 0)
            return rc;

        mapped += chunk;
    }

    return 0;
}

uint64_t vmm_alloc_user_range(struct vm_space *space, size_t size, uint64_t align) {
    if (!space || size == 0)
        return 0;
    if (align < VMM_PAGE_SIZE)
        align = VMM_PAGE_SIZE;

    uint64_t start = align_up_u64(space->next_user_va, align);
    uint64_t end = align_up_u64(start + size, VMM_PAGE_SIZE);
    if (end >= VMM_USER_LIMIT || end <= start)
        return 0;

    space->next_user_va = end;
    return start;
}

uint64_t vmm_translate(struct vm_space *space, uint64_t virt_addr) {
    if (!space || !space->pml4)
        return 0;

    uint16_t idx[4] = {
        (uint16_t)((virt_addr >> 39) & 0x1FF),
        (uint16_t)((virt_addr >> 30) & 0x1FF),
        (uint16_t)((virt_addr >> 21) & 0x1FF),
        (uint16_t)((virt_addr >> 12) & 0x1FF),
    };

    uint64_t *table = space->pml4;
    for (int level = 0; level < 4; level++) {
        uint64_t entry = table[idx[level]];
        if (!(entry & VMM_FLAG_PRESENT))
            return 0;
        /* This walker only handles 4 KiB leaf mappings (no huge pages). */
        if (level < 3 && (entry & (1ULL << 7)))
            return 0;
        /* Mask to the 52-bit physical frame: clear the low 12 flag bits AND the
         * high attribute bits (notably NX / bit 63, which leaf PTEs set for
         * NO_EXEC pages). Leaving bit 63 in would make the address non-canonical
         * and any kernel access through it would #GP. */
        uint64_t next_phys = entry & 0x000FFFFFFFFFF000ULL;
        if (level == 3)
            return next_phys | (virt_addr & 0xFFFULL);
        table = (uint64_t *)vmm_phys_to_virt(next_phys);
    }
    return 0;
}

int vmm_copy_to_user(struct vm_space *space, uint64_t dst_va, const void *src, size_t len) {
    if (!space || !src)
        return -1;

    const uint8_t *in = (const uint8_t *)src;
    size_t done = 0;
    while (done < len) {
        uint64_t va = dst_va + done;
        /* The kernel is about to write into this user page; if it is shared
         * copy-on-write, break it first so we mutate the writer's private copy
         * rather than the page the other owner still sees. */
        vmm_cow_break(space, va);
        uint64_t phys = vmm_translate(space, va);
        if (!phys)
            return -1;
        size_t off = (size_t)(va & 0xFFFULL);
        size_t chunk = VMM_PAGE_SIZE - off;
        if (chunk > (len - done))
            chunk = len - done;
        memcpy((uint8_t *)vmm_phys_to_virt(phys), in + done, chunk);
        done += chunk;
    }
    return 0;
}

/* Return a pointer to the 4 KiB leaf PTE backing `va` in `space`, or NULL if any
 * level along the walk is not present (or is a huge-page entry). Lets callers
 * read and rewrite a single mapping in place — used by the COW machinery. */
static uint64_t *vmm_leaf_pte(struct vm_space *space, uint64_t va) {
    if (!space || !space->pml4)
        return 0;
    uint16_t idx[4] = {
        (uint16_t)((va >> 39) & 0x1FF),
        (uint16_t)((va >> 30) & 0x1FF),
        (uint16_t)((va >> 21) & 0x1FF),
        (uint16_t)((va >> 12) & 0x1FF),
    };
    uint64_t *table = space->pml4;
    for (int level = 0; level < 3; level++) {
        uint64_t entry = table[idx[level]];
        if (!(entry & VMM_FLAG_PRESENT) || (entry & (1ULL << 7)))
            return 0;
        table = (uint64_t *)vmm_phys_to_virt(entry & 0x000FFFFFFFFFF000ULL);
    }
    return &table[idx[3]];
}

int vmm_cow_break(struct vm_space *space, uint64_t fault_va) {
    uint64_t *pte = vmm_leaf_pte(space, fault_va & ~0xFFFULL);
    if (!pte)
        return 0;
    uint64_t e = *pte;
    /* Only present, COW-marked, currently read-only pages are ours to break. A
     * writable page needs no break; a non-COW read-only page is a real fault. */
    if (!(e & VMM_FLAG_PRESENT) || !(e & VMM_FLAG_COW) || (e & VMM_FLAG_WRITABLE))
        return 0;

    uint64_t old_phys = e & 0x000FFFFFFFFFF000ULL;
    int active = (vmm_get_cr3() & ~0xFFFULL) == space->pml4_phys;

    if (pmm_refcount(old_phys) <= 1) {
        /* Sole remaining owner: reclaim the page in place — just make it
         * writable again and drop the COW mark, no copy needed. */
        *pte = (e | VMM_FLAG_WRITABLE) & ~VMM_FLAG_COW;
    } else {
        /* Shared: give this space a private, writable copy of the contents. The
         * old frame keeps its place in this space's tracked-page list and is
         * released (decref) when the space is destroyed, keeping refcounts and
         * the per-space ownership list in agreement. */
        uint64_t new_phys = vmm_alloc_owned_page(space);
        if (!new_phys)
            return -1;
        memcpy(vmm_phys_to_virt(new_phys), vmm_phys_to_virt(old_phys), VMM_PAGE_SIZE);
        *pte = new_phys | VMM_FLAG_PRESENT | VMM_FLAG_USER | VMM_FLAG_WRITABLE |
               (e & VMM_FLAG_NO_EXEC);
    }

    if (active)
        __asm__ volatile("invlpg (%0)" : : "r"((void *)(fault_va & ~0xFFFULL)) : "memory");
    return 1;
}

/* Drop the first occurrence of physical frame `phys` from `space`'s owned-page
 * list (swap-with-last removal). Keeps the tracked list and the per-frame
 * refcount in agreement when a single mapping is torn down before the whole
 * space is destroyed. */
static void vmm_untrack_page(struct vm_space *space, uint64_t phys) {
    for (size_t i = 0; i < space->tracked_count; i++) {
        if (space->tracked_pages[i] == phys) {
            space->tracked_pages[i] = space->tracked_pages[--space->tracked_count];
            return;
        }
    }
}

int vmm_unmap_range(struct vm_space *space, uint64_t virt_addr, size_t size) {
    if (!space || !space->pml4 || size == 0)
        return -1;

    uint64_t start = virt_addr & ~0xFFFULL;
    uint64_t end = align_up_u64(virt_addr + size, VMM_PAGE_SIZE);
    if (end <= start)
        return -1;

    int active = (vmm_get_cr3() & ~0xFFFULL) == space->pml4_phys;

    for (uint64_t va = start; va < end; va += VMM_PAGE_SIZE) {
        uint64_t *pte = vmm_leaf_pte(space, va);
        if (!pte || !(*pte & VMM_FLAG_PRESENT))
            continue;                       /* hole — nothing mapped to release */
        uint64_t phys = *pte & 0x000FFFFFFFFFF000ULL;
        *pte = 0;
        vmm_untrack_page(space, phys);
        pmm_free_page(phys);                /* decref; frees only at the last owner */
        if (active)
            __asm__ volatile("invlpg (%0)" : : "r"((void *)va) : "memory");
    }
    return 0;
}

int vmm_protect_range(struct vm_space *space, uint64_t virt_addr, size_t size, uint64_t flags) {
    if (!space || !space->pml4 || size == 0)
        return -1;

    uint64_t start = virt_addr & ~0xFFFULL;
    uint64_t end = align_up_u64(virt_addr + size, VMM_PAGE_SIZE);
    if (end <= start)
        return -1;

    int want_write = (flags & VMM_FLAG_WRITABLE) != 0;
    int active = (vmm_get_cr3() & ~0xFFFULL) == space->pml4_phys;

    for (uint64_t va = start; va < end; va += VMM_PAGE_SIZE) {
        /* Granting write access must first resolve any copy-on-write sharing, so
         * the new permission lands on a private copy rather than a frame another
         * address space still observes read-only. */
        if (want_write)
            vmm_cow_break(space, va);
        uint64_t *pte = vmm_leaf_pte(space, va);
        if (!pte || !(*pte & VMM_FLAG_PRESENT))
            return -1;                      /* caller promised a fully mapped range */
        if (want_write)
            *pte |= VMM_FLAG_WRITABLE;
        else
            *pte &= ~VMM_FLAG_WRITABLE;
        if (active)
            __asm__ volatile("invlpg (%0)" : : "r"((void *)va) : "memory");
    }
    return 0;
}

/* Recursively clone the user (USER-flagged) leaves of one source page-table
 * subtree into `dst`, sharing each leaf physical page copy-on-write (see the
 * leaf branch). level: 1=PDPT, 2=PD, 3=PT(leaf). va_base accumulates the address
 * bits decoded at higher levels. Returns 0 on success, -1 on any allocation or
 * mapping failure (the caller tears down the half-built dst). */
static int clone_user_subtree(struct vm_space *dst, uint64_t *table, int level, uint64_t va_base) {
    for (int i = 0; i < 512; i++) {
        uint64_t e = table[i];
        if ((e & (VMM_FLAG_PRESENT | VMM_FLAG_USER)) != (VMM_FLAG_PRESENT | VMM_FLAG_USER))
            continue;
        uint64_t va = va_base | ((uint64_t)i << (39 - 9 * level));
        if (level == 3) {
            /* Leaf: share the parent's physical page copy-on-write instead of
             * copying it eagerly. A writable page is remapped read-only and
             * COW-marked in BOTH parent and child (the parent's PTE is `table[i]`
             * we are walking), so the first writer in either takes the fault and
             * gets a private copy. A page that is already read-only (e.g. code)
             * is simply shared — neither side will ever write it. Either way the
             * child references the same frame, so we bump its refcount and record
             * it in the child's tracked-page list for eventual release. */
            uint64_t src_phys = e & 0x000FFFFFFFFFF000ULL;
            int writable = (e & VMM_FLAG_WRITABLE) != 0;
            uint64_t child_flags = (e & (VMM_FLAG_USER | VMM_FLAG_NO_EXEC));
            if (writable) {
                child_flags |= VMM_FLAG_COW;
                /* Downgrade the parent's mapping to read-only + COW in place. */
                table[i] = (e & ~VMM_FLAG_WRITABLE) | VMM_FLAG_COW;
            } else {
                child_flags |= (e & VMM_FLAG_WRITABLE); /* stays as-is (0 here) */
            }
            pmm_incref(src_phys);
            if (vmm_track_page(dst, src_phys) != 0) {
                pmm_free_page(src_phys); /* undo the incref we just took */
                return -1;
            }
            if (vmm_map_page(dst, va, src_phys, child_flags | VMM_FLAG_PRESENT) != 0)
                return -1;
        } else {
            if (e & (1ULL << 7)) /* no huge pages expected in user subtrees */
                return -1;
            uint64_t *child = (uint64_t *)vmm_phys_to_virt(e & 0x000FFFFFFFFFF000ULL);
            if (clone_user_subtree(dst, child, level + 1, va) != 0)
                return -1;
        }
    }
    return 0;
}

struct vm_space *vmm_clone_space(struct vm_space *src) {
    if (!src || !src->pml4)
        return 0;

    struct vm_space *dst = vmm_create_user_space();
    if (!dst)
        return 0;
    /* Preserve the heap/mmap bump pointer so the child's future allocations
     * start where the parent's would have. */
    dst->next_user_va = src->next_user_va;

    /* Walk the source PML4. Only entries carrying the USER flag are the
     * process's own mappings (image at pml4[1], stack at pml4[255], any mmap);
     * kernel entries (low identity at pml4[0], higher half) lack USER and were
     * already installed, shared, by vmm_create_user_space — leave them be.
     * User VAs live in the lower canonical half (index < 256), so the base
     * address needs no sign extension. */
    for (int i = 0; i < 512; i++) {
        uint64_t e = src->pml4[i];
        if ((e & (VMM_FLAG_PRESENT | VMM_FLAG_USER)) != (VMM_FLAG_PRESENT | VMM_FLAG_USER))
            continue;
        if (e & (1ULL << 7)) {
            vmm_destroy_space(dst);
            return 0;
        }
        uint64_t *pdpt = (uint64_t *)vmm_phys_to_virt(e & 0x000FFFFFFFFFF000ULL);
        if (clone_user_subtree(dst, pdpt, 1, (uint64_t)i << 39) != 0) {
            vmm_destroy_space(dst);
            return 0;
        }
    }

    /* The clone downgraded the parent's writable user pages to read-only+COW in
     * place. If the parent's address space is the one currently loaded (it is —
     * fork runs in the parent's context), its TLB still holds the old writable
     * translations; reload CR3 to flush them so the parent also faults on its
     * next write and gets its own copy. */
    if ((vmm_get_cr3() & ~0xFFFULL) == src->pml4_phys)
        __asm__ volatile("mov %0, %%cr3" : : "r"(src->pml4_phys) : "memory");

    return dst;
}

/* Validate that every page in the user range [va, va+len) is mapped in `space`
 * with the USER flag (and WRITABLE when need_write), walking the page tables
 * leaf-by-leaf. Returns 0 if the whole range is safe for the kernel to touch on
 * the caller's behalf, -1 otherwise. Rejects wrap-around and any address that
 * reaches the kernel half. Used by the int 0x80 layer to vet Ring 3 pointers. */
int vmm_check_user_range(struct vm_space *space, uint64_t va, size_t len, int need_write) {
    if (!space || !space->pml4)
        return -1;
    if (len == 0)
        return 0;

    /* Reject wrap-around and anything reaching into the non-canonical / kernel
     * half. The per-page USER check below is the real authority, but this
     * rejects absurd lengths cheaply and never walks for kernel addresses. */
    uint64_t end = va + len;
    if (end < va || end > VMM_USER_LIMIT)
        return -1;

    uint64_t want = VMM_FLAG_PRESENT | VMM_FLAG_USER |
                    (need_write ? VMM_FLAG_WRITABLE : 0);
    uint64_t page = va & ~0xFFFULL;
    uint64_t last = (end - 1) & ~0xFFFULL;

    for (;; page += VMM_PAGE_SIZE) {
        /* A writable check on a copy-on-write page must break it here: the
         * kernel is about to write the page on the user's behalf, and the COW
         * page is read-only until copied. After the break it is privately
         * writable and the WRITABLE check below passes. */
        if (need_write)
            vmm_cow_break(space, page);
        uint16_t idx[4] = {
            (uint16_t)((page >> 39) & 0x1FF),
            (uint16_t)((page >> 30) & 0x1FF),
            (uint16_t)((page >> 21) & 0x1FF),
            (uint16_t)((page >> 12) & 0x1FF),
        };
        uint64_t *table = space->pml4;
        uint64_t entry = 0;
        for (int level = 0; level < 4; level++) {
            entry = table[idx[level]];
            if (!(entry & VMM_FLAG_PRESENT))
                return -1;
            /* This walker only handles 4 KiB leaves (no huge pages). The USER
             * flag is propagated onto the intermediate tables when a user page
             * is mapped (see vmm_map_page), so checking the leaf's flags is
             * consistent with how this VMM builds user mappings. */
            if (level < 3 && (entry & (1ULL << 7)))
                return -1;
            if (level == 3)
                break;
            table = (uint64_t *)vmm_phys_to_virt(entry & 0x000FFFFFFFFFF000ULL);
        }
        if ((entry & want) != want)
            return -1;
        if (page == last)
            break;
    }
    return 0;
}
