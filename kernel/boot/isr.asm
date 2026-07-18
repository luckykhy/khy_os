; @pattern Template Method
; isr.asm — Interrupt Service Routine stubs for KHY OS
; These stubs save state, call C handlers, restore state, and iretq.

bits 64

section .text

; External C handlers
extern exception_handler
extern irq_dispatch
extern irq_return_deliver_signals
extern syscall_dispatch_frame

; ================================================================
; Macro for ISR without error code (CPU pushes no error code)
; ================================================================
%macro ISR_NOERR 1
global isr%1
isr%1:
    push 0              ; Push dummy error code
    push %1             ; Push interrupt vector number
    jmp isr_common_stub
%endmacro

; ================================================================
; Macro for ISR with error code (CPU pushes error code automatically)
; ================================================================
%macro ISR_ERR 1
global isr%1
isr%1:
    ; Error code already pushed by CPU
    push %1             ; Push interrupt vector number
    jmp isr_common_stub
%endmacro

; ================================================================
; Macro for IRQ stub
; ================================================================
%macro IRQ 2
global irq%1
irq%1:
    push 0              ; Dummy error code
    push %2             ; Push IRQ number (0-15)
    jmp irq_common_stub
%endmacro

; ================================================================
; Exception ISR Stubs (vectors 0-19)
; ================================================================
ISR_NOERR 0   ; #DE Division Error
ISR_NOERR 1   ; #DB Debug
ISR_NOERR 2   ; NMI
ISR_NOERR 3   ; #BP Breakpoint
ISR_NOERR 4   ; #OF Overflow
ISR_NOERR 5   ; #BR Bound Range
ISR_NOERR 6   ; #UD Invalid Opcode
ISR_NOERR 7   ; #NM Device Not Available
ISR_ERR   8   ; #DF Double Fault
ISR_NOERR 9   ; Coprocessor Segment Overrun
ISR_ERR   10  ; #TS Invalid TSS
ISR_ERR   11  ; #NP Segment Not Present
ISR_ERR   12  ; #SS Stack Fault
ISR_ERR   13  ; #GP General Protection
ISR_ERR   14  ; #PF Page Fault
ISR_NOERR 15  ; Reserved
ISR_NOERR 16  ; #MF x87 FP Exception
ISR_ERR   17  ; #AC Alignment Check
ISR_NOERR 18  ; #MC Machine Check
ISR_NOERR 19  ; #XM SIMD FP Exception

; ================================================================
; IRQ Stubs (IRQ 0-15 → vectors 32-47)
; ================================================================
IRQ 0,  0   ; PIT Timer
IRQ 1,  1   ; Keyboard
IRQ 2,  2   ; Cascade
IRQ 3,  3   ; COM2
IRQ 4,  4   ; COM1
IRQ 5,  5   ; LPT2
IRQ 6,  6   ; Floppy
IRQ 7,  7   ; LPT1 / Spurious
IRQ 8,  8   ; CMOS RTC
IRQ 9,  9   ; Free
IRQ 10, 10  ; Free
IRQ 11, 11  ; Free
IRQ 12, 12  ; PS/2 Mouse
IRQ 13, 13  ; FPU
IRQ 14, 14  ; Primary ATA
IRQ 15, 15  ; Secondary ATA

; ================================================================
; Syscall stub (vector 128 / int 0x80)
; ================================================================
global isr128
isr128:
    push 0
    push 128
    jmp syscall_common_stub

