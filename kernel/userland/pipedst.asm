; pipedst.asm — KHY OS pipeline consumer (Phase 9). Drains stdin (fd 0) until
; EOF, echoing each chunk to the console and counting the bytes received, then
; reports whether the expected payload arrived. Under
; `run /bin/pipesrc.elf | /bin/pipedst.elf` the shell redirected fd 0 onto the
; pipe's read end, so this reads exactly what pipesrc wrote; the read blocks
; (kernel-side yield) until data arrives and returns EOF once pipesrc exits.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.

bits 64

%define SYS_WRITE       1       ; fd-less console write (rdi=buf, rsi=len)
%define SYS_EXIT        2
%define SYS_READ        6       ; rdi=fd, rsi=buf, rdx=len
%define EXPECTED        21      ; length of pipesrc's "khy-pipeline-payload\n"

section .text
global _start

_start:
    xor     r12, r12            ; r12 = total bytes read (survives int 0x80)
.read_loop:
    mov     rdi, 0              ; fd 0 = stdin (pipe read end)
    lea     rsi, [rel rbuf]
    mov     rdx, 64
    mov     rax, SYS_READ
    int     0x80
    test    rax, rax
    jz      .eof                ; 0 = EOF (writer closed, buffer drained)
    js      .fail               ; negative = read error
    mov     r13, rax            ; n = bytes read this chunk
    add     r12, r13            ; total += n

    ; echo the chunk to the console so the streamed payload is visible
    lea     rdi, [rel rbuf]
    mov     rsi, r13
    mov     rax, SYS_WRITE
    int     0x80
    jmp     .read_loop

.eof:
    cmp     r12, EXPECTED
    jne     .fail
    lea     rdi, [rel ok_line]
    mov     rsi, ok_line_len
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
ok_line:     db "[user] pipedst: received full payload via stdin -> pipeline OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] pipedst: pipeline FAIL", 0x0A
bad_line_len equ $ - bad_line

section .bss
rbuf:        resb 64
