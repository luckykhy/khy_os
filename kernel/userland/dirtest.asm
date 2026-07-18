; dirtest.asm — KHY OS directory-enumeration test (Phase 21). Proves a Ring 3
; program can DISCOVER what a directory contains via getdents, not just stat a
; path it already knows. Until now `ls` only worked because the shell is a kernel
; task calling vfs_list_dir directly; a userland program had no way to list a
; directory. getdents is the primitive a userland `ls` is built on.
;
; All work happens under /tmp (created by ramfs_init, so no -hda is needed). The
; caller is root (uid 0).
;
; Sequence (all from Ring 3 via int 0x80):
;   1.  chdir /tmp ; mkdir denttest ; chdir denttest   (a fresh, isolated dir)
;   2.  create f1.txt and write 10 bytes ; mkdir sub ; symlink f1.txt -> lnk
;   3.  getdents "." -> exactly 3 entries; scan by name (order-independent) and
;       assert: f1.txt is FILE(1) size 10, sub is DIR(2), lnk is SYMLINK(3).
;       All three names must be present and no unexpected name may appear.
;   4.  getdents "sub" (empty dir) -> 0 entries
;   5.  getdents "f1.txt" (a file, not a dir) -> -1
;   6.  cleanup: unlink lnk, unlink f1.txt, rmdir sub, chdir .., rmdir denttest
; Any deviation jumps to .fail (exit 1). Success prints OK and exits 0.
;
; struct khy_dirent layout (src/syscall.h, 64 bytes): d_size@0 (qword),
; d_type@8 (byte), pad@9..15, d_name@16 (48-byte NUL-terminated name).
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.
; The int 0x80 stub preserves every GP register except rax.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
%define SYS_OPEN        5
%define SYS_CLOSE       7
%define SYS_WRITE_FILE  18
%define SYS_MKDIR       38
%define SYS_RMDIR       39
%define SYS_UNLINK      40
%define SYS_CHDIR       36
%define SYS_SYMLINK     41
%define SYS_GETDENTS    48

%define O_CREAT         1

; struct khy_dirent field offsets and stride
%define DE_SIZE         0
%define DE_TYPE         8
%define DE_NAME         16
%define DE_STRIDE       64

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
    sub     rsp, 512                   ; room for 8 khy_dirent (8 * 64)
    mov     r15, rsp                   ; r15 -> dirent buffer (callee-saved)

    ; 1. chdir /tmp ; mkdir denttest ; chdir denttest
    lea     rdi, [rel tmpdir]
    mov     rax, SYS_CHDIR
    int     0x80
    test    rax, rax
    jnz     .fail
    lea     rdi, [rel ddir]
    mov     rax, SYS_MKDIR
    int     0x80
    test    rax, rax
    jnz     .fail
    lea     rdi, [rel ddir]
    mov     rax, SYS_CHDIR
    int     0x80
    test    rax, rax
    jnz     .fail

    ; 2. create f1.txt (10 bytes), mkdir sub, symlink f1.txt -> lnk
    lea     rdi, [rel n_f1]
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
    lea     rdi, [rel n_sub]
    mov     rax, SYS_MKDIR
    int     0x80
    test    rax, rax
    jnz     .fail
    lea     rdi, [rel n_f1]            ; symlink target (verbatim)
    lea     rsi, [rel n_lnk]          ; link path
    mov     rax, SYS_SYMLINK
    int     0x80
    test    rax, rax
    jnz     .fail

    ; 3. getdents "." -> 3 entries
    lea     rdi, [rel dot]
    mov     rsi, r15
    mov     rdx, 8                     ; max_entries
    mov     rax, SYS_GETDENTS
    int     0x80
    cmp     rax, 3
    jne     .fail
    mov     r13, rax                   ; count
    xor     rbx, rbx                   ; i
    xor     r12, r12                   ; found bitmask
