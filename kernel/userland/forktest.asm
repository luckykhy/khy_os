; forktest.asm — KHY OS Ring 3 program that proves fork() works: one int 0x80
; (SYS_FORK) returns twice — the child sees rax=0 and the parent sees the child
; pid (> 0). Each branch prints its own banner, then exits, so a single run
; produces BOTH lines and TWO clean reaps.
;
; fork() semantics (src/process.c process_fork):
;   - duplicates the caller's whole address space (image, stack, heap),
;   - the child resumes from this very int 0x80 with rax = 0,
;   - the parent's int 0x80 returns the child pid.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.
; The int 0x80 stub preserves every GP register except rax.

bits 64

%define SYS_WRITE 1
%define SYS_EXIT  2
%define SYS_FORK  19

section .text
global _start

_start:
    ; banner before the fork (single process → printed once)
    lea     rdi, [rel banner]
    mov     rsi, banner_len
    mov     rax, SYS_WRITE
    int     0x80

    ; fork(): returns twice — 0 in the child, child pid in the parent.
    mov     rax, SYS_FORK
    int     0x80
    test    rax, rax
    jz      .child

    ; ── parent branch (rax = child pid > 0) ──
    lea     rdi, [rel parent_msg]
    mov     rsi, parent_msg_len
    mov     rax, SYS_WRITE
    int     0x80
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80
    jmp     .hang

.child:
    ; ── child branch (rax = 0) ──
    lea     rdi, [rel child_msg]
    mov     rsi, child_msg_len
    mov     rax, SYS_WRITE
    int     0x80
    mov     rdi, 7                 ; distinct exit code, proves child path ran
    mov     rax, SYS_EXIT
    int     0x80

.hang:
    jmp     .hang

banner:         db  "[user] forktest: about to fork", 0x0A
banner_len      equ $ - banner
parent_msg:     db  "[user] forktest PARENT: fork returned a child pid", 0x0A
parent_msg_len  equ $ - parent_msg
child_msg:      db  "[user] forktest CHILD: fork returned 0", 0x0A
child_msg_len   equ $ - child_msg
