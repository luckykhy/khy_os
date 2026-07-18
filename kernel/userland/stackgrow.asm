; stackgrow.asm — KHY OS Ring 3 program that walks its stack pointer far below
; the initially-mapped region, proving the kernel grows the user stack ON DEMAND
; instead of killing the process. A toy kernel maps a fixed stack and faults the
; first time a program recurses or allocates a large local frame; a real one
; treats a not-present fault inside the stack window as legitimate growth and
; maps a page so the access succeeds.
;
; The initial user stack is a few pages at the top of the user half. This program
; touches one byte every 4 KiB for 256 KiB below the starting RSP — every step
; lands on a fresh, not-yet-mapped page and must be satisfied by demand growth.
; If growth works it prints "survived" and exits 0; otherwise it dies with a
; #PF (the pre-growth behaviour).
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.

bits 64

%define SYS_WRITE 1
%define SYS_EXIT  2

%define STEP_BYTES 4096
%define STEP_COUNT 64          ; 64 * 4 KiB = 256 KiB of downward growth

section .text
global _start

_start:
    lea     rdi, [rel banner]
    mov     rsi, banner_len
    mov     rax, SYS_WRITE
    int     0x80

    ; Walk down STEP_COUNT pages from the current stack pointer, touching one
    ; byte on each. rbx is a roving probe pointer kept off the live stack so the
    ; syscalls in between don't clobber what we are testing.
    mov     rbx, rsp
    mov     rcx, STEP_COUNT
.grow:
    sub     rbx, STEP_BYTES
    mov     byte [rbx], 0x5A   ; first touch of each page → not-present stack fault
    dec     rcx
    jnz     .grow

    lea     rdi, [rel survived]
    mov     rsi, survived_len
    mov     rax, SYS_WRITE
    int     0x80

    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80
.hang:
    jmp     .hang

banner:       db  "[user] stackgrow: walking 256 KiB below RSP (expect on-demand growth)", 0x0A
banner_len    equ $ - banner
survived:     db  "[user] stackgrow: survived — stack grew on demand", 0x0A
survived_len  equ $ - survived
