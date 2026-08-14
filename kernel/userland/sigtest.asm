; sigtest.asm — KHY OS Ring 3 program proving real signal handlers (Phase 8).
; Registers a Ring 3 handler for a catchable signal, sends that signal to
; itself, and confirms the kernel (a) ran the handler in Ring 3 and (b) resumed
; the interrupted program exactly where it left off — registers intact and the
; kill() return value visible. A toy kernel's "kill" can only terminate a
; process; a real one can deliver a signal to a handler and return.
;
; Mechanism: sigaction(sig, handler, restorer) installs both the handler and a
; libc-style restorer trampoline. On delivery the kernel saves the interrupted
; context on the user stack, enters handler(sig), and the handler's `ret` lands
; on the restorer, which issues sigreturn to restore the saved context.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
%define SYS_GETPID      3
%define SYS_KILL        24
%define SYS_SIGACTION   27
%define SYS_SIGRETURN   28

%define MYSIG           5      ; an ordinary catchable signal (not SIGKILL = 9)

%macro WRITE 2                  ; %1 = buffer label, %2 = length
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_WRITE
    int     0x80
%endmacro

section .text
global _start

_start:
    ; sigaction(MYSIG, handler, restorer)
    mov     rdi, MYSIG
    lea     rsi, [rel handler]
    lea     rdx, [rel restorer]
    mov     rax, SYS_SIGACTION
    int     0x80
    test    rax, rax
    jnz     .fail

    ; pid = getpid()
    mov     rax, SYS_GETPID
    int     0x80
    mov     rbx, rax            ; stash pid in a callee-saved reg — it MUST survive
                                ; the handler, which proves the context was restored

    ; kill(pid, MYSIG) — the kernel marks it pending and delivers it on THIS
    ; syscall's return, so control diverts into `handler` before the next insn.
    mov     rdi, rbx
    mov     rsi, MYSIG
    mov     rax, SYS_KILL
    int     0x80
    ; Execution resumes HERE after handler + sigreturn; rax = kill's return (0).
    test    rax, rax
    jnz     .fail

    ; The handler must have run and set [handled] = 1.
    mov     rax, [rel handled]
    cmp     rax, 1
    jne     .fail

    ; rbx (pid) must be intact across the handler — the heart of the proof.
    test    rbx, rbx
    jz      .fail

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
    mov     qword [rel handled], 1
    WRITE   sig_line, sig_line_len
    ret                         ; returns onto the restorer trampoline

; restorer — the kernel parked this as the handler's return address. It issues
; sigreturn, which restores the interrupted context (so this never returns).
restorer:
    mov     rax, SYS_SIGRETURN
    int     0x80

section .rodata
sig_line:    db "[user] sigtest: handler ran in Ring 3", 0x0A
sig_line_len equ $ - sig_line
ok_line:     db "[user] sigtest: signal delivered + context resumed -> signal OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] sigtest: signal FAIL", 0x0A
bad_line_len equ $ - bad_line

section .bss
handled:     resq 1
