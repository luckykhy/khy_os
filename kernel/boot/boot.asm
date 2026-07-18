; @pattern Template Method
; boot.asm — Multiboot2 entry point for KHY OS
; NASM syntax, produces ELF64 object

bits 32

; ================================================================
; Multiboot2 Header
; ================================================================
section .multiboot_header
align 8
header_start:
    dd 0xE85250D6                ; Multiboot2 magic
    dd 0                         ; Architecture: i386 (protected mode)
    dd header_end - header_start ; Header length
    dd -(0xE85250D6 + 0 + (header_end - header_start)) ; Checksum

    ; Framebuffer tag (request text mode 80x25)
    dw 5        ; type = framebuffer
    dw 0        ; flags
    dd 20       ; size
    dd 80       ; width
    dd 25       ; height
    dd 0        ; depth (0 = text mode)

    ; End tag
    align 8
    dw 0        ; type
    dw 0        ; flags
    dd 8        ; size
header_end:

; ================================================================
; Page Tables (identity-map first 2GB using 2MB huge pages)
; ================================================================
section .bss
align 4096

pml4_table:
    resb 4096
pdpt_table:
    resb 4096
pd_table:
    resb 4096

; Kernel stack (16KB)
align 16
stack_bottom:
    resb 16384
stack_top:

; ================================================================
; 32-bit Entry Point
; ================================================================
section .text
global _start
extern long_mode_init

_start:
    ; Save multiboot info pointer (ebx) and magic (eax)
    mov edi, ebx        ; Multiboot2 info struct pointer → edi (preserved into 64-bit)
    mov esi, eax        ; Multiboot2 magic → esi

    ; Set up stack
    mov esp, stack_top

    ; Check for CPUID support
    call check_cpuid
    ; Check for long mode support
    call check_long_mode

    ; Set up page tables
    call setup_page_tables
    ; Enable paging and enter long mode
    call enable_paging

    ; Load 64-bit GDT
    lgdt [gdt64.pointer]

    ; Far jump to 64-bit code segment
    jmp gdt64.code_segment:long_mode_init

    ; Should never reach here
    hlt

; ================================================================
; CPUID Check
; ================================================================
check_cpuid:
    ; Try to flip the ID bit (bit 21) in FLAGS
    pushfd
    pop eax
    mov ecx, eax
    xor eax, 1 << 21
    push eax
    popfd
    pushfd
    pop eax
    push ecx
    popfd
    cmp eax, ecx
    je .no_cpuid
    ret
.no_cpuid:
    mov al, 'C'
    jmp error

; ================================================================
; Long Mode Check
; ================================================================
check_long_mode:
    ; Check if extended CPUID functions are available
    mov eax, 0x80000000
    cpuid
    cmp eax, 0x80000001
    jb .no_long_mode

    ; Check for long mode bit
    mov eax, 0x80000001
    cpuid
    test edx, 1 << 29
    jz .no_long_mode
    ret
.no_long_mode:
    mov al, 'L'
    jmp error

; ================================================================
; Page Table Setup — Identity map first 2GB with 2MB huge pages
; ================================================================
setup_page_tables:
    ; PML4[0] → PDPT
    mov eax, pdpt_table
    or eax, 0b11             ; Present + Writable
    mov [pml4_table], eax

    ; PDPT[0] → PD
    mov eax, pd_table
    or eax, 0b11             ; Present + Writable
    mov [pdpt_table], eax

    ; PD[0..511] → 2MB huge pages (identity map 0-1GB)
    mov ecx, 0
.map_pd:
    mov eax, 0x200000        ; 2MB per page
    mul ecx
    or eax, 0b10000011       ; Present + Writable + Huge Page
    mov [pd_table + ecx * 8], eax
    inc ecx
    cmp ecx, 512
    jne .map_pd

    ret

; ================================================================
; Enable Paging (PAE + Long Mode + PG)
; ================================================================
enable_paging:
    ; Load PML4 into CR3
    mov eax, pml4_table
    mov cr3, eax

    ; Enable PAE (bit 5 of CR4)
    mov eax, cr4
    or eax, 1 << 5
    mov cr4, eax

    ; Enable long mode (EFER.LME, bit 8) and the no-execute bit (EFER.NXE,
    ; bit 11). NXE is required before any page table may set the NX bit (63);
    ; without it an NX PTE faults as a reserved-bit violation. The VMM marks
    ; user stacks and data pages NO_EXEC (W^X), so NXE must be on.
    mov ecx, 0xC0000080
    rdmsr
    or eax, (1 << 8) | (1 << 11)
    wrmsr

    ; Enable paging (bit 31 of CR0)
    mov eax, cr0
    or eax, 1 << 31
    mov cr0, eax

    ret

; ================================================================
; Error Handler — prints "ERR: X" to VGA and halts
; ================================================================
error:
    ; al contains the error code character
    mov dword [0xB8000], 0x4F524F45  ; "ER" red on white
    mov dword [0xB8004], 0x4F3A4F52  ; "R:" red on white
    mov dword [0xB8008], 0x4F204F20  ; "  "
    mov byte  [0xB800A], al          ; Error code character
    hlt

; ================================================================
; 64-bit GDT
; ================================================================
section .rodata
align 16
gdt64:
    dq 0                                    ; Null descriptor
.code_segment: equ $ - gdt64
    dq (1 << 43) | (1 << 44) | (1 << 47) | (1 << 53) ; Code segment: executable, code, present, 64-bit
.data_segment: equ $ - gdt64
    dq (1 << 44) | (1 << 47) | (1 << 41)   ; Data segment: code/data, present, writable
.pointer:
    dw $ - gdt64 - 1   ; GDT length
    dq gdt64            ; GDT address
