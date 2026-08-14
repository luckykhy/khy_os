; pipetest.asm — KHY OS Ring 3 program exercising the Phase 5 pipe() syscall:
; an inter-process byte stream. The process creates a pipe, fork()s, the parent
; writes a known message into the write end and closes it, and the child reads
; the read end until EOF and verifies the bytes arrived intact. A toy kernel has
; no way for two processes to stream bytes to each other; a real one does.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax. The
; int 0x80 stub preserves every GP register except rax, so r12-r15/rbx survive.
; fd tables are now per-process and inherited across fork (Unix semantics), so
; the pipe gains a second reader/writer at fork; each side must close the end it
; does not use, and only when BOTH writers are closed does the reader see EOF.
; This also proves fd isolation: the child closing its write end does not disturb
; the parent's own write end.

bits 64

%define SYS_WRITE       1   ; console write (fd-less)
%define SYS_EXIT        2
%define SYS_CLOSE       7
%define SYS_READ        6
%define SYS_WRITE_FILE  18  ; fd-based write (used here for the pipe write end)
%define SYS_FORK        19
%define SYS_WAIT        21
%define SYS_PIPE        26

%macro PRINT 2          ; %1 = label, %2 = length
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_WRITE
    int     0x80
%endmacro

section .text
global _start

_start:
    PRINT banner, banner_len

    sub     rsp, 16                 ; int fds[2] on the stack
    mov     rdi, rsp
    mov     rax, SYS_PIPE
    int     0x80
    test    rax, rax
    jnz     .setup_fail             ; non-zero return = pipe() failed
    mov     r12d, [rsp]             ; r12 = read end
    mov     r13d, [rsp + 4]         ; r13 = write end
    add     rsp, 16

    mov     rax, SYS_FORK
    int     0x80
    test    rax, rax
    jz      .child

    ; ── parent: drop the unused read end, send the message, signal EOF, reap ──
    mov     rdi, r12                ; parent closes its read end (unused)
    mov     rax, SYS_CLOSE
    int     0x80

    mov     rdi, r13
    lea     rsi, [rel msg]
    mov     rdx, msg_len
    mov     rax, SYS_WRITE_FILE
    int     0x80

    mov     rdi, r13                ; closing the last writer signals EOF
    mov     rax, SYS_CLOSE
    int     0x80

    sub     rsp, 16
    mov     rdi, rsp
    mov     rax, SYS_WAIT
    int     0x80
    add     rsp, 16

    xor     rdi, rdi                ; child printed the verdict; parent exits 0
    mov     rax, SYS_EXIT
    int     0x80

    ; ── child: drop the unused write end, drain read end to EOF, verify ──
.child:
    mov     rdi, r13                ; child closes its write end (unused)
    mov     rax, SYS_CLOSE
    int     0x80
    xor     r14, r14                ; r14 = total bytes read
.read_loop:
    lea     rsi, [rel rbuf]
    add     rsi, r14
    mov     rdx, rbuf_cap
    sub     rdx, r14                ; remaining buffer room
    jz      .read_done             ; buffer full — stop reading
    mov     rdi, r12
    mov     rax, SYS_READ
    int     0x80
    test    rax, rax
    jz      .read_done             ; 0 = EOF
    js      .fail                  ; negative = error
    add     r14, rax
    jmp     .read_loop
.read_done:
    cmp     r14, msg_len            ; got exactly the bytes we sent?
    jne     .fail
    xor     rcx, rcx                ; byte-for-byte compare against msg
.cmp_loop:
    cmp     rcx, msg_len
    jae     .ok
    lea     rsi, [rel rbuf]
    mov     al, [rsi + rcx]
    lea     rdi, [rel msg]
    cmp     al, [rdi + rcx]
    jne     .fail
    inc     rcx
    jmp     .cmp_loop
.ok:
    PRINT pipe_ok, pipe_ok_len
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80
.fail:
    PRINT pipe_bad, pipe_bad_len
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80

.setup_fail:
    add     rsp, 16
    PRINT pipe_bad, pipe_bad_len
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80

section .bss
rbuf:       resb 64
rbuf_cap    equ 64

section .rodata
banner:     db "[user] pipetest: pipe() byte stream across fork", 0x0A
banner_len  equ $ - banner
msg:        db "pipe-stream-intact!"
msg_len     equ $ - msg
pipe_ok:    db "[user] pipetest: pipe OK (bytes arrived intact)", 0x0A
pipe_ok_len equ $ - pipe_ok
pipe_bad:   db "[user] pipetest: pipe FAIL", 0x0A
pipe_bad_len equ $ - pipe_bad
