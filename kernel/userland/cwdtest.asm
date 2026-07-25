; cwdtest.asm — KHY OS per-process working directory test (Phase 15). Proves the
; kernel tracks a current working directory and resolves relative paths against
; it — a defining "real OS vs toy" trait: a toy kernel forces every program to
; spell out absolute paths because there is no notion of "where am I".
;
; Sequence (all driven from Ring 3 via int 0x80):
;   1. getcwd()                  -> "/"      (a freshly launched program starts at root)
;   2. chdir("/tmp")             -> 0        (/tmp is created at boot by ramfs)
;   3. getcwd()                  -> "/tmp"   (the cwd actually moved)
;   4. open("rel.txt",O_CREAT)   -> fd >= 0  (RELATIVE path created inside /tmp)
;        write payload ; close
;   5. open("/tmp/rel.txt",rd)   -> fd >= 0  (the ABSOLUTE form names the same file,
;        close                                proving the relative open resolved to /tmp)
;   6. chdir("nope")             -> -1       (relative dir under /tmp does not exist)
;   7. chdir("..")               -> 0        (parent of /tmp)
;   8. getcwd()                  -> "/"      (".." popped back to root)
; Any deviation jumps to .fail (exit 1). Success prints OK and exits 0.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.
; int 0x80 preserves all GP registers except rax, so rbx/r12.. survive calls.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
%define SYS_OPEN        5
%define SYS_CLOSE       7
%define SYS_WRITE_FILE  18
%define SYS_CHDIR       36
%define SYS_GETCWD      37

%define O_CREAT         1

%macro WRITE 2
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_WRITE
    int     0x80
%endmacro

section .text
global _start

_start:
    ; 1. getcwd() must be "/" (length 1, first byte '/').
    lea     rdi, [rel cwdbuf]
    mov     rsi, cwdbuf_len
    mov     rax, SYS_GETCWD
    int     0x80
    cmp     rax, 1
    jne     .fail
    cmp     byte [rel cwdbuf], '/'
    jne     .fail

    ; 2. chdir("/tmp") must succeed.
    lea     rdi, [rel tmppath]
    mov     rax, SYS_CHDIR
    int     0x80
    test    rax, rax
    jnz     .fail

    ; 3. getcwd() must now be "/tmp" (length 4, exact bytes).
    lea     rdi, [rel cwdbuf]
    mov     rsi, cwdbuf_len
    mov     rax, SYS_GETCWD
    int     0x80
    cmp     rax, 4
    jne     .fail
    cmp     byte [rel cwdbuf + 0], '/'
    jne     .fail
    cmp     byte [rel cwdbuf + 1], 't'
    jne     .fail
    cmp     byte [rel cwdbuf + 2], 'm'
    jne     .fail
    cmp     byte [rel cwdbuf + 3], 'p'
    jne     .fail

    ; 4. open a RELATIVE path; it must be created inside /tmp.
    lea     rdi, [rel relname]
    mov     rsi, O_CREAT
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    js      .fail               ; negative fd => failure
    mov     rbx, rax            ; rbx = fd

    ; write a payload through the fd, then close.
    mov     rdi, rbx
    lea     rsi, [rel payload]
    mov     rdx, payload_len
    mov     rax, SYS_WRITE_FILE
    int     0x80
    cmp     rax, payload_len
    jne     .fail

    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80

    ; 5. open the ABSOLUTE form of the same file for read; must succeed.
    lea     rdi, [rel abspath]
    xor     rsi, rsi            ; flags = 0 (open existing for read)
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    js      .fail               ; relative open did NOT land in /tmp
    mov     rbx, rax
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80

    ; 6. chdir into a relative directory that does not exist -> -1.
    lea     rdi, [rel nopepath]
    mov     rax, SYS_CHDIR
    int     0x80
    test    rax, rax
    jns     .fail               ; 0 (success) means a bogus cwd was accepted

    ; 7. chdir("..") -> back to root.
    lea     rdi, [rel dotdot]
    mov     rax, SYS_CHDIR
    int     0x80
    test    rax, rax
    jnz     .fail

    ; 8. getcwd() must be "/" again.
    lea     rdi, [rel cwdbuf]
    mov     rsi, cwdbuf_len
    mov     rax, SYS_GETCWD
    int     0x80
    cmp     rax, 1
    jne     .fail
    cmp     byte [rel cwdbuf], '/'
    jne     .fail

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
relname:     db "rel.txt", 0
abspath:     db "/tmp/rel.txt", 0
nopepath:    db "nope", 0
dotdot:      db "..", 0
payload:     db "written via a relative path", 0x0A
payload_len  equ $ - payload
ok_line:     db "[user] cwdtest: cwd + relative-path resolution -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] cwdtest: CWD FAIL", 0x0A
bad_line_len equ $ - bad_line

section .bss
cwdbuf:      resb 64
cwdbuf_len   equ 64