; ================================================================
; Common ISR stub — saves all registers, calls exception_handler
; ================================================================
isr_common_stub:
    ; Stack: [ss, rsp, rflags, cs, rip, error_code, vector]
    ; Save all general-purpose registers
    push rax
    push rbx
    push rcx
    push rdx
    push rsi
    push rdi
    push rbp
    push r8
    push r9
    push r10
    push r11
    push r12
    push r13
    push r14
    push r15

    ; [SAFE] Clear the direction flag before entering any C handler. The CPU does
    ; NOT reset DF on interrupt/exception entry, so a Ring 3 task that ran `std`
    ; (DF=1) and then faulted would have its DF inherited by the kernel. The
    ; System V ABI requires DF=0 on C-function entry; with DF=1 the compiler's
    ; `rep movs`/`rep stos` lowering of memcpy/memset runs BACKWARDS, writing past
    ; the start of kernel buffers — an attacker-steered kernel OOB write. cld
    ; closes that path for every exception originating in untrusted Ring 3.
    cld

    ; Call exception_handler(vector, error_code, rip, cs)
    mov rdi, [rsp + 120]   ; vector (15 pushes * 8 = 120 bytes from top)
    mov rsi, [rsp + 128]   ; error_code
    mov rdx, [rsp + 136]   ; faulting RIP
    mov rcx, [rsp + 144]   ; faulting CS (0x1B => Ring 3, 0x08 => kernel)

    call exception_handler

    ; Restore registers
    pop r15
    pop r14
    pop r13
    pop r12
    pop r11
    pop r10
    pop r9
    pop r8
    pop rbp
    pop rdi
    pop rsi
    pop rdx
    pop rcx
    pop rbx
    pop rax

    ; Remove vector and error code from stack
    add rsp, 16

    iretq

; ================================================================
; Common IRQ stub — saves all registers, calls irq_dispatch
; ================================================================
irq_common_stub:
    ; Stack: [ss, rsp, rflags, cs, rip, dummy_error, irq_num]
    push rax
    push rbx
    push rcx
    push rdx
    push rsi
    push rdi
    push rbp
    push r8
    push r9
    push r10
    push r11
    push r12
    push r13
    push r14
    push r15

    ; [SAFE] Clear DF before the C handler. An IRQ can fire while Ring 3 code is
    ; mid-`std` (DF=1); without this the kernel's memcpy/memset would run
    ; backwards under the attacker's direction flag. See isr_common_stub.
    cld

    ; Call irq_dispatch(irq_num)
    mov rdi, [rsp + 120]   ; irq_num

    call irq_dispatch

    ; On the way back to a Ring 3 task, deliver one pending signal (e.g. a
    ; keyboard-raised Ctrl-C SIGINT) by rewriting this interrupt frame — the same
    ; frame layout the syscall stub hands to the C dispatcher. rsp still points at
    ; the saved r15, the frame base. For a default-terminate signal the callee
    ; switches tasks and never returns here; for a handler it edits rip/rdi/rsp
    ; below so the iretq lands in the user handler.
    mov rdi, rsp
    call irq_return_deliver_signals

    ; Restore registers
    pop r15
    pop r14
    pop r13
    pop r12
    pop r11
    pop r10
    pop r9
    pop r8
    pop rbp
    pop rdi
    pop rsi
    pop rdx
    pop rcx
    pop rbx
    pop rax

    ; Remove irq_num and dummy error code from stack
    add rsp, 16

    iretq

; ================================================================
; Syscall common stub — saves registers and dispatches int 0x80
; ================================================================
syscall_common_stub:
    push rax
    push rbx
    push rcx
    push rdx
    push rsi
    push rdi
    push rbp
    push r8
    push r9
    push r10
    push r11
    push r12
    push r13
    push r14
    push r15

    ; [SAFE] Clear DF before dispatching the syscall. `int 0x80` is the explicit
    ; Ring 3 → Ring 0 boundary: a user can `std` then trap, and DF would carry
    ; into syscall_dispatch_frame and every kernel string op it drives. cld
    ; restores the ABI-mandated DF=0 and blocks the backwards-rep OOB write.
    cld

    ; Pass frame base (saved r15 slot) to C dispatcher
    mov rdi, rsp
    call syscall_dispatch_frame

    ; Return value in rax -> overwrite saved rax in interrupt frame
    mov [rsp + 112], rax

    pop r15
    pop r14
    pop r13
    pop r12
    pop r11
    pop r10
    pop r9
    pop r8
    pop rbp
    pop rdi
    pop rsi
    pop rdx
    pop rcx
    pop rbx
    pop rax

    add rsp, 16
    iretq
