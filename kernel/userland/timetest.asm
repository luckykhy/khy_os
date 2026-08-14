; timetest.asm — KHY OS wall-clock test (Phase 27). Proves a Ring 3 program can
; read real calendar time via SYSCALL_TIME (55), not just boot uptime ticks:
;   1. t1 = time() ; assert t1 is a plausible Unix epoch (>= Nov 2023, < 2100)
;   2. t2 = time() ; assert t2 >= t1 (wall clock never runs backwards)
; A garbage clock (zero, or wildly out of range) or a non-monotonic second read
; jumps to fail (exit 1). Success prints OK and exits 0.
;
; Syscall ABI (src/syscall.c): rax = number, ret in rax. The int 0x80 stub
; preserves every GP register except rax, so t1 survives in rbx across the
; second call.

bits 64

%define SYS_WRITE  1
%define SYS_EXIT   2
%define SYS_TIME   55

; Plausible-range bounds for the epoch (seconds since 1970-01-01 UTC).
%define EPOCH_LO   1700000000      ; 2023-11-14, safely before any run
%define EPOCH_HI   4102444800      ; 2100-01-01, safely after any run

section .text
global _start

_start:
    ; 1. t1 = time()
    mov     rax, SYS_TIME
    int     0x80
    mov     rbx, rax                   ; rbx = t1 (preserved across int 0x80)

    mov     rcx, EPOCH_LO
    cmp     rbx, rcx
    jb      fail                       ; before 2023 -> clock not set / garbage
    mov     rcx, EPOCH_HI
    cmp     rbx, rcx
    jae     fail                       ; after 2100 -> garbage

    ; 2. t2 = time() ; must not run backwards
    mov     rax, SYS_TIME
    int     0x80                       ; rax = t2 ; rbx still holds t1
    cmp     rax, rbx
    jb      fail

    lea     rdi, [rel ok_line]
    mov     rsi, ok_line_len
    mov     rax, SYS_WRITE
    int     0x80
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

fail:
    lea     rdi, [rel bad_line]
    mov     rsi, bad_line_len
    mov     rax, SYS_WRITE
    int     0x80
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80

section .rodata
ok_line:     db "[user] timetest: wall clock epoch + monotonic -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] timetest: TIME FAIL", 0x0A
bad_line_len equ $ - bad_line
