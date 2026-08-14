; filetest.asm — KHY OS Ring 3 program exercising the user-mode file API.
;
; Proves a user program can CREATE and WRITE a file (not just read one), and
; that the file is durable: it targets /disk, so the VFS write hook persists it
; to KhyFS on the ATA disk. Flow:
;   1. write(banner)                               console announce
;   2. fd  = open("/disk/uf.txt", O_CREAT)         create/truncate
;   3. write_file(fd, content, len)                fill it
;   4. close(fd)
;   5. fd2 = open("/disk/uf.txt", 0)               reopen read-only
;   6. n   = read(fd2, stackbuf, 128)              read it back
;   7. write(stackbuf, n)                          echo to console
;   8. close(fd2); exit(0)
;
; Syscall ABI (see src/syscall.c): rax=number; rdi,rsi,rdx,r10,r8,r9 = args;
; return in rax. The int 0x80 stub preserves every register except rax, so the
; file descriptor kept in r12/r13 survives across syscalls.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
%define SYS_OPEN        5
%define SYS_READ        6
%define SYS_CLOSE       7
%define SYS_WRITE_FILE  18
%define O_CREAT         1

section .text
global _start

_start:
    ; write(banner, banner_len)
    lea     rdi, [rel banner]
    mov     rsi, banner_len
    mov     rax, SYS_WRITE
    int     0x80

    ; fd = open("/disk/uf.txt", O_CREAT)
    lea     rdi, [rel path]
    mov     rsi, O_CREAT
    mov     rax, SYS_OPEN
    int     0x80
    mov     r12, rax                ; r12 = write fd (survives syscalls)

    ; write_file(fd, content, content_len)
    mov     rdi, r12
    lea     rsi, [rel content]
    mov     rdx, content_len
    mov     rax, SYS_WRITE_FILE
    int     0x80

    ; close(fd)
    mov     rdi, r12
    mov     rax, SYS_CLOSE
    int     0x80

    ; fd2 = open("/disk/uf.txt", 0)   — must already exist
    lea     rdi, [rel path]
    xor     rsi, rsi
    mov     rax, SYS_OPEN
    int     0x80
    mov     r12, rax                ; r12 = read fd

    ; read(fd2, stackbuf, 128) — scratch buffer on the writable user stack
    sub     rsp, 256
    mov     rdi, r12
    mov     rsi, rsp
    mov     rdx, 128
    mov     rax, SYS_READ
    int     0x80
    mov     r13, rax                ; r13 = bytes read

    ; write(readback_label)
    lea     rdi, [rel readback]
    mov     rsi, readback_len
    mov     rax, SYS_WRITE
    int     0x80

    ; write(stackbuf, n) — echo the bytes we just read back from disk
    mov     rdi, rsp
    mov     rsi, r13
    mov     rax, SYS_WRITE
    int     0x80
    add     rsp, 256

    ; close(fd2)
    mov     rdi, r12
    mov     rax, SYS_CLOSE
    int     0x80

    ; exit(0)
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

.hang:
    jmp     .hang

; Keep all data in .text so the program stays a single PT_LOAD segment.
banner:        db  "[user] filetest: creating /disk/uf.txt", 0x0A
banner_len     equ $ - banner
readback:      db  "[user] read back from disk: "
readback_len   equ $ - readback
path:          db  "/disk/uf.txt", 0
content:       db  "saved by a Ring 3 program", 0x0A
content_len    equ $ - content
