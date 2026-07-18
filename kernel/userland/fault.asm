; fault.asm — KHY OS Ring 3 program that triggers a GENUINE CPU fault in user
; mode, proving the kernel now isolates it: only this process dies, the kernel
; and shell survive. Unlike badptr.asm (which hands bad pointers to syscalls and
; gets a polite -1), this program dereferences an unmapped address DIRECTLY, so
; the CPU raises a #PF from Ring 3 with no syscall layer in between — exactly the
; "segfault" a real program hits. A toy kernel panics and halts here; a real one
; reaps the offending process and returns to the prompt.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.

bits 64

%define SYS_WRITE 1
%define SYS_EXIT  2

section .text
global _start

_start:
    ; alive banner (valid pointer → must succeed)
    lea     rdi, [rel banner]
    mov     rsi, banner_len
    mov     rax, SYS_WRITE
    int     0x80

    ; Trigger a real Ring 3 page fault: write a byte to a low, unmapped,
    ; canonical address (well below the image base at 0x400000 and far from the
    ; user stack near the top of the lower half). The store faults with a
    ; write/not-present/user error code. Execution must NOT continue past here.
    mov     rax, 0x0000000000010000
    mov     byte [rax], 0x42

    ; Unreachable if isolation works (the process is killed at the store above).
    ; Kept as a fallback so a kernel that somehow resumes us still exits cleanly
    ; instead of running off into garbage.
    lea     rdi, [rel leaked]
    mov     rsi, leaked_len
    mov     rax, SYS_WRITE
    int     0x80
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80
.hang:
    jmp     .hang

banner:     db  "[user] fault: dereferencing an unmapped pointer (expect a clean kill)", 0x0A
banner_len  equ $ - banner
leaked:     db  "[user] fault: ERROR — execution continued past the faulting store", 0x0A
leaked_len  equ $ - leaked
