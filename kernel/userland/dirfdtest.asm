; dirfdtest.asm — KHY OS fd-based directory streaming test (Phase 25). Proves a
; Ring 3 program can OPEN a directory as a descriptor and page through its entries
; with fgetdents, advancing a per-fd cursor across calls — so a directory larger
; than one buffer is fully enumerable, unlike the per-call-capped path-based
; getdents. Also proves a directory fd is not byte-readable/writable and that
; fstat reports it as a directory.
;
; All work happens under /tmp (created by ramfs_init, so no -hda is needed).
;
; Sequence (all from Ring 3 via int 0x80):
;   1.  chdir /tmp ; mkdir fgd ; chdir fgd  (fresh isolated directory)
;   2.  create 5 files: a b c d e
;   3.  open "." -> a directory fd (>= 0)
;   4.  read(dirfd) -> -1 (directories are not byte-readable)
;   5.  fstat(dirfd) -> type DIR
;   6.  fgetdents(dirfd, buf, 2) paged: 2, 2, 1, then 0 (total 5, every entry a
;       FILE) — proving the cursor advances and terminates cleanly
;   7.  close ; unlink a..e ; chdir .. ; rmdir fgd
; Any deviation jumps to fail (exit 1). Success prints OK and exits 0.
;
; struct khy_dirent (src/syscall.h): d_size@0 (q), d_type@8 (b), d_name@16; 64B.
; struct khy_stat   (src/syscall.h): st_type@18 (b).
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax. The
; int 0x80 stub preserves every GP register except rax.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
%define SYS_OPEN        5
%define SYS_READ        6
%define SYS_CLOSE       7
%define SYS_CHDIR       36
%define SYS_MKDIR       38
%define SYS_RMDIR       39
%define SYS_UNLINK      40
%define SYS_FSTAT       47
%define SYS_FGETDENTS   53

%define O_CREAT         1
%define DE_TYPE         8
%define DE_STRIDE       64
%define ST_TYPE         18
%define T_FILE          1
%define T_DIR           2

%macro WRITE 2
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_WRITE
    int     0x80
%endmacro

section .text
global _start

_start:
    sub     rsp, 192
    mov     r15, rsp                   ; r15 -> dirent buffer (2*64 = 128B)
    lea     r14, [rsp + 128]           ; r14 -> stat buffer (24B)

    ; 1. chdir /tmp ; mkdir fgd ; chdir fgd
    lea     rdi, [rel tmpdir]
    mov     rax, SYS_CHDIR
    int     0x80
    test    rax, rax
    jnz     fail
    lea     rdi, [rel dname]
    mov     rax, SYS_MKDIR
    int     0x80
    test    rax, rax
    jnz     fail
    lea     rdi, [rel dname]
    mov     rax, SYS_CHDIR
    int     0x80
    test    rax, rax
    jnz     fail

    ; 2. create 5 files
    lea     rdi, [rel na]
    call    mkfile
    lea     rdi, [rel nb]
    call    mkfile
    lea     rdi, [rel nc]
    call    mkfile
    lea     rdi, [rel nd]
    call    mkfile
    lea     rdi, [rel ne]
    call    mkfile

    ; 3. open "." as a directory fd
    lea     rdi, [rel dot]
    xor     rsi, rsi                   ; read-only
    mov     rax, SYS_OPEN
    int     0x80
    js      fail
    mov     rbx, rax                   ; rbx = dir fd

    ; 4. read(dirfd) must be rejected (-1)
    mov     rdi, rbx
    mov     rsi, r15
    mov     rdx, 64
    mov     rax, SYS_READ
    int     0x80
    test    rax, rax
    jns     fail                       ; >= 0 means it returned bytes -> fail

    ; 5. fstat(dirfd) -> DIR
    mov     rdi, rbx
    mov     rsi, r14
    mov     rax, SYS_FSTAT
    int     0x80
    test    rax, rax
    jnz     fail
    cmp     byte [r14 + ST_TYPE], T_DIR
    jne     fail

    ; 6. page through with max=2: expect 2, 2, 1, 0 (total 5, every entry FILE)
    xor     r12, r12                   ; r12 = total entries seen
.page:
    mov     rdi, rbx
    mov     rsi, r15
    mov     rdx, 2                     ; max 2 entries per call
    mov     rax, SYS_FGETDENTS
    int     0x80
    test    rax, rax
    js      fail                       ; -1 = error
    jz      .pages_done                ; 0 = end of directory
    mov     r13, rax                   ; entries this page
    cmp     r13, 2
    ja      fail                       ; must never exceed the requested max
    xor     rcx, rcx                   ; per-page entry index (no syscall in loop)
.scan:
    mov     rax, rcx
    shl     rax, 6                     ; rax = index * 64 (DE_STRIDE)
    cmp     byte [r15 + rax + DE_TYPE], T_FILE
    jne     fail
    inc     rcx
    cmp     rcx, r13
    jb      .scan
    add     r12, r13
    jmp     .page
.pages_done:
    cmp     r12, 5                     ; all five files seen across pages
    jne     fail

    ; 7. close ; cleanup
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80
    lea     rdi, [rel na]
    call    rmfile
    lea     rdi, [rel nb]
    call    rmfile
    lea     rdi, [rel nc]
    call    rmfile
    lea     rdi, [rel nd]
    call    rmfile
    lea     rdi, [rel ne]
    call    rmfile
    lea     rdi, [rel dotdot]
    mov     rax, SYS_CHDIR
    int     0x80
    lea     rdi, [rel dname]
    mov     rax, SYS_RMDIR
    int     0x80

    WRITE   ok_line, ok_line_len
    add     rsp, 192
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

; --- subroutines (each may bail to fail; the leaked return addr is harmless on
;     the immediately-following exit) ---
mkfile:                                ; rdi = name; create O_CREAT then close
    mov     rsi, O_CREAT
    mov     rax, SYS_OPEN
    int     0x80
    js      fail
    mov     rdi, rax
    mov     rax, SYS_CLOSE
    int     0x80
    ret

rmfile:                                ; rdi = name; unlink
    mov     rax, SYS_UNLINK
    int     0x80
    ret

fail:
    WRITE   bad_line, bad_line_len
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80

section .rodata
tmpdir:      db "/tmp", 0
dname:       db "fgd", 0
dot:         db ".", 0
dotdot:      db "..", 0
na:          db "a", 0
nb:          db "b", 0
nc:          db "c", 0
nd:          db "d", 0
ne:          db "e", 0
ok_line:     db "[user] dirfdtest: open dir + paged fgetdents cursor -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] dirfdtest: DIRFD FAIL", 0x0A
bad_line_len equ $ - bad_line
