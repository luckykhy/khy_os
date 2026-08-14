; atimetest.asm — KHY OS access/status-time test (Phase 29). Completes the POSIX
; timestamp triple (atime/mtime/ctime) and proves each operation touches only the
; correct timestamp — the semantics that distinguish a real inode from a stub:
;   1. create + write a file ; fstat -> mtime0/atime0/ctime0 must all be a
;      plausible epoch, and atime0>=mtime0, ctime0>=mtime0 (born equal).
;   2. chmod the file ; fstat -> mtime MUST be byte-identical (chmod never touches
;      content time) while ctime does not run backwards (status changed).
;   3. read the file ; fstat -> mtime MUST still be byte-identical (a read never
;      modifies) while atime does not run backwards (the file was accessed).
; The RTC has 1-second granularity, so within this sub-second test the three
; stamps stay equal; the strength of the test is the byte-exact "mtime unchanged"
; checks — a stub that bumps every timestamp on every call fails them.
;
; struct khy_stat layout (src/syscall.h): st_size@0, st_uid@8, st_gid@12,
; st_mode@16, st_type@18, st_mtime@24, st_atime@32, st_ctime@40 (48 bytes).
;
; Syscall ABI: rax = number, rdi/rsi/rdx = args, ret in rax. int 0x80 preserves
; every GP register except rax, so saved stamps survive in r12..r14.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
%define SYS_OPEN        5
%define SYS_READ        6
%define SYS_CLOSE       7
%define SYS_WRITE_FILE  18
%define SYS_CHMOD       34
%define SYS_CHDIR       36
%define SYS_UNLINK      40
%define SYS_FSTAT       47
%define SYS_LSEEK       49

%define O_CREAT         1
%define SEEK_SET        0
%define ST_MTIME        24
%define ST_ATIME        32
%define ST_CTIME        40

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
    sub     rsp, 80
    mov     r15, rsp                   ; r15 -> 48-byte stat buffer (+ slack)

    ; chdir /tmp
    lea     rdi, [rel tmpdir]
    mov     rax, SYS_CHDIR
    int     0x80
    test    rax, rax
    jnz     fail

    ; create at.txt and write "data"
    lea     rdi, [rel atf]
    mov     rsi, O_CREAT
    mov     rax, SYS_OPEN
    int     0x80
    js      fail
    mov     rbx, rax                   ; rbx = fd
    mov     rdi, rbx
    lea     rsi, [rel data]
    mov     rdx, 4
    mov     rax, SYS_WRITE_FILE
    int     0x80
    cmp     rax, 4
    jne     fail

    ; fstat -> snapshot the three timestamps
    call    do_fstat
    mov     r12, [r15 + ST_MTIME]      ; r12 = mtime0
    mov     r13, [r15 + ST_ATIME]      ; r13 = atime0
    mov     r14, [r15 + ST_CTIME]      ; r14 = ctime0

    ; all three must be a plausible calendar time
    mov     rcx, EPOCH_LO
    cmp     r12, rcx
    jb      fail
    cmp     r13, rcx
    jb      fail
    cmp     r14, rcx
    jb      fail
    mov     rcx, EPOCH_HI
    cmp     r12, rcx
    jae     fail
    cmp     r13, rcx
    jae     fail
    cmp     r14, rcx
    jae     fail

    ; born consistent: access/status no earlier than modification
    cmp     r13, r12
    jb      fail                       ; atime0 < mtime0 -> bad
    cmp     r14, r12
    jb      fail                       ; ctime0 < mtime0 -> bad

    ; --- chmod must change ctime only, never mtime ---
    lea     rdi, [rel atf]
    mov     rsi, 384                   ; 0o600 — owner-only rw
    mov     rax, SYS_CHMOD
    int     0x80
    test    rax, rax
    jnz     fail
    call    do_fstat
    mov     rcx, [r15 + ST_MTIME]
    cmp     rcx, r12
    jne     fail                       ; chmod moved mtime -> bad
    mov     rcx, [r15 + ST_CTIME]
    cmp     rcx, r14
    jb      fail                       ; ctime ran backwards -> bad

    ; --- read must change atime only, never mtime ---
    mov     rdi, rbx                   ; rewind to start before reading
    xor     rsi, rsi
    mov     rdx, SEEK_SET
    mov     rax, SYS_LSEEK
    int     0x80
    mov     rdi, rbx
    lea     rsi, [rel rbuf]
    mov     rdx, 4
    mov     rax, SYS_READ
    int     0x80
    cmp     rax, 4
    jne     fail
    call    do_fstat
    mov     rcx, [r15 + ST_MTIME]
    cmp     rcx, r12
    jne     fail                       ; read moved mtime -> bad
    mov     rcx, [r15 + ST_ATIME]
    cmp     rcx, r13
    jb      fail                       ; atime ran backwards -> bad

    ; cleanup
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80
    lea     rdi, [rel atf]
    mov     rax, SYS_UNLINK
    int     0x80

    WRITE   ok_line, ok_line_len
    add     rsp, 80
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

; fstat(rbx) into the buffer at r15; jumps to fail on error. Clobbers rax/rdi/rsi.
do_fstat:
    mov     rdi, rbx
    mov     rsi, r15
    mov     rax, SYS_FSTAT
    int     0x80
    test    rax, rax
    jnz     fail
    ret

fail:
    WRITE   bad_line, bad_line_len
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80

section .rodata
tmpdir:      db "/tmp", 0
atf:         db "at.txt", 0
data:        db "data"
ok_line:     db "[user] atimetest: atime on read + ctime on chmod, mtime untouched -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] atimetest: ATIME/CTIME FAIL", 0x0A
bad_line_len equ $ - bad_line

section .bss
rbuf:        resb 16
