; vmtest.asm — KHY OS virtual-memory mutation test (Phase 19). Proves a Ring 3
; program can give memory back and re-protect it, not just acquire it: mprotect
; turns a writable mapping read-only (a write then faults), and munmap releases a
; mapping entirely (any access then faults). A toy kernel can only ever add
; mappings; a real OS lets a process shrink and re-protect its address space —
; the basis of guard pages, JIT W^X, and freeing large buffers.
;
; The faults are observed from a child so the parent survives to report success:
; a Ring 3 page fault terminates the offending process with exit code 142
; (128 + vector 14). The parent fork()s, the child performs the illegal access
; and is killed, and the parent wait()s and checks the harvested code is 142.
;
; Sequence (all from Ring 3 via int 0x80):
;   1.  mmap(MAPADDR, 4096, WRITABLE, _, _)   -> 0      (anonymous, writable)
;   2.  store 0x42 at MAPADDR ; reload == 0x42         (writable confirmed)
;   3.  mprotect(MAPADDR, 4096, 0)            -> 0      (drop write permission)
;   4.  reload MAPADDR == 0x42                          (still readable in parent)
;   5.  fork; child writes MAPADDR -> #PF; parent wait()s, code == 142
;   6.  munmap(MAPADDR, 4096)                 -> 0
;   7.  fork; child reads MAPADDR -> #PF; parent wait()s, code == 142
; Any deviation jumps to .fail (exit 1). Success prints OK and exits 0.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args 0-2, ret in rax.
; The int 0x80 stub preserves every GP register except rax.

bits 64

%define SYS_WRITE    1
%define SYS_EXIT     2
%define SYS_FORK     19
%define SYS_WAIT     21
%define SYS_MMAP     17
%define SYS_MUNMAP   43
%define SYS_MPROTECT 44

%define PROT_WRITE   0x02              ; VMM_FLAG_WRITABLE
%define FAULT_CODE   142               ; 128 + #PF vector (14)

; A mapping address high in the user window (>= VMM_USER_BASE = 512 GiB), clear of
; the program image (0x400000) and the stack (~128 TiB top).
%define MAPADDR      0x0000009000000000

%macro WRITE 2
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_WRITE
    int     0x80
%endmacro

section .text
global _start

_start:
    ; 1. anonymous, writable mapping.
    mov     rdi, MAPADDR
    mov     rsi, 4096
    mov     rdx, PROT_WRITE
    xor     r10, r10
    xor     r8, r8
    mov     rax, SYS_MMAP
    int     0x80
    test    rax, rax
    jnz     .fail

    ; 2. it is writable.
    mov     rsi, MAPADDR
    mov     byte [rsi], 0x42
    cmp     byte [rsi], 0x42
    jne     .fail

    ; 3. drop write permission.
    mov     rdi, MAPADDR
    mov     rsi, 4096
    xor     rdx, rdx                   ; read-only
    mov     rax, SYS_MPROTECT
    int     0x80
    test    rax, rax
    jnz     .fail

    ; 4. the parent can still read the byte it stored.
    mov     rsi, MAPADDR
    cmp     byte [rsi], 0x42
    jne     .fail

    ; 5. a write from a child must now fault (read-only enforced).
    mov     rax, SYS_FORK
    int     0x80
    test    rax, rax
    jz      .child_write
    call    .wait_fault
    jne     .fail

    ; 6. release the mapping entirely.
    mov     rdi, MAPADDR
    mov     rsi, 4096
    mov     rax, SYS_MUNMAP
    int     0x80
    test    rax, rax
    jnz     .fail

    ; 7. any access from a child must now fault (region unmapped).
    mov     rax, SYS_FORK
    int     0x80
    test    rax, rax
    jz      .child_read
    call    .wait_fault
    jne     .fail

    WRITE   ok_line, ok_line_len
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

; Reap one child and set ZF=1 iff its exit code was FAULT_CODE. Clobbers rax/rdi
; and the 16 bytes below rsp; preserves the caller's other registers.
.wait_fault:
    sub     rsp, 16
    mov     rdi, rsp                   ; &status
    mov     rax, SYS_WAIT
    int     0x80
    mov     eax, [rsp]                 ; harvested exit code (zero-extended)
    add     rsp, 16
    cmp     eax, FAULT_CODE
    ret

.child_write:
    mov     rsi, MAPADDR
    mov     byte [rsi], 0x99           ; write to read-only page -> #PF, killed
    mov     rdi, 7                     ; unreachable; a wrong code fails the parent
    mov     rax, SYS_EXIT
    int     0x80

.child_read:
    mov     rsi, MAPADDR
    mov     al, [rsi]                  ; read unmapped page -> #PF, killed
    mov     rdi, 7
    mov     rax, SYS_EXIT
    int     0x80

.fail:
    WRITE   bad_line, bad_line_len
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80

section .rodata
ok_line:     db "[user] vmtest: mprotect + munmap enforced -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] vmtest: VM MUTATION FAIL", 0x0A
bad_line_len equ $ - bad_line
