; readtest.asm — KHY OS real-stdin test (Phase 10). Proves fd 0 is a live input
; source rather than an immediate EOF: it prints a prompt, blocks on read(0)
; until the user (or the serial console) supplies bytes, then echoes the count
; and the captured text back to the console. Standalone the shell parks in its
; foreground reap-wait while this runs, so this program owns the console input
; ring; the read blocks cooperatively (kernel-side yield) until a key arrives.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.

bits 64

%define SYS_WRITE       1       ; fd-less console write (rdi=buf, rsi=len)
%define SYS_EXIT        2
%define SYS_READ        6       ; rdi=fd, rsi=buf, rdx=len

section .text
global _start

_start:
    ; prompt
    lea     rdi, [rel prompt]
    mov     rsi, prompt_len
    mov     rax, SYS_WRITE
    int     0x80

    ; n = read(0, rbuf, 64) — blocks until at least one byte arrives
    mov     rdi, 0
    lea     rsi, [rel rbuf]
    mov     rdx, 64
    mov     rax, SYS_READ
    int     0x80
    test    rax, rax
    jle     .fail               ; <=0 means EOF or error: stdin not wired
    mov     r12, rax            ; r12 = byte count (survives int 0x80)

    ; banner: "[user] readtest: stdin delivered live input -> "
    lea     rdi, [rel got_line]
    mov     rsi, got_line_len
    mov     rax, SYS_WRITE
    int     0x80

    ; echo the captured bytes back so the round-trip is visible
    lea     rdi, [rel rbuf]
    mov     rsi, r12
    mov     rax, SYS_WRITE
    int     0x80

    ; trailing newline
    lea     rdi, [rel nl]
    mov     rsi, 1
    mov     rax, SYS_WRITE
    int     0x80

    xor     rdi, rdi            ; exit 0
    mov     rax, SYS_EXIT
    int     0x80

.fail:
    lea     rdi, [rel bad_line]
    mov     rsi, bad_line_len
    mov     rax, SYS_WRITE
    int     0x80
    mov     rdi, 1              ; exit 1
    mov     rax, SYS_EXIT
    int     0x80

section .rodata
prompt:      db "[user] readtest: type a line then press Enter: ", 0x0A
prompt_len   equ $ - prompt
got_line:    db "[user] readtest: stdin delivered live input -> "
got_line_len equ $ - got_line
bad_line:    db "[user] readtest: stdin returned EOF -> FAIL", 0x0A
bad_line_len equ $ - bad_line
nl:          db 0x0A

section .bss
rbuf:        resb 64
