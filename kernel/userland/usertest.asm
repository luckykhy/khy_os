; usertest.asm — KHY OS multi-user / DAC test (Phase 13). Proves the kernel
; enforces Unix-style discretionary access control: a process has a uid, can
; create files it owns, can drop privilege irreversibly, and is then denied
; access to files it no longer owns. This is a defining "real OS vs toy" trait —
; a toy kernel runs everything as an omnipotent single user.
;
; Sequence (all driven from Ring 3 via int 0x80):
;   1. getuid()                 -> expect 0 (launched as root by the shell)
;   2. open("/tmp/sec",O_CREAT) -> fd >= 0 ; write payload ; close
;   3. chmod("/tmp/sec",0600)   -> owner-only; we are still root/owner -> 0
;   4. setuid(1000)             -> drop to an unprivileged uid -> 0
;   5. getuid()                 -> expect 1000
;   6. open("/tmp/sec",rd)      -> DENIED (-1): owner=0, other bits of 0600 = 0
;   7. setuid(0)                -> DENIED (-1): cannot regain root
; Any deviation jumps to .fail (exit 1). Success prints OK and exits 0.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
%define SYS_OPEN        5
%define SYS_CLOSE       7
%define SYS_WRITE_FILE  18
%define SYS_GETUID      29
%define SYS_SETUID      32
%define SYS_CHMOD       34

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
    ; 1. getuid() must be 0 (root).
    mov     rax, SYS_GETUID
    int     0x80
    test    rax, rax
    jnz     .fail

    ; 2. create /tmp/sec (O_CREAT), keep fd in rbx.
    lea     rdi, [rel secpath]
    mov     rsi, O_CREAT
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    js      .fail               ; negative fd => failure
    mov     rbx, rax            ; rbx = fd

    ; write payload to the new file (we own it, mode 0644 => owner write OK).
    mov     rdi, rbx
    lea     rsi, [rel payload]
    mov     rdx, payload_len
    mov     rax, SYS_WRITE_FILE
    int     0x80
    cmp     rax, payload_len
    jne     .fail

    ; close it.
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80

    ; 3. chmod 0600 (octal) = 384 decimal. Owner rw, group/other nothing.
    lea     rdi, [rel secpath]
    mov     rsi, 384            ; 0o600
    mov     rax, SYS_CHMOD
    int     0x80
    test    rax, rax
    jnz     .fail

    ; 4. drop privilege to uid 1000.
    mov     rdi, 1000
    mov     rax, SYS_SETUID
    int     0x80
    test    rax, rax
    jnz     .fail

    ; 5. getuid() must now be 1000.
    mov     rax, SYS_GETUID
    int     0x80
    cmp     rax, 1000
    jne     .fail

    ; 6. opening our now-foreign file for read must be DENIED (negative).
    lea     rdi, [rel secpath]
    xor     rsi, rsi            ; flags = 0 (open existing for read)
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    jns     .fail               ; success (non-negative) means DAC failed open

    ; 7. trying to regain root must be DENIED (negative).
    mov     rdi, 0
    mov     rax, SYS_SETUID
    int     0x80
    test    rax, rax
    jns     .fail               ; 0 (success) means privilege escalation slipped

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
secpath:     db "/tmp/sec", 0
payload:     db "owned-by-root", 0x0A
payload_len  equ $ - payload
ok_line:     db "[user] usertest: uid/DAC enforced (drop priv + deny) -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] usertest: DAC FAIL", 0x0A
bad_line_len equ $ - bad_line
