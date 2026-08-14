; badptr.asm — KHY OS Ring 3 program that hands the kernel deliberately bad
; pointers, proving the syscall layer now refuses them (returns -1) instead of
; faulting in Ring 0 and panicking the whole kernel.
;
; Three probes, each must return -1 (0xFFFFFFFFFFFFFFFF) without crashing:
;   1. write(buf = kernel-half address, len) — a kernel page lacks the USER
;      flag, so vmm_check_user_range rejects it (would otherwise leak/clobber
;      kernel memory, since int 0x80 runs in Ring 0 with the kernel mapped).
;   2. write(buf = unmapped low user address, len) — present check fails
;      (would otherwise #PF in Ring 0).
;   3. read(fd = 0 (none open), buf = unmapped, len) — bad fd caught first;
;      kept as a smoke probe that the read path also stays alive.
; A valid write before and after proves the program (and the kernel) survive.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.
; The int 0x80 stub preserves every GP register except rax.

bits 64

%define SYS_WRITE 1
%define SYS_EXIT  2
%define SYS_READ  6

section .text
global _start

_start:
    ; alive banner (valid pointer → must succeed)
    lea     rdi, [rel banner]
    mov     rsi, banner_len
    mov     rax, SYS_WRITE
    int     0x80

    ; probe 1: write from a kernel-half address (canonical high half).
    mov     rdi, 0xFFFF800000000000
    mov     rsi, 16
    mov     rax, SYS_WRITE
    int     0x80
    call    report_rc              ; prints "  rc=-1" or "  rc=ok"

    ; probe 2: write from an unmapped low user address.
    mov     rdi, 0x0000000000011000
    mov     rsi, 16
    mov     rax, SYS_WRITE
    int     0x80
    call    report_rc

    ; probe 3: read into an unmapped buffer with no fd open.
    xor     rdi, rdi               ; fd = 0
    mov     rsi, 0x0000000000011000
    mov     rdx, 16
    mov     rax, SYS_READ
    int     0x80
    call    report_rc

    ; survived banner (valid pointer → must succeed)
    lea     rdi, [rel survived]
    mov     rsi, survived_len
    mov     rax, SYS_WRITE
    int     0x80

    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80
.hang:
    jmp     .hang

; report_rc: rax holds the last syscall return. Print "  rc=" then "-1" if rax
; == -1 (the refusal we expect) else "ok", then newline. Scratch is built on the
; writable user stack (the .text segment is read-only R+X).
report_rc:
    push    rax                    ; preserve rc across the prefix write
    lea     rdi, [rel rc_prefix]
    mov     rsi, rc_prefix_len
    mov     rax, SYS_WRITE
    int     0x80
    pop     rax

    sub     rsp, 16
    cmp     rax, -1
    jne     .ok
    mov     byte [rsp], '-'
    mov     byte [rsp + 1], '1'
    jmp     .emit
.ok:
    mov     byte [rsp], 'o'
    mov     byte [rsp + 1], 'k'
.emit:
    mov     byte [rsp + 2], 0x0A
    mov     rdi, rsp
    mov     rsi, 3
    mov     rax, SYS_WRITE
    int     0x80
    add     rsp, 16
    ret

banner:        db  "[user] badptr: probing rejected pointers", 0x0A
banner_len     equ $ - banner
rc_prefix:     db  "  rc="
rc_prefix_len  equ $ - rc_prefix
survived:      db  "[user] badptr survived — kernel refused bad pointers", 0x0A
survived_len   equ $ - survived
