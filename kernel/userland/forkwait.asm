; forkwait.asm — KHY OS Ring 3 program proving the full fork + exit + wait trio.
; The parent fork()s a child; the child exits with a distinctive code (42); the
; parent wait()s, harvests that code, and prints it. Decisive signals:
;   - the CHILD banner and the parent's "child exit code=42" both appear,
;   - the parent's wait() returns ONLY after the child has exited (ordering),
;   - the child is reaped exactly once (no leak, no double free).
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi = args, ret in rax.
;   SYS_FORK (19): returns 0 in child, child pid in parent.
;   SYS_WAIT (21): rdi = &status (int). Returns child pid; writes exit code.
; The int 0x80 stub preserves every GP register except rax.

bits 64

%define SYS_WRITE 1
%define SYS_EXIT  2
%define SYS_FORK  19
%define SYS_WAIT  21

section .text
global _start

_start:
    lea     rdi, [rel banner]
    mov     rsi, banner_len
    mov     rax, SYS_WRITE
    int     0x80

    mov     rax, SYS_FORK
    int     0x80
    test    rax, rax
    jz      .child

    ; ── parent: wait for the child and report its exit code ──
    sub     rsp, 16                 ; status int lives at [rsp]
    mov     rdi, rsp                ; &status
    mov     rax, SYS_WAIT
    int     0x80                    ; rax = reaped pid, [rsp] = exit code
    mov     r12d, [rsp]             ; r12 = exit code (zero-extended 32-bit load)
    add     rsp, 16

    lea     rdi, [rel pmsg]
    mov     rsi, pmsg_len
    mov     rax, SYS_WRITE
    int     0x80

    ; print r12 in decimal followed by newline (scratch on the writable stack)
    sub     rsp, 32
    mov     byte [rsp + 31], 0x0A   ; trailing newline
    lea     rsi, [rsp + 30]         ; write digits downward from here
    mov     rax, r12
    mov     rbx, 10
.conv:
    xor     rdx, rdx
    div     rbx                     ; rax /= 10, rdx = remainder
    add     dl, '0'
    mov     [rsi], dl
    dec     rsi
    test    rax, rax
    jnz     .conv
    inc     rsi                     ; rsi -> first digit
    lea     rdi, [rsp + 31]
    sub     rdi, rsi
    inc     rdi                     ; rdi = digit count + newline
    mov     rdx, rdi                ; save length
    mov     rdi, rsi                ; buf = first digit
    mov     rsi, rdx                ; len
    mov     rax, SYS_WRITE
    int     0x80
    add     rsp, 32

    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80
    jmp     .hang

.child:
    lea     rdi, [rel cmsg]
    mov     rsi, cmsg_len
    mov     rax, SYS_WRITE
    int     0x80
    mov     rdi, 42                 ; distinctive exit code for the parent to read
    mov     rax, SYS_EXIT
    int     0x80

.hang:
    jmp     .hang

banner:     db  "[user] forkwait: parent will wait for child", 0x0A
banner_len  equ $ - banner
cmsg:       db  "[user] forkwait CHILD: exiting with code 42", 0x0A
cmsg_len    equ $ - cmsg
pmsg:       db  "[user] forkwait PARENT: child exit code="
pmsg_len    equ $ - pmsg
