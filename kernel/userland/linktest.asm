; linktest.asm — KHY OS symbolic-link test (Phase 17). Proves a Ring 3 program
; can create, read, follow, and delete symbolic links, and that the kernel
; dereferences links transparently for ordinary path operations while still
; letting unlink/readlink act on the link itself. A toy kernel has no symlinks;
; a real OS treats them as first-class objects with loop-safe resolution.
;
; Sequence (all from Ring 3 via int 0x80; paths are relative to the cwd):
;   1.  getcwd()                         -> "/"   (launched at root)
;   2.  chdir("/tmp")                    -> 0
;   3.  open("target.txt",O_CREAT); close            (creates /tmp/target.txt)
;   4.  symlink(target="target.txt", link="mylink")  -> 0
;   5.  readlink("mylink")               -> 10, buffer == "target.txt"
;   6.  open("mylink", rd)               -> fd>=0  (FOLLOWS link to the file)
;   7.  mkdir("sub"); symlink("sub","dlink"); chdir("dlink")
;       getcwd()                         -> "/tmp/sub" (link-to-dir followed,
;                                            cwd is the canonical target path)
;   8.  chdir("/tmp")                    -> 0
;   9.  unlink("target.txt")             -> 0       (remove the link's target)
;   10. open("mylink", rd)               -> -1      (dangling link: target gone)
;   11. readlink("mylink")               -> 10      (the link itself survives)
;   12. symlink("loop","loop"); open("loop",rd) -> -1   (ELOOP, loop-capped)
;   13. unlink("mylink"); unlink("loop"); unlink("dlink"); rmdir("sub") -> 0
; Any deviation jumps to .fail (exit 1). Success prints OK and exits 0.
;
; Syscall ABI (src/syscall.c): rax = number, rdi/rsi/rdx = args, ret in rax.
; symlink: rdi = target, rsi = linkpath.  readlink: rdi = path, rsi = buf, rdx = len.

bits 64

%define SYS_WRITE       1
%define SYS_EXIT        2
%define SYS_OPEN        5
%define SYS_CLOSE       7
%define SYS_CHDIR       36
%define SYS_GETCWD      37
%define SYS_MKDIR       38
%define SYS_RMDIR       39
%define SYS_UNLINK      40
%define SYS_SYMLINK     41
%define SYS_READLINK    42

%define O_CREAT         1

%macro WRITE 2
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_WRITE
    int     0x80
%endmacro

; Invoke a one-path syscall and require the result == 0.
%macro CALL1_ZERO 2
    lea     rdi, [rel %2]
    mov     rax, %1
    int     0x80
    test    rax, rax
    jnz     .fail
%endmacro

; Invoke a one-path syscall and require the result < 0 (must be rejected).
%macro CALL1_NEG 2
    lea     rdi, [rel %2]
    mov     rax, %1
    int     0x80
    test    rax, rax
    jns     .fail
%endmacro

; symlink(target, linkpath) and require == 0.
%macro SYMLINK_ZERO 2
    lea     rdi, [rel %1]
    lea     rsi, [rel %2]
    mov     rax, SYS_SYMLINK
    int     0x80
    test    rax, rax
    jnz     .fail
%endmacro

; open(path, flags) and require fd >= 0; close it.
%macro OPEN_OK_CLOSE 2
    lea     rdi, [rel %1]
    mov     rsi, %2
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    js      .fail
    mov     rdi, rax
    mov     rax, SYS_CLOSE
    int     0x80
%endmacro

; open(path, rd) and require it is REJECTED (fd < 0).
%macro OPEN_NEG 1
    lea     rdi, [rel %1]
    xor     rsi, rsi
    mov     rax, SYS_OPEN
    int     0x80
    test    rax, rax
    jns     .fail
%endmacro

section .text
global _start

_start:
    ; 1. getcwd() must be "/".
    lea     rdi, [rel cwdbuf]
    mov     rsi, 64
    mov     rax, SYS_GETCWD
    int     0x80
    cmp     rax, 1
    jne     .fail
    cmp     byte [rel cwdbuf], '/'
    jne     .fail

    CALL1_ZERO SYS_CHDIR, tmppath          ; 2. chdir /tmp

    OPEN_OK_CLOSE targetname, O_CREAT      ; 3. create /tmp/target.txt

    SYMLINK_ZERO targetname, linkname      ; 4. symlink target.txt <- mylink

    ; 5. readlink("mylink") -> 10 bytes == "target.txt".
    lea     rdi, [rel linkname]
    lea     rsi, [rel linkbuf]
    mov     rdx, 64
    mov     rax, SYS_READLINK
    int     0x80
    cmp     rax, 10
    jne     .fail
    cmp     byte [rel linkbuf], 't'
    jne     .fail
    cmp     byte [rel linkbuf + 6], '.'
    jne     .fail

    OPEN_OK_CLOSE linkname, 0              ; 6. open mylink (follows to target)

    ; 7. symlink to a directory; chdir through it; canonical cwd == "/tmp/sub".
    CALL1_ZERO SYS_MKDIR, subname          ;    mkdir sub
    SYMLINK_ZERO subname, dlinkname        ;    symlink sub <- dlink
    CALL1_ZERO SYS_CHDIR, dlinkname        ;    chdir dlink (follows into sub)
    lea     rdi, [rel cwdbuf]
    mov     rsi, 64
    mov     rax, SYS_GETCWD
    int     0x80
    cmp     rax, 8                         ;    "/tmp/sub" is 8 bytes
    jne     .fail
    cmp     byte [rel cwdbuf + 5], 's'     ;    ".../sub", not ".../dlink"
    jne     .fail

    CALL1_ZERO SYS_CHDIR, tmppath          ; 8. back to /tmp

    CALL1_ZERO SYS_UNLINK, targetname      ; 9. remove the link's target

    OPEN_NEG linkname                      ; 10. mylink now dangles -> rejected

    ; 11. the link itself still exists: readlink still returns its target text.
    lea     rdi, [rel linkname]
    lea     rsi, [rel linkbuf]
    mov     rdx, 64
    mov     rax, SYS_READLINK
    int     0x80
    cmp     rax, 10
    jne     .fail

    ; 12. a self-referential link must be refused on traversal (ELOOP), not hang.
    SYMLINK_ZERO loopname, loopname        ;     loop -> loop
    OPEN_NEG loopname                      ;     open(loop) -> ELOOP -> rejected

    ; 13. clean up every node created above.
    CALL1_ZERO SYS_UNLINK, linkname        ;     unlink mylink
    CALL1_ZERO SYS_UNLINK, loopname        ;     unlink loop
    CALL1_ZERO SYS_UNLINK, dlinkname       ;     unlink dlink (the link, not sub)
    CALL1_ZERO SYS_RMDIR,  subname         ;     rmdir sub (now unreferenced)

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
tmppath:     db "/tmp", 0
targetname:  db "target.txt", 0
linkname:    db "mylink", 0
subname:     db "sub", 0
dlinkname:   db "dlink", 0
loopname:    db "loop", 0
ok_line:     db "[user] linktest: symlink create/read/follow/loop -> OK", 0x0A
ok_line_len  equ $ - ok_line
bad_line:    db "[user] linktest: LINK FAIL", 0x0A
bad_line_len equ $ - bad_line

section .bss
cwdbuf:      resb 64
linkbuf:     resb 64
