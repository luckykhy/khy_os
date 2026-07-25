; cowtest.asm — KHY OS Ring 3 program proving fork() shares memory copy-on-write
; with correct isolation. A toy "fork" that shares pages outright would let a
; child's writes bleed into the parent; a real one gives each side a private
; copy on first write, so neither sees the other's changes.
;
; The test hinges on a single writable global, `shared`, initialised to a known
; value. The child overwrites it and exits; the parent then wait()s (so the
; child's write has definitely happened) and re-reads the global. If COW works
; the parent still sees the ORIGINAL value — the child mutated its own private
; copy. If fork shared the page, the parent would see the child's value.
;
; Two kernel COW paths are exercised at once:
;   - the child's direct store faults from Ring 3 -> exception_handler COW break;
;   - SYS_WAIT writes `status` onto the parent's (post-fork, COW) stack, so the
;     kernel-side write goes through vmm_check_user_range -> vmm_cow_break.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi = args, ret in rax.
;   SYS_FORK (19): 0 in child, child pid in parent.
;   SYS_WAIT (21): rdi = &status. Returns child pid; writes the child exit code.

bits 64

%define SYS_WRITE 1
%define SYS_EXIT  2
%define SYS_FORK  19
%define SYS_WAIT  21

%define ORIG_VAL  0x1111
%define CHILD_VAL 0x2222

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

    ; ── parent: wait for the child, then check our copy is untouched ──
    sub     rsp, 16
    mov     rdi, rsp                ; &status (on the parent's COW stack)
    mov     rax, SYS_WAIT
    int     0x80                    ; child has now exited and written `shared`
    add     rsp, 16

    mov     rax, [rel shared]
    cmp     rax, ORIG_VAL
    jne     .corrupted

    lea     rdi, [rel okmsg]
    mov     rsi, okmsg_len
    mov     rax, SYS_WRITE
    int     0x80
    xor     rdi, rdi                ; exit 0 = isolation held
    mov     rax, SYS_EXIT
    int     0x80
    jmp     .hang

.corrupted:
    lea     rdi, [rel badmsg]
    mov     rsi, badmsg_len
    mov     rax, SYS_WRITE
    int     0x80
    mov     rdi, 1                  ; exit 1 = child's write leaked into parent
    mov     rax, SYS_EXIT
    int     0x80
    jmp     .hang

.child:
    ; First write to `shared` faults (page is read-only+COW); the kernel hands
    ; us a private copy and the store then succeeds on it.
    mov     qword [rel shared], CHILD_VAL
    lea     rdi, [rel cmsg]
    mov     rsi, cmsg_len
    mov     rax, SYS_WRITE
    int     0x80
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

.hang:
    jmp     .hang

section .data
shared:     dq  ORIG_VAL

section .rodata
banner:     db  "[user] cowtest: fork, child mutates a shared global", 0x0A
banner_len  equ $ - banner
cmsg:       db  "[user] cowtest CHILD: wrote my private copy, exiting", 0x0A
cmsg_len    equ $ - cmsg
okmsg:      db  "[user] cowtest PARENT: global intact -> COW isolation OK", 0x0A
okmsg_len   equ $ - okmsg
badmsg:     db  "[user] cowtest PARENT: global CORRUPTED -> fork shared page!", 0x0A
badmsg_len  equ $ - badmsg
