; argv.asm — KHY OS Ring 3 program that dumps its argument vector
;
; Proves the kernel seeds the SysV x86-64 process stack: at _start
;   [rsp]         = argc
;   [rsp + 8]     = argv[0]
;   [rsp + 8 + 8*i] = argv[i]
;   argv[argc]    = NULL
; The program walks argv[], writing each string (one per line) via int 0x80.
;
; Syscall ABI (see src/syscall.c): rax = number, rdi/rsi = arg0/arg1, ret in rax.
; The int 0x80 stub preserves every GP register except rax, so r12/r13/r14 hold
; argc / &argv[0] / the loop index safely across syscalls.
; sys_write takes (arg0=buffer, arg1=length); writes to the console.

bits 64

%define SYS_WRITE 1
%define SYS_EXIT  2

section .text
global _start

_start:
    mov     r12, [rsp]              ; r12 = argc
    lea     r13, [rsp + 8]          ; r13 = &argv[0]

    ; banner: "[user] argc=" + decimal argc + "\n"
    lea     rdi, [rel banner]
    mov     rsi, banner_len
    mov     rax, SYS_WRITE
    int     0x80

    ; print argc as a single decimal digit (argc is small in practice).
    ; Build "<d>\n" on the stack — the .text segment is mapped read-only (R+X),
    ; so the scratch byte must live on the writable user stack. r12/r13 already
    ; hold argc and &argv[0], so clobbering rsp here is safe.
    mov     rax, r12
    add     al, '0'
    sub     rsp, 16
    mov     [rsp], al
    mov     byte [rsp + 1], 0x0A
    mov     rdi, rsp
    mov     rsi, 2
    mov     rax, SYS_WRITE
    int     0x80
    add     rsp, 16

    xor     r14, r14               ; i = 0
.loop:
    cmp     r14, r12
    jge     .done

    ; "  argv[i] = " prefix (no index number, keep it simple)
    lea     rdi, [rel prefix]
    mov     rsi, prefix_len
    mov     rax, SYS_WRITE
    int     0x80

    ; rbx = argv[i]
    mov     rbx, [r13 + r14 * 8]

    ; compute strlen(rbx) → rcx
    mov     rcx, rbx
.strlen:
    cmp     byte [rcx], 0
    je      .gotlen
    inc     rcx
    jmp     .strlen
.gotlen:
    sub     rcx, rbx               ; rcx = length

    ; write(argv[i], len)
    mov     rdi, rbx
    mov     rsi, rcx
    mov     rax, SYS_WRITE
    int     0x80

    ; newline
    lea     rdi, [rel nl]
    mov     rsi, 1
    mov     rax, SYS_WRITE
    int     0x80

    inc     r14
    jmp     .loop

.done:
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80
.hang:
    jmp     .hang

; Data kept in .text so the program is a single PT_LOAD R+X segment; reached
; RIP-relative for position independence.
banner:     db  "[user] argc="
banner_len  equ $ - banner
prefix:     db  "  argv = "
prefix_len  equ $ - prefix
nl:         db  0x0A
