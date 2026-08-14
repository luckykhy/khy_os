/* vmm.h — Virtual memory manager and address-space abstraction * @pattern Strategy
 */
#ifndef VMM_H
#define VMM_H

#include <stddef.h>
#include <stdint.h>

#define VMM_PAGE_SIZE 4096ULL

/* Lower canonical half user range (starts at PML4 index 1, 512 GiB). */
#define VMM_USER_BASE       0x0000008000000000ULL
#define VMM_USER_LIMIT      0x00007FFFFFFFF000ULL
#define VMM_USER_STACK_TOP  0x00007FFFFFFFE000ULL

/* The user stack grows downward on demand within this window below the top. A
 * not-present fault inside [STACK_TOP - STACK_MAX, STACK_TOP) is legitimate
 * growth (the page is mapped and the faulting instruction retried); a fault
 * below the window is a real stack overflow and the process is terminated. */
#define VMM_USER_STACK_MAX  0x0000000000100000ULL  /* 1 MiB */

/* Page-table flags */
#define VMM_FLAG_PRESENT   (1ULL << 0)
#define VMM_FLAG_WRITABLE  (1ULL << 1)
#define VMM_FLAG_USER      (1ULL << 2)
/* Software-defined bit (CPU-ignored, bits 9-11 are free for OS use): marks a
 * page shared copy-on-write. Such a page is mapped read-only in every owner; a
 * write fault triggers vmm_cow_break, which gives the writer a private copy. */
#define VMM_FLAG_COW       (1ULL << 9)
#define VMM_FLAG_NO_EXEC   (1ULL << 63)

#define VMM_TRACKED_PAGES_MAX 4096

struct vm_space {
    uint64_t *pml4;
    uint64_t pml4_phys;
    uint64_t next_user_va;
    uint64_t tracked_pages[VMM_TRACKED_PAGES_MAX];
    size_t   tracked_count;
};

void vmm_init(void);
struct vm_space *vmm_kernel_space(void);
struct vm_space *vmm_create_user_space(void);
void vmm_destroy_space(struct vm_space *space);

uint64_t vmm_get_cr3(void);
void vmm_switch_space(struct vm_space *space);

void *vmm_phys_to_virt(uint64_t phys_addr);
uint64_t vmm_alloc_owned_page(struct vm_space *space);

/* Walk `space`'s page tables and resolve a virtual address to its physical
 * address (page base | offset), or 0 if the VA is not mapped. Works regardless
 * of the currently active CR3 since the walk follows phys_to_virt links. */
uint64_t vmm_translate(struct vm_space *space, uint64_t virt_addr);

/* Copy `len` bytes from a kernel buffer into already-mapped pages of `space`
 * at `dst_va` (handles page crossings). Returns 0 on success, -1 if any byte
 * of the destination range is unmapped. Unlike vmm_map_user_buffer this writes
 * into existing mappings rather than allocating new ones. */
int vmm_copy_to_user(struct vm_space *space, uint64_t dst_va, const void *src, size_t len);

/* Validate that every byte of [va, va+len) is mapped in `space` as a
 * user-accessible (USER flag) 4 KiB page — and writable too when need_write is
 * set. Returns 0 if the kernel may safely dereference the whole range on the
 * user's behalf, -1 otherwise. This is the gate that stops a buggy/malicious
 * Ring 3 program from handing a syscall a pointer into kernel memory (kernel
 * pages lack the USER flag) or an unmapped/non-canonical address (which would
 * #PF in Ring 0 and panic the kernel). xv6's argptr/fetchstr do the same job
 * with a single proc->sz; KHY OS walks the page tables instead because user
 * memory is non-contiguous (image near 0x400000, stack near 0x7FFF...). */
int vmm_check_user_range(struct vm_space *space, uint64_t va, size_t len, int need_write);

/* Copy-on-write clone of a user address space: creates a new space sharing the
 * kernel mappings and mapping every USER page of `src` at the same virtual
 * address, but sharing the physical frames copy-on-write — writable pages are
 * downgraded to read-only+COW in both parent and child, so the first write in
 * either side faults and gets a private copy (see vmm_cow_break). fork() builds
 * on this; it makes fork cheap (no eager page copy). Returns the new space, or 0
 * on failure. */
struct vm_space *vmm_clone_space(struct vm_space *src);

/* Resolve a copy-on-write write fault at `fault_va` in `space`. If the page is
 * a COW page (present, read-only, COW-marked) it is made privately writable:
 * either reclaimed in place when this space is its only remaining owner, or
 * replaced with a fresh private copy otherwise; the faulting instruction can
 * then be retried. Returns 1 if handled (retry), 0 if `fault_va` is not a COW
 * page (a genuine protection fault the caller must treat as fatal), or -1 on
 * allocation failure (also fatal). */
int vmm_cow_break(struct vm_space *space, uint64_t fault_va);

int vmm_map_page(struct vm_space *space, uint64_t virt_addr, uint64_t phys_addr, uint64_t flags);
int vmm_map_anonymous(struct vm_space *space, uint64_t virt_addr, size_t size, uint64_t flags);
int vmm_map_user_buffer(struct vm_space *space, uint64_t virt_addr, const void *src, size_t len, uint64_t flags);
uint64_t vmm_alloc_user_range(struct vm_space *space, size_t size, uint64_t align);

/* On-demand stack growth. Called from the page-fault path for a not-present
 * Ring 3 fault: if `fault_va` lies in the stack growth window (see
 * VMM_USER_STACK_MAX) and is not already mapped, map a single zeroed, writable,
 * non-executable user page covering it so the faulting access can be retried.
 * Returns 0 if the page was mapped (recoverable), -1 if `fault_va` is not a
 * growable stack address (the caller must treat the fault as fatal). */
int vmm_grow_user_stack(struct vm_space *space, uint64_t fault_va);

/* Unmap and release every present 4 KiB page in [virt_addr, virt_addr+size) from
 * `space`: each leaf mapping is cleared, its physical frame released (decref — a
 * frame still shared copy-on-write with another space survives), removed from the
 * space's owned-page list, and its TLB entry flushed when the space is active.
 * Holes in the range are skipped. The inverse of mmap. Returns 0 on success, -1
 * on a bad argument. */
int vmm_unmap_range(struct vm_space *space, uint64_t virt_addr, size_t size);

/* Change the protection of every present 4 KiB page in [virt_addr, virt_addr+
 * size) in `space` to the WRITABLE bit of `flags`, preserving every other
 * attribute (the frame, USER, NX, PRESENT). Making a page writable first breaks
 * any copy-on-write sharing so the new permission stays private to this space.
 * Returns 0 on success, -1 on a bad argument or a hole in the range; the caller
 * is expected to have validated that the range is fully mapped. */
int vmm_protect_range(struct vm_space *space, uint64_t virt_addr, size_t size, uint64_t flags);

#endif
