; siginttest.asm — KHY OS Ctrl-C / SIGINT test (Phase 11). Proves the console
; line discipline turns a Ctrl-C (byte 0x03) typed at stdin into a real SIGINT
; delivered to the foreground program — a defining tty behaviour a toy kernel
; lacks. The program installs a Ring 3 SIGINT handler, then blocks on read(0);
; when the user (or the serial console) sends Ctrl-C, the kernel raises SIGINT,
; the handler runs, and execution resumes after the interrupted read.
;
; Mechanism reuses Phase 8 signals: sigaction(SIGINT, handler, restorer); on
; delivery the kernel stages the interrupted context on the user stack, enters
; handler(signum), whose `ret` lands on the restorer which issues sigreturn.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
%define SYS_READ        6
%define SYS_SIGACTION   27
%define SYS_SIGRETURN   28

%define SIGINT          2      ; must match PROCESS_SIGINT in src/process.h

%macro WRITE 2                  ; %1 = buffer label, %2 = length
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_WRITE
    int     0x80
%endmacro

section .text
global _start

_start:
    ; sigaction(SIGINT, handler, restorer)
    mov     rdi, SIGINT
    lea     rsi, [rel handler]
    lea     rdx, [rel restorer]
    mov     rax, SYS_SIGACTION
    int     0x80
    test    rax, rax
    jnz     .fail

    WRITE   prompt, prompt_len

    ; read(0, rbuf, 64) — blocks until input arrives. A Ctrl-C at the console
    ; raises SIGINT instead of returning data; the handler runs on the syscall's
    ; return and control resumes on the next instruction.
    mov     rdi, 0
    lea     rsi, [rel rbuf]
    mov     rdx, 64
    mov     rax, SYS_READ
    int     0x80
    ; Execution resumes HERE after the handler + sigreturn.

    ; The handler must have run and set [caught] = 1.
    mov     rax, [rel caught]
    cmp     rax, 1
    jne     .fail

    WRITE   ok_line, ok_line_len
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

.fail:
    WRITE   bad_line, bad_line_len
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80

; void handler(int signum) — runs in Ring 3 on the kernel-staged signal frame.
handler:
    mov     qword [rel caught], 1
    WRITE   sig_line, sig_line_len
    ret                         ; returns onto the restorer trampoline

; restorer — kernel parked this as the handler's return address; sigreturn
; restores the interrupted context, so this never returns.
restorer:
    mov     rax, SYS_SIGRETURN
    int     0x80

section .rodata
prompt:      db "[user] siginttest: blocking on stdin — send Ctrl-C", 0x0A
prompt_len   equ $ - prompt
sig_line:    db "[user] siginttest: SIGINT handler ran in Ring 3", 0x0A
sig_line_len equ $ - sig_line
ok_line:     db "[user] siginttest: Ctrl-C -> SIGINT delivered + resumed -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] siginttest: SIGINT FAIL", 0x0A
bad_line_len equ $ - bad_line

section .bss
caught:      resq 1
rbuf:        resb 64
