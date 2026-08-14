; pipesrc.asm — KHY OS pipeline producer (Phase 9). Writes a fixed payload to
; stdout (fd 1) with the fd-based write, then exits. Standalone it prints to the
; console; under `run /bin/pipesrc.elf | /bin/pipedst.elf` the shell has
; redirected fd 1 onto a kernel pipe, so the payload streams to the consumer.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.

bits 64

%define SYS_EXIT        2
%define SYS_WRITE_FILE  18      ; fd-based write — fd 1 here, possibly a pipe

section .text
global _start

_start:
    mov     rdi, 1              ; fd 1 = stdout (redirected to the pipe write end)
    lea     rsi, [rel msg]
    mov     rdx, msg_len
    mov     rax, SYS_WRITE_FILE
    int     0x80

    xor     rdi, rdi            ; exit 0
    mov     rax, SYS_EXIT
    int     0x80

section .rodata
msg:     db "khy-pipeline-payload", 0x0A
msg_len  equ $ - msg
