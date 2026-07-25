; init.asm — KHY OS minimal Ring 3 user program
;
; Demonstrates the full user-mode round trip on bare x86_64:
;   1. write(msg, len)  via int 0x80   (SYSCALL_WRITE  = 1)
;   2. getpid()         via int 0x80   (SYSCALL_GETPID = 3)
;   3. exit(0)          via int 0x80   (SYSCALL_EXIT   = 2)
;
; Syscall ABI (matches syscall_dispatch_frame in src/syscall.c):
;   rax = syscall number
;   rdi = arg0   rsi = arg1   rdx = arg2   r10 = arg3   r8 = arg4   r9 = arg5
;   return value in rax
; sys_write takes (arg0=buffer, arg1=length).
;
; Built as a static ELF64 executable; the kernel's elf_load_user_image maps the
; PT_LOAD segment into a fresh user address space and the scheduler drops to
; Ring 3 at _start. Data is reached RIP-relative so the program is position
; independent regardless of the load bias the loader applies.

bits 64

%define SYS_WRITE  1
%define SYS_EXIT   2
%define SYS_GETPID 3

section .text
global _start

_start:
    ; write(msg, msg_len)
    lea     rdi, [rel msg]          ; arg0 = buffer
    mov     rsi, msg_len            ; arg1 = length
    mov     rax, SYS_WRITE
    int     0x80

    ; getpid() — exercise a second syscall and its return value
    mov     rax, SYS_GETPID
    int     0x80                    ; rax = pid (demonstration only)

    ; exit(0) — does not return to user space
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

    ; Safety net: if exit ever returned, spin rather than run garbage.
.hang:
    jmp     .hang

; Keep the message in .text so the program is a single PT_LOAD segment.
msg:        db  "[user] hello from Ring 3 via int 0x80", 0x0A
msg_len     equ $ - msg
