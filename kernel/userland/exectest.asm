; exectest.asm — KHY OS Ring 3 program that proves exec() replaces the running
; image IN PLACE. It prints a banner, then exec()s /bin/argv.elf with arguments
; ["/bin/argv.elf", "X", "Y"]. If exec works:
;   - argv.elf's own output appears (argc=3, then the three argument strings),
;   - the "THIS SHOULD NOT PRINT" line below the exec NEVER runs (the old image,
;     including this .text, was torn down and replaced),
;   - the pid/task is reused (no new task is created).
; exec returns ONLY on failure — so reaching the code after int 0x80 means it
; failed, and we say so before exiting.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.
; SYS_EXEC takes rdi = path (char*), rsi = argv (char** NULL-terminated).

bits 64

%define SYS_WRITE 1
%define SYS_EXIT  2
%define SYS_EXEC  20

section .text
global _start

_start:
    ; banner before exec (printed once, by the original image)
    lea     rdi, [rel banner]
    mov     rsi, banner_len
    mov     rax, SYS_WRITE
    int     0x80

    ; Build argv = { &path, &arg_x, &arg_y, NULL } on the writable user stack.
    ; (The strings live in .text — read-only is fine for reading; only the
    ; pointer array needs writable storage.)
    sub     rsp, 32
    lea     rax, [rel path]
    mov     [rsp], rax
    lea     rax, [rel arg_x]
    mov     [rsp + 8], rax
    lea     rax, [rel arg_y]
    mov     [rsp + 16], rax
    mov     qword [rsp + 24], 0          ; NULL terminator

    lea     rdi, [rel path]              ; path to the new image
    mov     rsi, rsp                     ; argv
    mov     rax, SYS_EXEC
    int     0x80                         ; on success: never returns

    ; ── only reached if exec FAILED ──
    add     rsp, 32
    lea     rdi, [rel failed]
    mov     rsi, failed_len
    mov     rax, SYS_WRITE
    int     0x80

    ; This line proves the negative: it must NEVER appear when exec succeeds.
    lea     rdi, [rel notreached]
    mov     rsi, notreached_len
    mov     rax, SYS_WRITE
    int     0x80

    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80
.hang:
    jmp     .hang

banner:         db  "[user] exectest: about to exec /bin/argv.elf X Y", 0x0A
banner_len      equ $ - banner
failed:         db  "[user] exectest: exec FAILED", 0x0A
failed_len      equ $ - failed
notreached:     db  "[user] exectest: THIS SHOULD NOT PRINT", 0x0A
notreached_len  equ $ - notreached
path:           db  "/bin/argv.elf", 0
arg_x:          db  "X", 0
arg_y:          db  "Y", 0
