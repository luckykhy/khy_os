; stdiotest.asm — KHY OS Ring 3 program exercising the Phase 7 standard streams.
; Every process starts with fd 0/1/2 pre-opened on the console, so a program can
; write to stdout (fd 1) and stderr (fd 2) with the ordinary fd-based write
; syscall instead of the special fd-less console write. A toy kernel has no stdio
; convention; a real one gives every process the three standard streams.
;
; NOTE: this program intentionally does NOT read stdin. Since Phase 10 fd 0 is a
; live, blocking console source (a read parks the task until a keystroke arrives),
; so the original Phase-7 "stdin returns EOF" assertion is obsolete. Live stdin
; is exercised by readtest.elf (Phase 10) and siginttest.elf (Phase 11) instead.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.

bits 64

%define SYS_EXIT        2
%define SYS_WRITE_FILE  18  ; fd-based write — here targeting the console fds

%macro WRITEFD 3        ; %1 = fd, %2 = buffer label, %3 = length
    mov     rdi, %1
    lea     rsi, [rel %2]
    mov     rdx, %3
    mov     rax, SYS_WRITE_FILE
    int     0x80
%endmacro

section .text
global _start

_start:
    WRITEFD 1, out_line, out_line_len   ; stdout
    WRITEFD 2, err_line, err_line_len   ; stderr

    WRITEFD 1, ok_line, ok_line_len
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

section .rodata
out_line:   db "[user] stdiotest: hello via stdout (fd 1)", 0x0A
out_line_len equ $ - out_line
err_line:   db "[user] stdiotest: hello via stderr (fd 2)", 0x0A
err_line_len equ $ - err_line
ok_line:    db "[user] stdiotest: three standard streams present -> stdio OK", 0x0A
ok_line_len equ $ - ok_line
