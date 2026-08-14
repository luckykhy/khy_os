; @pattern Template Method
; usermode.asm — Ring 3 entry via iretq
;
; void enter_usermode(uint64_t user_rip, uint64_t user_rsp)
;   rdi = user code entry point
;   rsi = user stack pointer
;
; Constructs an iretq frame to jump to Ring 3 (CPL=3).
; Stack frame for iretq (pushed high to low):
;   SS     = 0x23  (User Data | RPL=3)
;   RSP    = user_rsp
;   RFLAGS = 0x202 (IF=1, reserved bit 1)
;   CS     = 0x1B  (User Code | RPL=3)
;   RIP    = user_rip

bits 64

section .text
global enter_usermode

enter_usermode:
    ; Clear all general-purpose registers for a clean entry
    xor rax, rax
    xor rbx, rbx
    xor rcx, rcx
    xor rdx, rdx
    xor rbp, rbp
    xor r8,  r8
    xor r9,  r9
    xor r10, r10
    xor r11, r11
    xor r12, r12
    xor r13, r13
    xor r14, r14
    xor r15, r15

    ; Build iretq frame on the current (kernel) stack
    push 0x23           ; SS  = User Data selector (0x20 | RPL=3)
    push rsi            ; RSP = user stack pointer
    push 0x202          ; RFLAGS = IF=1 + reserved bit 1
    push 0x1B           ; CS  = User Code selector (0x18 | RPL=3)
    push rdi            ; RIP = user entry point

    ; Transition to Ring 3
    iretq

; ================================================================
; void iret_to_user_context(const struct user_context *ctx)  [rdi = ctx]
;
; Resume a forked child in Ring 3 with the parent's exact register state. Loads
; every GP register from ctx and iretq's to ctx->rip with ctx's rsp/rflags/
; segment selectors. ctx->rax is the child's fork() return value (0). The field
; offsets MUST match struct user_context in src/sched.h.
; ================================================================
global iret_to_user_context
iret_to_user_context:
    ; Build the iretq frame from ctx (rax is scratch here; reloaded below).
    mov rax, [rdi + 152]   ; ss
    push rax
    mov rax, [rdi + 144]   ; user_rsp
    push rax
    mov rax, [rdi + 136]   ; rflags
    push rax
    mov rax, [rdi + 128]   ; cs
    push rax
    mov rax, [rdi + 120]   ; rip
    push rax

    ; Load the saved general-purpose registers (rdi loaded last — it is our
    ; pointer to ctx, so everything else must be read first).
    mov r15, [rdi + 0]
    mov r14, [rdi + 8]
    mov r13, [rdi + 16]
    mov r12, [rdi + 24]
    mov r11, [rdi + 32]
    mov r10, [rdi + 40]
    mov r9,  [rdi + 48]
    mov r8,  [rdi + 56]
    mov rbp, [rdi + 64]
    mov rsi, [rdi + 80]
    mov rdx, [rdi + 88]
    mov rcx, [rdi + 96]
    mov rbx, [rdi + 104]
    mov rax, [rdi + 112]   ; child's fork() return value (0)
    mov rdi, [rdi + 72]    ; rdi LAST

    iretq
