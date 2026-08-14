; rmtest.asm — KHY OS filesystem-mutation test (Phase 16). Proves a Ring 3
; program has symmetric create/delete for both files and directories: mkdir,
; rmdir (empty-only, POSIX), and unlink. A toy kernel lets programs create files
; (open O_CREAT) but never delete anything; a real OS exposes the full lifecycle.
;
; Sequence (all driven from Ring 3 via int 0x80; paths are relative to the cwd):
;   1.  getcwd()                 -> "/"      (launched at root)
;   2.  chdir("/tmp")            -> 0
;   3.  mkdir("rd")              -> 0        (creates /tmp/rd)
;   4.  chdir("rd")              -> 0        (proves /tmp/rd exists & is a dir)
;   5.  chdir("..")              -> 0        (back to /tmp)
;   6.  rmdir("rd")              -> 0        (empty -> removed)
;   7.  chdir("rd")              -> -1       (gone)
;   8.  open("f.txt",O_CREAT)    -> fd>=0 ; close   (creates /tmp/f.txt)
;   9.  unlink("f.txt")          -> 0
;   10. open("f.txt",rd)         -> -1       (gone)
;   11. mkdir("d2")              -> 0
;   12. open("d2/inner.txt",..)  -> fd>=0 ; close   (nested relative create)
;   13. rmdir("d2")              -> -1       (NON-EMPTY: POSIX refuses)
;   14. unlink("d2/inner.txt")   -> 0
;   15. rmdir("d2")              -> 0        (now empty)
; Any deviation jumps to .fail (exit 1). Success prints OK and exits 0.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
%define SYS_OPEN        5
%define SYS_CLOSE       7
%define SYS_CHDIR       36
%define SYS_GETCWD      37
%define SYS_MKDIR       38
%define SYS_RMDIR       39
%define SYS_UNLINK      40

%define O_CREAT         1

%macro WRITE 2
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_WRITE
    int     0x80
%endmacro

; Invoke a one-path syscall and require the result == 0.
%macro CALL1_ZERO 2
    lea     rdi, [rel %2]
    mov     rax, %1
    int     0x80
    test    rax, rax
    jnz     .fail
%endmacro

; Invoke a one-path syscall and require the result < 0 (must be rejected).
%macro CALL1_NEG 2
    lea     rdi, [rel %2]
    mov     rax, %1
    int     0x80
    test    rax, rax
    jns     .fail
%endmacro

section .text
global _start

_start:
    ; 1. getcwd() must be "/".
    lea     rdi, [rel cwdbuf]
    mov     rsi, 64
    mov     rax, SYS_GETCWD
    int     0x80
    cmp     rax, 1
    jne     .fail
    cmp     byte [rel cwdbuf], '/'
    jne     .fail

    CALL1_ZERO SYS_CHDIR, tmppath      ; 2. chdir /tmp
    CALL1_ZERO SYS_MKDIR, rdname       ; 3. mkdir rd
    CALL1_ZERO SYS_CHDIR, rdname       ; 4. chdir rd
    CALL1_ZERO SYS_CHDIR, dotdot       ; 5. chdir ..
    CALL1_ZERO SYS_RMDIR, rdname       ; 6. rmdir rd
    CALL1_NEG  SYS_CHDIR, rdname       ; 7. chdir rd -> gone

    ; 8. create /tmp/f.txt, keep fd in rbx, then close.
    lea     rdi, [rel fname]
    mov     rsi, O_CREAT
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    js      .fail
    mov     rbx, rax
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80

    CALL1_ZERO SYS_UNLINK, fname       ; 9. unlink f.txt

    ; 10. opening the unlinked file for read must fail.
    lea     rdi, [rel fname]
    xor     rsi, rsi
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    jns     .fail

    CALL1_ZERO SYS_MKDIR, d2name       ; 11. mkdir d2

    ; 12. create a file inside d2 via a nested relative path; close.
    lea     rdi, [rel d2inner]
    mov     rsi, O_CREAT
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    js      .fail
    mov     rbx, rax
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80

    CALL1_NEG  SYS_RMDIR, d2name       ; 13. rmdir d2 -> non-empty, refused
    CALL1_ZERO SYS_UNLINK, d2inner     ; 14. unlink d2/inner.txt
    CALL1_ZERO SYS_RMDIR, d2name       ; 15. rmdir d2 -> now empty

    WRITE   ok_line, ok_line_len
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

.fail:
    WRITE   bad_line, bad_line_len
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80

section .rodata
tmppath:     db "/tmp", 0
rdname:      db "rd", 0
dotdot:      db "..", 0
fname:       db "f.txt", 0
d2name:      db "d2", 0
d2inner:     db "d2/inner.txt", 0
ok_line:     db "[user] rmtest: mkdir/rmdir/unlink lifecycle -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] rmtest: RM FAIL", 0x0A
bad_line_len equ $ - bad_line

section .bss
cwdbuf:      resb 64
