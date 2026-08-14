; spintest.asm — KHY OS IRQ-driven Ctrl-C test (Phase 12). Proves a Ctrl-C
; interrupts a program that is burning CPU in a tight loop and NEVER enters the
; kernel (no syscall) — the case a read-blocked program cannot exercise. With no
; syscall to ride back on, SIGINT must be delivered on the *keyboard IRQ* return
; path: the timer/keyboard interrupt fires while this Ring 3 loop spins, the
; kernel raises the pending SIGINT, and on iretq back to user mode it redirects
; execution into the handler instead of resuming the loop.
;
; The hot loop below contains ONLY register/memory ops and a backward branch —
; deliberately no `int 0x80`. If Ctrl-C only worked at syscall boundaries (the
; Phase 11 limit), this program would spin forever and the test would hang.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
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

    ; Pure CPU spin. No syscall in this loop — the ONLY way out is for the kernel
    ; to deliver SIGINT on an interrupt return and run `handler`, which sets
    ; [done]. Until then this reads a user-memory flag and branches, nothing more.
.spin:
    mov     rax, [rel done]
    test    rax, rax
    jz      .spin

    ; Reached only after the handler ran mid-spin and set [done] = 1.
    WRITE   ok_line, ok_line_len
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

.fail:
    WRITE   bad_line, bad_line_len
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80

; void handler(int signum) — runs in Ring 3 on the kernel-staged signal frame
; that the IRQ return path built. Records that the spin was broken, then returns
; onto the restorer so execution resumes at the interrupted spin instruction —
; which now sees [done] != 0 and falls through to the success path.
handler:
    mov     qword [rel done], 1
    WRITE   sig_line, sig_line_len
    ret                         ; returns onto the restorer trampoline

; restorer — kernel parked this as the handler's return address; sigreturn
; restores the interrupted context, so this never returns.
restorer:
    mov     rax, SYS_SIGRETURN
    int     0x80

section .rodata
prompt:      db "[user] spintest: spinning on CPU (no syscall) — send Ctrl-C", 0x0A
prompt_len   equ $ - prompt
sig_line:    db "[user] spintest: SIGINT delivered on IRQ return — loop broken", 0x0A
sig_line_len equ $ - sig_line
ok_line:     db "[user] spintest: Ctrl-C interrupted a pure CPU loop -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] spintest: SIGINT FAIL", 0x0A
bad_line_len equ $ - bad_line

section .bss
done:        resq 1
