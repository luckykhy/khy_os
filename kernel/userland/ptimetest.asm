; ptimetest.asm — KHY OS timestamp-persistence test (Phase 30). Proves a file's
; mtime survives a reboot rather than being reborn as "now" at mount.
;
; The program is two-phase, selected by whether the marker /disk/pmark exists:
;
;   Phase A (first boot, pmark absent):
;     create /disk/pfile.txt, write "data", fstat it, and store the raw 8-byte
;     st_mtime into /disk/pmark. Print SETUP and exit 0. Both files persist to
;     KhyFS via the /disk write hooks.
;
;   Phase B (second boot, pmark present):
;     read the stored mtime back from /disk/pmark, fstat /disk/pfile.txt, and
;     assert its st_mtime is BYTE-IDENTICAL to the stored value. A broken
;     implementation would re-stamp the replayed file with the boot-2 wall clock
;     — seconds later than boot 1, well past RTC's 1-second granularity — so the
;     comparison fails. On success clean up both files, print OK, exit 0.
;
; struct khy_stat (src/syscall.h, 48-byte layout): st_mtime@24.
; Syscall ABI: rax = number, rdi/rsi/rdx = args, ret in rax. int 0x80 preserves
; every GP register except rax, so fd/stored-mtime survive in rbx/r13/r14. NOTE:
; the syscall return does NOT set CPU flags (iret restores the caller's RFLAGS),
; so every error branch does an explicit `test rax, rax` before `js` rather than
; relying on a sign flag the syscall never touched.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
%define SYS_OPEN        5
%define SYS_READ        6
%define SYS_CLOSE       7
%define SYS_WRITE_FILE  18
%define SYS_CHDIR       36
%define SYS_UNLINK      40
%define SYS_FSTAT       47

%define O_CREAT         1
%define ST_MTIME        24          ; byte offset of st_mtime within struct khy_stat

%define EPOCH_LO        1700000000  ; 2023-11-14
%define EPOCH_HI        4102444800  ; 2100-01-01

%macro WRITE 2
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_WRITE
    int     0x80
%endmacro

section .text
global _start

_start:
    sub     rsp, 128
    mov     r15, rsp                   ; r15 -> 48-byte stat buffer
    lea     r12, [rsp + 64]            ; r12 -> 8-byte time scratch

    ; chdir /disk (the persistent subtree)
    lea     rdi, [rel diskdir]
    mov     rax, SYS_CHDIR
    int     0x80
    test    rax, rax
    jnz     fail

    ; Phase select: try to open the marker read-only (flags = 0).
    lea     rdi, [rel pmark]
    xor     rsi, rsi
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    js      phase_a                    ; negative -> marker absent -> first boot
    mov     rbx, rax                   ; rbx = pmark fd, fall into Phase B

; ── Phase B: verify the persisted mtime ────────────────────────────────────
phase_b:
    ; read the 8 stored mtime bytes from pmark
    mov     rdi, rbx
    mov     rsi, r12
    mov     rdx, 8
    mov     rax, SYS_READ
    int     0x80
    cmp     rax, 8
    jne     fail
    mov     r13, [r12]                 ; r13 = expected mtime (from boot 1)

    mov     rdi, rbx                   ; close pmark
    mov     rax, SYS_CLOSE
    int     0x80

    ; open pfile.txt (read-only) and fstat it
    lea     rdi, [rel pfile]
    xor     rsi, rsi
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    js      fail
    mov     rbx, rax
    mov     rdi, rbx
    mov     rsi, r15
    mov     rax, SYS_FSTAT
    int     0x80
    test    rax, rax
    jnz     fail
    mov     r14, [r15 + ST_MTIME]      ; r14 = mtime after reboot

    ; sanity: a plausible epoch value, not a zeroed/garbage stamp
    mov     rcx, EPOCH_LO
    cmp     r14, rcx
    jb      fail
    mov     rcx, EPOCH_HI
    cmp     r14, rcx
    jae     fail

    ; the load-bearing assertion: persisted mtime survived byte-for-byte
    cmp     r14, r13
    jne     fail

    ; cleanup so the test is repeatable on the next fresh disk
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80
    lea     rdi, [rel pfile]
    mov     rax, SYS_UNLINK
    int     0x80
    lea     rdi, [rel pmark]
    mov     rax, SYS_UNLINK
    int     0x80

    WRITE   ok_line, ok_line_len
    add     rsp, 128
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

; ── Phase A: create the file and record its mtime for the next boot ─────────
phase_a:
    ; create pfile.txt and write "data"
    lea     rdi, [rel pfile]
    mov     rsi, O_CREAT
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    js      fail
    mov     rbx, rax                   ; rbx = pfile fd
    mov     rdi, rbx
    lea     rsi, [rel payload]
    mov     rdx, 4
    mov     rax, SYS_WRITE_FILE
    int     0x80
    cmp     rax, 4
    jne     fail

    ; fstat -> capture st_mtime
    mov     rdi, rbx
    mov     rsi, r15
    mov     rax, SYS_FSTAT
    int     0x80
    test    rax, rax
    jnz     fail
    mov     r13, [r15 + ST_MTIME]
    mov     [r12], r13                 ; stash the 8 raw bytes for writing

    ; sanity: it must already be a real epoch stamp this boot
    mov     rcx, EPOCH_LO
    cmp     r13, rcx
    jb      fail

    mov     rdi, rbx                   ; close pfile
    mov     rax, SYS_CLOSE
    int     0x80

    ; create the marker and write the 8-byte mtime into it
    lea     rdi, [rel pmark]
    mov     rsi, O_CREAT
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    js      fail
    mov     rbx, rax
    mov     rdi, rbx
    mov     rsi, r12
    mov     rdx, 8
    mov     rax, SYS_WRITE_FILE
    int     0x80
    cmp     rax, 8
    jne     fail
    mov     rdi, rbx
    mov     rax, SYS_CLOSE
    int     0x80

    WRITE   setup_line, setup_line_len
    add     rsp, 128
    xor     rdi, rdi
    mov     rax, SYS_EXIT
    int     0x80

fail:
    WRITE   bad_line, bad_line_len
    mov     rdi, 1
    mov     rax, SYS_EXIT
    int     0x80

section .rodata
diskdir:       db "/disk", 0
pfile:         db "/disk/pfile.txt", 0
pmark:         db "/disk/pmark", 0
payload:       db "data"
setup_line:    db "[user] ptimetest: file created, mtime stored, reboot to verify -> SETUP", 0x0A
setup_line_len equ $ - setup_line
ok_line:       db "[user] ptimetest: mtime survived reboot byte-for-byte -> OK", 0x0A
ok_line_len    equ $ - ok_line
bad_line:      db "[user] ptimetest: PERSIST TIME FAIL", 0x0A
bad_line_len   equ $ - bad_line
