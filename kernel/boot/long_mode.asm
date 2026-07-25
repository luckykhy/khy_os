; @pattern Template Method
; long_mode.asm — 64-bit kernel entry point
; Receives control from boot.asm after switching to long mode

bits 64

section .text
global long_mode_init
extern kernel_main

long_mode_init:
    ; Reload segment registers with data segment
    mov ax, 0x10        ; GDT data segment selector
    mov ds, ax
    mov es, ax
    mov fs, ax
    mov gs, ax
    mov ss, ax

    ; edi already contains multiboot2 info pointer (set in boot.asm)
    ; Zero-extend to 64-bit (upper 32 bits already zero from 32-bit mov)

    ; Call C kernel entry point
    ; First argument (rdi) = multiboot2 info address (already in edi, zero-extended)
    call kernel_main

    ; Halt if kernel_main returns
.hang:
    cli
    hlt
    jmp .hang