.scan:
    cmp     rbx, r13
    jge     .scan_done
    mov     rax, rbx
    shl     rax, 6                     ; * DE_STRIDE (64)
    lea     r14, [r15 + rax]           ; entry ptr
    ; compare name (r14+DE_NAME) against the three expected names
    lea     rsi, [r14 + DE_NAME]
    lea     rdi, [rel n_f1]
    call    streq
    je      .is_f1
    lea     rsi, [r14 + DE_NAME]
    lea     rdi, [rel n_sub]
    call    streq
    je      .is_sub
    lea     rsi, [r14 + DE_NAME]
    lea     rdi, [rel n_lnk]
    call    streq
    je      .is_lnk
    jmp     .fail                      ; unexpected entry name
.is_f1:
    cmp     byte [r14 + DE_TYPE], T_FILE
    jne     .fail
    cmp     qword [r14 + DE_SIZE], 10
    jne     .fail
    or      r12, 1
    jmp     .scan_next
.is_sub:
    cmp     byte [r14 + DE_TYPE], T_DIR
    jne     .fail
    or      r12, 2
    jmp     .scan_next
.is_lnk:
    cmp     byte [r14 + DE_TYPE], T_SYMLINK
    jne     .fail
    or      r12, 4
    jmp     .scan_next
.scan_next:
    inc     rbx
    jmp     .scan
.scan_done:
    cmp     r12, 7                     ; all three names seen exactly once
    jne     .fail

    ; 4. getdents "sub" (empty) -> 0
    lea     rdi, [rel n_sub]
    mov     rsi, r15
    mov     rdx, 8
    mov     rax, SYS_GETDENTS
    int     0x80
    test    rax, rax
    jnz     .fail

    ; 5. getdents "f1.txt" (not a directory) -> -1 (negative)
    lea     rdi, [rel n_f1]
    mov     rsi, r15
    mov     rdx, 8
    mov     rax, SYS_GETDENTS
    int     0x80
    test    rax, rax
    jns     .fail                      ; must be negative (error)

    ; 6. cleanup
    lea     rdi, [rel n_lnk]
    mov     rax, SYS_UNLINK
    int     0x80
    lea     rdi, [rel n_f1]
    mov     rax, SYS_UNLINK
    int     0x80
    lea     rdi, [rel n_sub]
    mov     rax, SYS_RMDIR
    int     0x80
    lea     rdi, [rel dotdot]
    mov     rax, SYS_CHDIR
    int     0x80
    lea     rdi, [rel ddir]
    mov     rax, SYS_RMDIR
    int     0x80

    WRITE   ok_line, ok_line_len
    add     rsp, 512
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

.fail:
    WRITE   bad_line, bad_line_len
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80

; streq(rsi, rdi) — compare two NUL-terminated strings. Sets ZF iff equal.
; Clobbers rax, rcx; preserves rsi/rdi (caller reloads them anyway).
streq:
    push    rsi
    push    rdi
.se_loop:
    mov     al, [rsi]
    mov     cl, [rdi]
    cmp     al, cl
    jne     .se_ne
    test    al, al
    je      .se_eq
    inc     rsi
    inc     rdi
    jmp     .se_loop
.se_eq:
    pop     rdi
    pop     rsi
    xor     eax, eax                   ; ZF = 1 (equal)
    ret
.se_ne:
    pop     rdi
    pop     rsi
    or      eax, 1                     ; ZF = 0 (not equal)
    ret

section .rodata
tmpdir:      db "/tmp", 0
ddir:        db "denttest", 0
dot:         db ".", 0
dotdot:      db "..", 0
n_f1:        db "f1.txt", 0
n_sub:       db "sub", 0
n_lnk:       db "lnk", 0
content:     db "dirent-pro"
content_len  equ $ - content
ok_line:     db "[user] dirtest: getdents enumerates directory -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] dirtest: DIRENT FAIL", 0x0A
bad_line_len equ $ - bad_line
