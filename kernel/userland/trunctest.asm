; trunctest.asm — KHY OS file-truncation test (Phase 23). Proves a Ring 3 program
; can resize a file to a chosen length with ftruncate (by fd) and truncate (by
; path): shrinking discards the tail, growing zero-extends. Until now a file could
; only grow (write) or vanish (unlink) — never be cut to an exact size.
;
; All work happens under /tmp (created by ramfs_init, so no -hda is needed). Sizes
; are verified through fstat/stat (Phase 20), so this also exercises that path.
;
; The probe file starts as the 10 bytes "0123456789".
; Sequence (all from Ring 3 via int 0x80):
;   1.  chdir /tmp ; create t.txt, write "0123456789", keep it open
;   2.  ftruncate(fd, 4)  -> 0 ; fstat size == 4 ; read from start -> 4 bytes "0123"
;   3.  truncate("t.txt", 7) -> 0 ; stat size == 7 ; read from start -> 7 bytes:
;       "0123" then three zero bytes (the zero-extended region)
;   4.  close ; unlink t.txt
; Any deviation jumps to .fail (exit 1). Success prints OK and exits 0.
;
; struct khy_stat layout (src/syscall.h): st_size@0 (qword).
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.
; ftruncate: rdi=fd, rsi=length. truncate: rdi=path, rsi=length. The int 0x80
; stub preserves every GP register except rax.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
%define SYS_OPEN        5
%define SYS_READ        6
%define SYS_CLOSE       7
%define SYS_WRITE_FILE  18
%define SYS_CHDIR       36
%define SYS_UNLINK      40
%define SYS_STAT        45
%define SYS_FSTAT       47
%define SYS_LSEEK       49
%define SYS_TRUNCATE    50
%define SYS_FTRUNCATE   51

%define O_CREAT         1
%define SEEK_SET        0
%define ST_SIZE         0

%macro WRITE 2
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_WRITE
    int     0x80
%endmacro

section .text
global _start

_start:
    sub     rsp, 64
    mov     r15, rsp                   ; r15 -> struct khy_stat (24B)
    lea     r14, [rsp + 32]            ; r14 -> read buffer (16B)

    ; 1. chdir /tmp ; create t.txt = "0123456789", keep open
    lea     rdi, [rel tmpdir]
    mov     rax, SYS_CHDIR
    int     0x80
    test    rax, rax
    jnz     .fail
    lea     rdi, [rel fname]
    mov     rsi, O_CREAT
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    js      .fail
    mov     rbx, rax                   ; fd
    mov     rdi, rbx
    lea     rsi, [rel content]
    mov     rdx, content_len           ; 10
    mov     rax, SYS_WRITE_FILE
    int     0x80
    cmp     rax, content_len
    jne     .fail

    ; 2. ftruncate(fd, 4) -> 0 ; fstat size == 4 ; read first 4 -> "0123"
    mov     rdi, rbx
    mov     rsi, 4
    mov     rax, SYS_FTRUNCATE
    int     0x80
    test    rax, rax
    jnz     .fail
    mov     rdi, rbx
    mov     rsi, r15
    mov     rax, SYS_FSTAT
    int     0x80
    test    rax, rax
    jnz     .fail
    cmp     qword [r15 + ST_SIZE], 4
    jne     .fail
    ; rewind and read the whole (now 4-byte) file
    mov     rdi, rbx
    xor     rsi, rsi
    mov     rdx, SEEK_SET
    mov     rax, SYS_LSEEK
    int     0x80
    test    rax, rax
    jnz     .fail
    mov     rdi, rbx
    mov     rsi, r14
    mov     rdx, 16
    mov     rax, SYS_READ
    int     0x80
    cmp     rax, 4
    jne     .fail
    cmp     byte [r14 + 0], '0'
    jne     .fail
    cmp     byte [r14 + 3], '3'
    jne     .fail

    ; 3. truncate("t.txt", 7) -> 0 ; stat size == 7 ; read -> "0123" + 3 zeros
    lea     rdi, [rel fname]
    mov     rsi, 7
    mov     rax, SYS_TRUNCATE
    int     0x80
    test    rax, rax
    jnz     .fail
    lea     rdi, [rel fname]
    mov     rsi, r15
    mov     rax, SYS_STAT
    int     0x80
    test    rax, rax
    jnz     .fail
    cmp     qword [r15 + ST_SIZE], 7
    jne     .fail
    mov     rdi, rbx
    xor     rsi, rsi
    mov     rdx, SEEK_SET
    mov     rax, SYS_LSEEK
    int     0x80
    test    rax, rax
    jnz     .fail
    mov     rdi, rbx
    mov     rsi, r14
    mov     rdx, 16
    mov     rax, SYS_READ
    int     0x80
    cmp     rax, 7
    jne     .fail
    cmp     byte [r14 + 0], '0'
    jne     .fail
    cmp     byte [r14 + 3], '3'
    jne     .fail
    cmp     byte [r14 + 4], 0          ; zero-extended region
    jne     .fail
    cmp     byte [r14 + 6], 0
    jne     .fail

    ; 4. close ; unlink t.txt
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80
    lea     rdi, [rel fname]
    mov     rax, SYS_UNLINK
    int     0x80

    WRITE   ok_line, ok_line_len
    add     rsp, 64
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

.fail:
    WRITE   bad_line, bad_line_len
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80

section .rodata
tmpdir:      db "/tmp", 0
fname:       db "t.txt", 0
content:     db "0123456789"
content_len  equ $ - content
ok_line:     db "[user] trunctest: ftruncate shrink + truncate grow -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] trunctest: TRUNC FAIL", 0x0A
bad_line_len equ $ - bad_line
