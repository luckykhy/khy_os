; renametest.asm — KHY OS file rename/move test (Phase 24). Proves a Ring 3
; program can MOVE a name in the tree, not just create one (write) and destroy it
; (unlink). rename relinks the node in place: its bytes are untouched, only its
; leaf name / parent change. A symlink is moved as itself; a directory move is
; refused; an existing destination is never clobbered.
;
; All work happens under /tmp (created by ramfs_init, so no -hda is needed). Types
; and sizes are verified through stat/lstat (Phase 20).
;
; Sequence (all from Ring 3 via int 0x80):
;   1.  chdir /tmp
;   2.  create a.txt = "hello" (5B), close
;   3.  rename("a.txt","b.txt") -> 0 ; stat a.txt -> -1 (gone) ; stat b.txt ->
;       FILE size 5 ; open+read b.txt == "hello" (data moved intact)
;   4.  create c.txt ; rename("b.txt","c.txt") -> -1 (destination exists, no clobber)
;   5.  mkdir d1 ; rename("d1","d2") -> -1 (directory move rejected)
;   6.  symlink("c.txt" -> lnk) ; rename("lnk","lnk2") -> 0 ; lstat lnk -> -1 ;
;       lstat lnk2 -> SYMLINK ; readlink lnk2 == "c.txt"
;   7.  cleanup: unlink b.txt, c.txt, lnk2 ; rmdir d1
; Any deviation jumps to .fail (exit 1). Success prints OK and exits 0.
;
; struct khy_stat layout (src/syscall.h): st_size@0 (qword), st_type@18 (byte).
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax. The
; int 0x80 stub preserves every GP register except rax.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
%define SYS_OPEN        5
%define SYS_READ        6
%define SYS_CLOSE       7
%define SYS_WRITE_FILE  18
%define SYS_CHDIR       36
%define SYS_MKDIR       38
%define SYS_RMDIR       39
%define SYS_UNLINK      40
%define SYS_SYMLINK     41
%define SYS_READLINK    42
%define SYS_STAT        45
%define SYS_LSTAT       46
%define SYS_RENAME      52

