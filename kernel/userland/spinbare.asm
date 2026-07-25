; spinbare.asm — KHY OS IRQ-driven default-terminate test (Phase 12). Like
; spintest, but installs NO signal handler. A Ctrl-C must therefore take SIGINT's
; *default* action — terminate the process — and it must do so from the keyboard
; IRQ return path (the program never makes a syscall in its loop). This exercises
; the riskiest Phase 12 code path: task_exit() invoked from inside the IRQ stub.
; Expected: the program never prints "still spinning" past the interrupt; the
; shell reports exit code 130 (128 + SIGINT) and the kernel does NOT panic.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2

%macro WRITE 2
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_WRITE
    int     0x80
%endmacro

section .text
global _start

_start:
    WRITE   prompt, prompt_len
    ; Pure CPU spin, no handler installed. The only exit is the kernel's default
    ; SIGINT action terminating us from the IRQ return path.
.spin:
    jmp     .spin

    ; Unreachable: if the loop ever falls through, fail loudly with a nonzero code
    ; distinct from 130 so the harness can tell a logic bug from a clean kill.
    WRITE   bad_line, bad_line_len
    mov     rdi, 7
    mov     rax, SYS_EXIT
    int     0x80

section .rodata
prompt:     db "[user] spinbare: spinning with NO handler — send Ctrl-C", 0x0A
prompt_len  equ $ - prompt
bad_line:   db "[user] spinbare: ERROR loop exited without signal", 0x0A
bad_line_len equ $ - bad_line
