; lseektest.asm — KHY OS file-offset positioning test (Phase 22). Proves a Ring 3
; program can reposition an open file's cursor with lseek, so file access is
; random rather than strictly sequential. Until now read/write only ever advanced
; the cursor forward; a program could not rewind to re-read, skip ahead, or seek
; relative to end-of-file.
;
; All work happens under /tmp (created by ramfs_init, so no -hda is needed).
;
; The probe file holds the 10 bytes "0123456789" (byte i is the digit i).
; Sequence (all from Ring 3 via int 0x80):
;   1.  chdir /tmp ; create seek.txt, write "0123456789", close
;   2.  open seek.txt for reading
;   3.  lseek(0, SEEK_END)            -> 10            (size of the file)
;   4.  lseek(3, SEEK_SET) ; read 2   -> 3, then "34"  (absolute)
;   5.  lseek(2, SEEK_CUR) ; read 1   -> 7, then "7"    (relative; cursor was 5)
;   6.  lseek(-1, SEEK_END) ; read 1  -> 9, then "9"    (relative to size)
;   7.  lseek(-100, SEEK_SET)         -> -1             (before start: rejected)
;   8.  close ; remove seek.txt
; Any deviation jumps to .fail (exit 1). Success prints OK and exits 0.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.
; lseek: rdi = fd, rsi = offset (signed), rdx = whence. The int 0x80 stub
; preserves every GP register except rax.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
%define SYS_OPEN        5
%define SYS_READ        6
%define SYS_CLOSE       7
%define SYS_WRITE_FILE  18
%define SYS_CHDIR       36
%define SYS_UNLINK      40
%define SYS_LSEEK       49

%define O_CREAT         1
%define SEEK_SET        0
%define SEEK_CUR        1
%define SEEK_END        2

%macro WRITE 2
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_WRITE
    int     0x80
%endmacro

section .text
global _start

_start:
    sub     rsp, 32                    ; small read scratch
    mov     r15, rsp                   ; r15 -> read buffer (callee-saved)

    ; 1. chdir /tmp ; create seek.txt with "0123456789"
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
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80

    ; 2. open seek.txt for reading (flags 0)
    lea     rdi, [rel fname]
    xor     rsi, rsi
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    js      .fail
    mov     rbx, rax                   ; fd

    ; 3. lseek(0, SEEK_END) -> 10
    mov     rdi, rbx
    xor     rsi, rsi
    mov     rdx, SEEK_END
    mov     rax, SYS_LSEEK
    int     0x80
    cmp     rax, 10
    jne     .fail

    ; 4. lseek(3, SEEK_SET) -> 3 ; read 2 -> "34"
    mov     rdi, rbx
    mov     rsi, 3
    mov     rdx, SEEK_SET
    mov     rax, SYS_LSEEK
    int     0x80
    cmp     rax, 3
    jne     .fail
    mov     rdi, rbx
    mov     rsi, r15
    mov     rdx, 2
    mov     rax, SYS_READ
    int     0x80
    cmp     rax, 2
    jne     .fail
    cmp     byte [r15], '3'
    jne     .fail
    cmp     byte [r15 + 1], '4'
    jne     .fail

    ; 5. cursor is now 5; lseek(2, SEEK_CUR) -> 7 ; read 1 -> "7"
    mov     rdi, rbx
    mov     rsi, 2
    mov     rdx, SEEK_CUR
    mov     rax, SYS_LSEEK
    int     0x80
    cmp     rax, 7
    jne     .fail
    mov     rdi, rbx
    mov     rsi, r15
    mov     rdx, 1
    mov     rax, SYS_READ
    int     0x80
    cmp     rax, 1
    jne     .fail
    cmp     byte [r15], '7'
    jne     .fail

    ; 6. lseek(-1, SEEK_END) -> 9 ; read 1 -> "9"
    mov     rdi, rbx
    mov     rsi, -1
    mov     rdx, SEEK_END
    mov     rax, SYS_LSEEK
    int     0x80
    cmp     rax, 9
    jne     .fail
    mov     rdi, rbx
    mov     rsi, r15
    mov     rdx, 1
    mov     rax, SYS_READ
    int     0x80
    cmp     rax, 1
    jne     .fail
    cmp     byte [r15], '9'
    jne     .fail

    ; 7. lseek(-100, SEEK_SET) -> -1 (cannot seek before the start)
    mov     rdi, rbx
    mov     rsi, -100
    mov     rdx, SEEK_SET
    mov     rax, SYS_LSEEK
    int     0x80
    test    rax, rax
    jns     .fail                      ; must be negative (rejected)

    ; 8. close ; remove seek.txt
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80
    lea     rdi, [rel fname]
    mov     rax, SYS_UNLINK
    int     0x80

    WRITE   ok_line, ok_line_len
    add     rsp, 32
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
fname:       db "seek.txt", 0
content:     db "0123456789"
content_len  equ $ - content
ok_line:     db "[user] lseektest: random-access lseek SET/CUR/END -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] lseektest: LSEEK FAIL", 0x0A
bad_line_len equ $ - bad_line
