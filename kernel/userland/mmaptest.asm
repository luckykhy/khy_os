; mmaptest.asm — KHY OS file-backed mmap test (Phase 18). Proves a Ring 3
; program can map a file's contents into its address space and read them back
; through memory, that a mapping larger than its backing file reads as zero past
; end-of-file, and that an anonymous mapping is still zero-filled and writable.
; A toy kernel only has anonymous mmap; mapping a file into memory is a defining
; real-OS capability (it is how loaders, shared text, and zero-copy file reads
; work).
;
; Sequence (all from Ring 3 via int 0x80):
;   1.  open("/proc/version", 0)                 -> fd >= 0   (kept in rbx)
;   2.  mmap(MAPADDR, 4096, MAP_FILE|WRITABLE, fd, 0) -> 0
;   3.  bytes at MAPADDR == "KHY OS"             (the file's first 6 bytes)
;   4.  byte at MAPADDR+100 == 0                 (past EOF -> zero-filled)
;   5.  close(fd)
;   6.  mmap(MAPADDR2, 4096, WRITABLE, _, _)     -> 0   (anonymous)
;   7.  byte at MAPADDR2 == 0 ; store 0x42 ; reload == 0x42  (zeroed + writable)
; Any deviation jumps to .fail (exit 1). Success prints OK and exits 0.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args 0-2,
; r10 = arg 3, r8 = arg 4, ret in rax.
; mmap: rdi = addr, rsi = size, rdx = flags, r10 = fd, r8 = offset.

bits 64

%define SYS_WRITE   1
%define SYS_EXIT    2
%define SYS_OPEN    5
%define SYS_CLOSE   7
%define SYS_MMAP    17

%define MAP_FILE    0x10
%define PROT_WRITE  0x02            ; VMM_FLAG_WRITABLE

; Two mapping addresses high in the user window (>= VMM_USER_BASE = 512 GiB),
; far from the program image (0x400000) and the stack (~128 TiB top).
%define MAPADDR     0x0000009000000000
%define MAPADDR2    0x0000009000002000

%macro WRITE 2
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_WRITE
    int     0x80
%endmacro

section .text
global _start

_start:
    ; 1. open /proc/version (read-only), keep the fd in rbx (callee-saved).
    lea     rdi, [rel verpath]
    xor     rsi, rsi
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    js      .fail
    mov     rbx, rax

    ; 2. file-backed mmap of the first page at MAPADDR.
    mov     rdi, MAPADDR
    mov     rsi, 4096
    mov     rdx, MAP_FILE | PROT_WRITE
    mov     r10, rbx                  ; fd
    xor     r8, r8                    ; offset 0
    mov     rax, SYS_MMAP
    int     0x80
    test    rax, rax
    jnz     .fail

    ; 3. the mapped bytes must equal the file's leading "KHY OS".
    mov     rsi, MAPADDR
    cmp     byte [rsi + 0], 'K'
    jne     .fail
    cmp     byte [rsi + 1], 'H'
    jne     .fail
    cmp     byte [rsi + 2], 'Y'
    jne     .fail
    cmp     byte [rsi + 3], ' '
    jne     .fail
    cmp     byte [rsi + 4], 'O'
    jne     .fail
    cmp     byte [rsi + 5], 'S'
    jne     .fail

    ; 4. /proc/version is far shorter than a page; offset 100 must read as zero.
    cmp     byte [rsi + 100], 0
    jne     .fail

    ; 5. close the file (the mapping keeps its eager copy).
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80

    ; 6. anonymous mmap at MAPADDR2.
    mov     rdi, MAPADDR2
    mov     rsi, 4096
    mov     rdx, PROT_WRITE
    xor     r10, r10
    xor     r8, r8
    mov     rax, SYS_MMAP
    int     0x80
    test    rax, rax
    jnz     .fail

    ; 7. anonymous memory starts zeroed and is writable.
    mov     rsi, MAPADDR2
    cmp     byte [rsi], 0
    jne     .fail
    mov     byte [rsi], 0x42
    cmp     byte [rsi], 0x42
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
verpath:     db "/proc/version", 0
ok_line:     db "[user] mmaptest: file-backed + anon mmap -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] mmaptest: MMAP FAIL", 0x0A
bad_line_len equ $ - bad_line
