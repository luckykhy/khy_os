; proctest.asm — KHY OS Ring 3 program exercising the Phase 4 process syscalls:
; sbrk (heap growth), getppid (parentage across fork), and kill (terminating a
; child and harvesting its signal exit code). Each check prints OK or FAIL; the
; program exits 0 only if all three pass. A toy kernel has none of these — a real
; one lets a process grow its heap, learn its parent, and signal another process.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi = args, ret in rax. The int
; 0x80 stub preserves every GP register except rax, so r12-r15/rbx survive calls.

bits 64

%define SYS_WRITE   1
%define SYS_EXIT    2
%define SYS_GETPID  3
%define SYS_FORK    19
%define SYS_WAIT    21
%define SYS_GETPPID 22
%define SYS_SBRK    23
%define SYS_KILL    24

%macro PRINT 2          ; %1 = label, %2 = length
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_WRITE
    int     0x80
%endmacro

section .text
global _start

_start:
    PRINT banner, banner_len

    ; ── sbrk: grow the heap one page and use it ──
    xor     rdi, rdi                ; sbrk(0) -> current break
    mov     rax, SYS_SBRK
    int     0x80
    mov     r14, rax                ; r14 = initial break

    mov     rdi, 4096               ; sbrk(+4096) -> old break
    mov     rax, SYS_SBRK
    int     0x80
    cmp     rax, r14                ; must return the previous break
    jne     .sbrk_fail

    mov     qword [r14], 0xCAFE     ; the freshly mapped page must be writable
    cmp     qword [r14], 0xCAFE
    jne     .sbrk_fail

    xor     rdi, rdi                ; sbrk(0) -> must now be old + 4096
    mov     rax, SYS_SBRK
    int     0x80
    lea     rbx, [r14 + 4096]
    cmp     rax, rbx
    jne     .sbrk_fail
    PRINT sbrk_ok, sbrk_ok_len
    jmp     .ppid
.sbrk_fail:
    PRINT sbrk_bad, sbrk_bad_len

    ; ── getppid: a child's parent pid equals our pid ──
.ppid:
    mov     rax, SYS_GETPID
    int     0x80
    mov     [rel parent_pid], rax   ; remembered BEFORE fork, inherited by child

    mov     rax, SYS_FORK
    int     0x80
    test    rax, rax
    jz      .child_ppid             ; child verifies and exits

    sub     rsp, 16                 ; parent reaps the getppid child
    mov     rdi, rsp
    mov     rax, SYS_WAIT
    int     0x80
    add     rsp, 16

    ; ── kill: fork a spinner, kill it, harvest exit code 128+9 ──
    mov     rax, SYS_FORK
    int     0x80
    test    rax, rax
    jz      .child_spin
    mov     r15, rax                ; r15 = victim pid

    mov     rdi, r15                ; kill(pid, 9)
    mov     rsi, 9
    mov     rax, SYS_KILL
    int     0x80

    sub     rsp, 16
    mov     rdi, rsp
    mov     rax, SYS_WAIT           ; wait() -> exit code at [rsp]
    int     0x80
    mov     r12d, [rsp]
    add     rsp, 16
    cmp     r12, 137                ; 128 + SIGKILL(9)
    jne     .kill_fail
    PRINT kill_ok, kill_ok_len
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80
.kill_fail:
    PRINT kill_bad, kill_bad_len
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80

.child_ppid:
    mov     rax, SYS_GETPPID
    int     0x80
    cmp     rax, [rel parent_pid]
    jne     .child_ppid_fail
    PRINT ppid_ok, ppid_ok_len
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80
.child_ppid_fail:
    PRINT ppid_bad, ppid_bad_len
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80

.child_spin:
    jmp     .child_spin             ; spin in Ring 3 until the parent kills us

section .data
parent_pid: dq 0

section .rodata
banner:     db "[user] proctest: sbrk + getppid + kill", 0x0A
banner_len  equ $ - banner
sbrk_ok:    db "[user] proctest: sbrk OK", 0x0A
sbrk_ok_len equ $ - sbrk_ok
sbrk_bad:   db "[user] proctest: sbrk FAIL", 0x0A
sbrk_bad_len equ $ - sbrk_bad
ppid_ok:    db "[user] proctest: getppid OK", 0x0A
ppid_ok_len equ $ - ppid_ok
ppid_bad:   db "[user] proctest: getppid FAIL", 0x0A
ppid_bad_len equ $ - ppid_bad
kill_ok:    db "[user] proctest: kill OK (child reaped, code 137)", 0x0A
kill_ok_len equ $ - kill_ok
kill_bad:   db "[user] proctest: kill FAIL", 0x0A
kill_bad_len equ $ - kill_bad
