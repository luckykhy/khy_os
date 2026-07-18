; dup2test.asm — KHY OS descriptor-redirection test (Phase 26). Proves a Ring 3
; program can duplicate an open descriptor onto a CHOSEN target number with dup2:
; the target is closed first if open, the source is aliased onto it, and writes
; through the target reach the source's file — the primitive behind shell
; redirection (cmd > file). Also checks the no-clobber-of-others, same-fd no-op,
; and bad-source error paths.
;
; All work happens under /tmp (created by ramfs_init, so no -hda is needed).
;
; Sequence (all from Ring 3 via int 0x80):
;   1.  chdir /tmp
;   2.  fa = open d2a.txt O_CREAT ; write "AAAA"  (fa -> d2a, 4 bytes)
;   3.  fb = open d2b.txt O_CREAT ; write "BBBB"  (fb -> d2b, 4 bytes)
;   4.  dup2(fa, fb) -> returns fb ; fb now aliases d2a (its d2b handle closed)
;   5.  write "XX" through fb -> appends to d2a (now "AAAAXX")
;   6.  close fa ; close fb
;   7.  d2a.txt must read back "AAAAXX"  (redirection landed on the source file)
;   8.  d2b.txt must still read back "BBBB" (the pre-redirect write survived;
;       redirection did not corrupt the other file)
;   9.  dup2(30, 5) on an UNUSED source -> -1
;   10. fc = open d2a.txt ; dup2(fc, fc) -> fc (no-op) ; read still yields "AAAAXX"
;   11. unlink d2a.txt ; unlink d2b.txt
; Any deviation jumps to fail (exit 1). Success prints OK and exits 0.
;
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
%define SYS_UNLINK      40
%define SYS_DUP2        54

%define O_CREAT         1

%macro WRITE 2
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_WRITE
    int     0x80
%endmacro

; WF reg, label, len — append `len` bytes of `label` through the open fd in `reg`.
%macro WF 3
    mov     rdi, %1
    lea     rsi, [rel %2]
    mov     rdx, %3
    mov     rax, SYS_WRITE_FILE
    int     0x80
%endmacro

section .text
global _start

_start:
    sub     rsp, 128
    mov     r15, rsp                   ; r15 -> read scratch buffer

    ; 1. chdir /tmp
    lea     rdi, [rel tmpdir]
    mov     rax, SYS_CHDIR
    int     0x80
    test    rax, rax
    jnz     fail

    ; 2. fa = open d2a O_CREAT ; write "AAAA"
    lea     rdi, [rel d2a]
    mov     rsi, O_CREAT
    mov     rax, SYS_OPEN
    int     0x80
    js      fail
    mov     r12, rax                   ; r12 = fa
    WF      r12, sA, 4
    cmp     rax, 4
    jne     fail

    ; 3. fb = open d2b O_CREAT ; write "BBBB"
    lea     rdi, [rel d2b]
    mov     rsi, O_CREAT
    mov     rax, SYS_OPEN
    int     0x80
    js      fail
    mov     rbx, rax                   ; rbx = fb
    WF      rbx, sB, 4
    cmp     rax, 4
    jne     fail

    ; 4. dup2(fa, fb) -> must return fb
    mov     rdi, r12
    mov     rsi, rbx
    mov     rax, SYS_DUP2
    int     0x80
    cmp     rax, rbx
    jne     fail

    ; 5. write "XX" through fb (now aliases d2a) -> appends
    WF      rbx, sX, 2
    cmp     rax, 2
    jne     fail

    ; 6. close fa ; close fb
    mov     rdi, r12
    mov     rax, SYS_CLOSE
    int     0x80
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80

    ; 7. d2a must read back "AAAAXX"
    lea     rdi, [rel d2a]
    lea     rsi, [rel e_ax]
    mov     rdx, 6
    call    expect_read

    ; 8. d2b must still read back "BBBB"
    lea     rdi, [rel d2b]
    lea     rsi, [rel sB]
    mov     rdx, 4
    call    expect_read

    ; 9. dup2 on an unused source must fail (-1)
    mov     rdi, 30
    mov     rsi, 5
    mov     rax, SYS_DUP2
    int     0x80
    test    rax, rax
    jns     fail                       ; >= 0 means it wrongly succeeded

    ; 10. fc = open d2a ; dup2(fc, fc) no-op -> fc ; read still yields "AAAAXX"
    lea     rdi, [rel d2a]
    xor     rsi, rsi                   ; read-only
    mov     rax, SYS_OPEN
    int     0x80
    js      fail
    mov     rbx, rax                   ; rbx = fc
    mov     rdi, rbx
    mov     rsi, rbx
    mov     rax, SYS_DUP2
    int     0x80
    cmp     rax, rbx
    jne     fail
    mov     rdi, rbx
    mov     rsi, r15
    mov     rdx, 6
    mov     rax, SYS_READ
    int     0x80
    cmp     rax, 6
    jne     fail
    lea     rdi, [rel e_ax]
    mov     rsi, 6
    call    cmpbuf
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80

    ; 11. cleanup
    lea     rdi, [rel d2a]
    mov     rax, SYS_UNLINK
    int     0x80
    lea     rdi, [rel d2b]
    mov     rax, SYS_UNLINK
    int     0x80

    WRITE   ok_line, ok_line_len
    add     rsp, 128
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

; --- subroutines (each may bail to the shared fail label; the leaked return addr
;     is harmless on the immediately-following exit) ---

; expect_read: open `rdi` read-only, read its bytes into r15, assert the content
; equals the `rdx`-byte string at `rsi` AND that the file is exactly that long.
expect_read:                           ; rdi=path, rsi=expected, rdx=len
    mov     r13, rsi                   ; r13 = expected ptr (preserved across int 0x80)
    mov     r14, rdx                   ; r14 = expected len
    xor     rsi, rsi                   ; O_RDONLY
    mov     rax, SYS_OPEN
    int     0x80
    js      fail
    mov     rbx, rax                   ; rbx = fd
    mov     rdi, rbx
    mov     rsi, r15
    mov     rdx, r14
    mov     rax, SYS_READ
    int     0x80
    cmp     rax, r14
    jne     fail                       ; must read exactly len bytes
    mov     rdi, r13
    mov     rsi, r14
    call    cmpbuf
    ; a further read must hit EOF (0) — proves the file is not longer than len
    mov     rdi, rbx
    mov     rsi, r15
    mov     rdx, 16
    mov     rax, SYS_READ
    int     0x80
    test    rax, rax
    jnz     fail
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80
    ret

; cmpbuf: compare `rsi` bytes at r15 against the expected string at `rdi`; any
; mismatch jumps to fail. No syscall in the loop, so all registers survive.
cmpbuf:                                ; rdi=expected, rsi=len
    xor     rcx, rcx
.cl:
    mov     al, [r15 + rcx]
    cmp     al, [rdi + rcx]
    jne     fail
    inc     rcx
    cmp     rcx, rsi
    jb      .cl
    ret

fail:
    WRITE   bad_line, bad_line_len
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80

section .rodata
tmpdir:      db "/tmp", 0
d2a:         db "d2a.txt", 0
d2b:         db "d2b.txt", 0
sA:          db "AAAA"
sB:          db "BBBB"
sX:          db "XX"
e_ax:         db "AAAAXX"
ok_line:     db "[user] dup2test: redirect fd onto target + no-clobber -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] dup2test: DUP2 FAIL", 0x0A
bad_line_len equ $ - bad_line
