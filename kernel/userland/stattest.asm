; stattest.asm — KHY OS file-metadata test (Phase 20). Proves a Ring 3 program
; can query a file's type, size, owner and permission bits without reading its
; contents, via stat / lstat / fstat. A toy kernel offers no way to learn how big
; a file is or whether a path is a file, directory or symlink; stat is the
; primitive behind `ls -l`, size-aware reads, and existence/type checks.
;
; All work happens in /tmp (created by ramfs_init, so no -hda is needed). The
; caller is root (uid 0), so created nodes keep their default modes.
;
; Sequence (all from Ring 3 via int 0x80):
;   1.  chdir /tmp
;   2.  create probe.txt and write 10 bytes into it
;   3.  stat  probe.txt -> type FILE(1), size 10, mode 0644 (420)
;   4.  mkdir sdir ; stat sdir -> type DIR(2), size 0, mode 0755 (493)
;   5.  symlink probe.txt -> plink ; lstat plink -> type SYMLINK(3), size 9
;   6.  stat plink (follows the link) -> type FILE(1), size 10
;   7.  open probe.txt ; fstat fd -> type FILE(1), size 10
;   8.  unlink plink, unlink probe.txt, rmdir sdir
; Any deviation jumps to .fail (exit 1). Success prints OK and exits 0.
;
; struct khy_stat layout (src/syscall.h, 24 bytes): st_size@0 (qword),
; st_uid@8, st_gid@12, st_mode@16 (word), st_type@18 (byte), pad@19..23.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.
; The int 0x80 stub preserves every GP register except rax.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
%define SYS_OPEN        5
%define SYS_CLOSE       7
%define SYS_WRITE_FILE  18
%define SYS_CHDIR       36
%define SYS_RMDIR       39
%define SYS_UNLINK      40
%define SYS_MKDIR       38
%define SYS_SYMLINK     41
%define SYS_STAT        45
%define SYS_LSTAT       46
%define SYS_FSTAT       47

%define O_CREAT         1

; struct khy_stat field offsets
%define ST_SIZE         0
%define ST_MODE         16
%define ST_TYPE         18

%define T_FILE          1
%define T_DIR           2
%define T_SYMLINK       3

%macro WRITE 2
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_WRITE
    int     0x80
%endmacro

section .text
global _start

_start:
    sub     rsp, 32                    ; 24-byte struct khy_stat scratch
    mov     r15, rsp                   ; r15 -> stat buffer (callee-saved)

    ; 1. chdir /tmp
    lea     rdi, [rel tmpdir]
    mov     rax, SYS_CHDIR
    int     0x80
    test    rax, rax
    jnz     .fail

    ; 2. create probe.txt, write 10 bytes, close
    lea     rdi, [rel fname]
    mov     rsi, O_CREAT
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    js      .fail
    mov     rbx, rax                   ; fd (callee-saved)
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

    ; 3. stat probe.txt -> FILE, size 10, mode 420
    lea     rdi, [rel fname]
    mov     rsi, r15
    mov     rax, SYS_STAT
    int     0x80
    test    rax, rax
    jnz     .fail
    cmp     qword [r15 + ST_SIZE], 10
    jne     .fail
    cmp     word [r15 + ST_MODE], 420
    jne     .fail
    cmp     byte [r15 + ST_TYPE], T_FILE
    jne     .fail

    ; 4. mkdir sdir ; stat -> DIR, size 0, mode 493
    lea     rdi, [rel dname]
    mov     rax, SYS_MKDIR
    int     0x80
    test    rax, rax
    jnz     .fail
    lea     rdi, [rel dname]
    mov     rsi, r15
    mov     rax, SYS_STAT
    int     0x80
    test    rax, rax
    jnz     .fail
    cmp     qword [r15 + ST_SIZE], 0
    jne     .fail
    cmp     word [r15 + ST_MODE], 493
    jne     .fail
    cmp     byte [r15 + ST_TYPE], T_DIR
    jne     .fail

    ; 5. symlink probe.txt -> plink ; lstat -> SYMLINK, size 9
    lea     rdi, [rel fname]           ; target (verbatim "probe.txt", 9 bytes)
    lea     rsi, [rel lname]           ; link path
    mov     rax, SYS_SYMLINK
    int     0x80
    test    rax, rax
    jnz     .fail
    lea     rdi, [rel lname]
    mov     rsi, r15
    mov     rax, SYS_LSTAT
    int     0x80
    test    rax, rax
    jnz     .fail
    cmp     qword [r15 + ST_SIZE], 9   ; length of "probe.txt"
    jne     .fail
    cmp     byte [r15 + ST_TYPE], T_SYMLINK
    jne     .fail

    ; 6. stat plink (follows) -> FILE, size 10
    lea     rdi, [rel lname]
    mov     rsi, r15
    mov     rax, SYS_STAT
    int     0x80
    test    rax, rax
    jnz     .fail
    cmp     qword [r15 + ST_SIZE], 10
    jne     .fail
    cmp     byte [r15 + ST_TYPE], T_FILE
    jne     .fail

    ; 7. fstat the open file -> FILE, size 10
    lea     rdi, [rel fname]
    xor     rsi, rsi
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    js      .fail
    mov     rbx, rax
    mov     rdi, rbx
    mov     rsi, r15
    mov     rax, SYS_FSTAT
    int     0x80
    test    rax, rax
    jnz     .fail
    cmp     qword [r15 + ST_SIZE], 10
    jne     .fail
    cmp     byte [r15 + ST_TYPE], T_FILE
    jne     .fail
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80

    ; 8. cleanup
    lea     rdi, [rel lname]
    mov     rax, SYS_UNLINK
    int     0x80
    lea     rdi, [rel fname]
    mov     rax, SYS_UNLINK
    int     0x80
    lea     rdi, [rel dname]
    mov     rax, SYS_RMDIR
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
fname:       db "probe.txt", 0
dname:       db "sdir", 0
lname:       db "plink", 0
content:     db "stat-probe"
content_len  equ $ - content
ok_line:     db "[user] stattest: stat/lstat/fstat metadata -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] stattest: STAT FAIL", 0x0A
bad_line_len equ $ - bad_line