%define O_CREAT         1
%define ST_SIZE         0
%define ST_TYPE         18
%define T_FILE          1
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
    sub     rsp, 64
    mov     r15, rsp                   ; r15 -> struct khy_stat (24B)
    lea     r14, [rsp + 32]            ; r14 -> read buffer (16B)

    ; 1. chdir /tmp
    lea     rdi, [rel tmpdir]
    mov     rax, SYS_CHDIR
    int     0x80
    test    rax, rax
    jnz     .fail

    ; 2. create a.txt = "hello", close
    lea     rdi, [rel fa]
    mov     rsi, O_CREAT
    mov     rax, SYS_OPEN
    int     0x80
    js      .fail
    mov     rbx, rax                   ; fd
    mov     rdi, rbx
    lea     rsi, [rel content]
    mov     rdx, content_len           ; 5
    mov     rax, SYS_WRITE_FILE
    int     0x80
    cmp     rax, content_len
    jne     .fail
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80

    ; 3. rename a.txt -> b.txt
    lea     rdi, [rel fa]
    lea     rsi, [rel fb]
    mov     rax, SYS_RENAME
    int     0x80
    test    rax, rax
    jnz     .fail
    ; stat a.txt -> must be gone (-1)
    lea     rdi, [rel fa]
    mov     rsi, r15
    mov     rax, SYS_STAT
    int     0x80
    test    rax, rax
    jns     .fail                      ; success means a.txt still exists -> fail
    ; stat b.txt -> FILE, size 5
    lea     rdi, [rel fb]
    mov     rsi, r15
    mov     rax, SYS_STAT
    int     0x80
    test    rax, rax
    jnz     .fail
    cmp     qword [r15 + ST_SIZE], content_len
    jne     .fail
    cmp     byte [r15 + ST_TYPE], T_FILE
    jne     .fail
    ; open+read b.txt -> "hello" (data moved with the name)
    lea     rdi, [rel fb]
    xor     rsi, rsi                   ; read-only
    mov     rax, SYS_OPEN
    int     0x80
    js      .fail
    mov     rbx, rax
    mov     rdi, rbx
    mov     rsi, r14
    mov     rdx, 16
    mov     rax, SYS_READ
    int     0x80
    cmp     rax, content_len
    jne     .fail
    cmp     byte [r14 + 0], 'h'
    jne     .fail
    cmp     byte [r14 + 4], 'o'
    jne     .fail
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80

    ; 4. create c.txt ; rename b.txt -> c.txt must be refused (no clobber)
    lea     rdi, [rel fc]
    mov     rsi, O_CREAT
    mov     rax, SYS_OPEN
    int     0x80
    js      .fail
    mov     rdi, rax
    mov     rax, SYS_CLOSE
    int     0x80
    lea     rdi, [rel fb]
    lea     rsi, [rel fc]
    mov     rax, SYS_RENAME
    int     0x80
    test    rax, rax
    jns     .fail                      ; 0 would mean it clobbered c.txt -> fail

    ; 5. mkdir d1 ; rename d1 -> d2 must be refused (directory move)
    lea     rdi, [rel fd1]
    mov     rax, SYS_MKDIR
    int     0x80
    test    rax, rax
    jnz     .fail
    lea     rdi, [rel fd1]
    lea     rsi, [rel fd2]
    mov     rax, SYS_RENAME
    int     0x80
    test    rax, rax
    jns     .fail                      ; 0 would mean a directory got moved -> fail

    ; 6. symlink c.txt -> lnk ; rename lnk -> lnk2
    lea     rdi, [rel fc]              ; target
    lea     rsi, [rel flnk]            ; link path
    mov     rax, SYS_SYMLINK
    int     0x80
    test    rax, rax
    jnz     .fail
    lea     rdi, [rel flnk]
    lea     rsi, [rel flnk2]
    mov     rax, SYS_RENAME
    int     0x80
    test    rax, rax
    jnz     .fail
    ; lstat lnk -> gone
    lea     rdi, [rel flnk]
    mov     rsi, r15
    mov     rax, SYS_LSTAT
    int     0x80
    test    rax, rax
    jns     .fail
    ; lstat lnk2 -> SYMLINK
    lea     rdi, [rel flnk2]
    mov     rsi, r15
    mov     rax, SYS_LSTAT
    int     0x80
    test    rax, rax
    jnz     .fail
    cmp     byte [r15 + ST_TYPE], T_SYMLINK
    jne     .fail
    ; readlink lnk2 -> "c.txt" (target text moved with the link)
    lea     rdi, [rel flnk2]
    mov     rsi, r14
    mov     rdx, 16
    mov     rax, SYS_READLINK
    int     0x80
    cmp     rax, target_len            ; "c.txt" = 5 bytes, not NUL-terminated
    jne     .fail
    cmp     byte [r14 + 0], 'c'
    jne     .fail
    cmp     byte [r14 + 4], 't'
    jne     .fail

    ; 7. cleanup
    lea     rdi, [rel fb]
    mov     rax, SYS_UNLINK
    int     0x80
    lea     rdi, [rel fc]
    mov     rax, SYS_UNLINK
    int     0x80
    lea     rdi, [rel flnk2]
    mov     rax, SYS_UNLINK
    int     0x80
    lea     rdi, [rel fd1]
    mov     rax, SYS_RMDIR
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
fa:          db "a.txt", 0
fb:          db "b.txt", 0
fc:          db "c.txt", 0
fd1:         db "d1", 0
fd2:         db "d2", 0
flnk:        db "lnk", 0
flnk2:       db "lnk2", 0
content:     db "hello"
content_len  equ $ - content
target:      db "c.txt"
target_len   equ $ - target
ok_line:     db "[user] renametest: move file + symlink, reject dir/clobber -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] renametest: RENAME FAIL", 0x0A
bad_line_len equ $ - bad_line
