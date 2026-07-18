; mtimetest.asm — KHY OS file-timestamp test (Phase 28). Proves a file carries a
; real last-modification time (Unix epoch seconds), not a placeholder:
;   1. t0 = time() ; create + write a file ; t1 = time()
;   2. fstat the fd ; st_mtime must satisfy t0 <= st_mtime <= t1 — i.e. it was
;      stamped with the actual wall-clock instant of the write (and lies in a
;      plausible epoch range).
;   3. write again ; st_mtime must not run backwards (monotonic non-decreasing).
; Any deviation jumps to fail (exit 1). Success prints OK and exits 0.
;
; struct khy_stat layout (src/syscall.h): st_size@0, st_uid@8, st_gid@12,
; st_mode@16, st_type@18, st_mtime@24 (32 bytes total).
;
; Syscall ABI: rax = number, rdi/rsi/rdx = args, ret in rax. int 0x80 preserves
; every GP register except rax, so t0/t1/mtime survive in r12/r13/r14.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
%define SYS_OPEN        5
%define SYS_CLOSE       7
%define SYS_WRITE_FILE  18
%define SYS_CHDIR       36
%define SYS_UNLINK      40
%define SYS_FSTAT       47
%define SYS_TIME        55

%define O_CREAT         1
%define ST_MTIME        24          ; byte offset of st_mtime within struct khy_stat

%define EPOCH_LO        1700000000  ; 2023-11-14
%define EPOCH_HI        4102444800  ; 2100-01-01

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
    mov     r15, rsp                   ; r15 -> 32-byte stat buffer (+ slack)

    ; chdir /tmp
    lea     rdi, [rel tmpdir]
    mov     rax, SYS_CHDIR
    int     0x80
    test    rax, rax
    jnz     fail

    ; t0 = time() (before the write)
    mov     rax, SYS_TIME
    int     0x80
    mov     r12, rax                   ; r12 = t0

    ; create mt.txt and write "hello"
    lea     rdi, [rel mtf]
    mov     rsi, O_CREAT
    mov     rax, SYS_OPEN
    int     0x80
    js      fail
    mov     rbx, rax                   ; rbx = fd
    mov     rdi, rbx
    lea     rsi, [rel hello]
    mov     rdx, 5
    mov     rax, SYS_WRITE_FILE
    int     0x80
    cmp     rax, 5
    jne     fail

    ; t1 = time() (after the write)
    mov     rax, SYS_TIME
    int     0x80
    mov     r13, rax                   ; r13 = t1

    ; fstat -> read st_mtime
    mov     rdi, rbx
    mov     rsi, r15
    mov     rax, SYS_FSTAT
    int     0x80
    test    rax, rax
    jnz     fail
    mov     r14, [r15 + ST_MTIME]      ; r14 = mtime1

    ; plausible epoch range
    mov     rcx, EPOCH_LO
    cmp     r14, rcx
    jb      fail
    mov     rcx, EPOCH_HI
    cmp     r14, rcx
    jae     fail

    ; t0 <= mtime <= t1 : stamped at the real instant of the write
    cmp     r14, r12
    jb      fail
    cmp     r14, r13
    ja      fail

    ; modify again -> mtime must not go backwards
    mov     rdi, rbx
    lea     rsi, [rel world]
    mov     rdx, 5
    mov     rax, SYS_WRITE_FILE
    int     0x80
    cmp     rax, 5
    jne     fail
    mov     rdi, rbx
    mov     rsi, r15
    mov     rax, SYS_FSTAT
    int     0x80
    test    rax, rax
    jnz     fail
    mov     rcx, [r15 + ST_MTIME]      ; mtime2
    cmp     rcx, r14
    jb      fail                       ; wall clock went backwards -> bad

    ; cleanup
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80
    lea     rdi, [rel mtf]
    mov     rax, SYS_UNLINK
    int     0x80

    WRITE   ok_line, ok_line_len
    add     rsp, 64
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

fail:
    WRITE   bad_line, bad_line_len
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80

section .rodata
tmpdir:      db "/tmp", 0
mtf:         db "mt.txt", 0
hello:       db "hello"
world:       db "world"
ok_line:     db "[user] mtimetest: file mtime tracks wall clock -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] mtimetest: MTIME FAIL", 0x0A
bad_line_len equ $ - bad_line
