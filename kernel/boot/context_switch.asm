; @pattern Template Method
; context_switch.asm — Task context switch for KHY OS
;
; void context_switch(uint64_t *old_rsp, uint64_t new_rsp)
;   rdi = pointer to old task's saved rsp
;   rsi = new task's saved rsp
;
; Saves callee-saved registers (rbp, rbx, r12-r15) on old stack,
; stores old rsp, loads new rsp, restores registers, and returns
; to the new task's saved return address.

bits 64

section .text
global context_switch

context_switch:
    ; Save callee-saved registers on current (old) stack
    push r15
    push r14
    push r13
    push r12
    push rbx
    push rbp

    ; Save RFLAGS as the lowest saved slot so the interrupt-enable (IF)
    ; flag travels with each task. Required for preemption: a task
    ; preempted by a timer IRQ (IF=0 inside the interrupt gate) must
    ; resume with IF=0, while a task that yielded cooperatively (IF=1)
    ; must resume with IF=1. Without this, IF leaks between contexts.
    pushfq

    ; Save current stack pointer to old task's TCB
    mov [rdi], rsp

    ; Load new task's stack pointer
    mov rsp, rsi

    ; Restore RFLAGS first (mirrors the pushfq above)
    popfq

    ; Restore callee-saved registers from new stack
    pop rbp
    pop rbx
    pop r12
    pop r13
    pop r14
    pop r15

    ; Return to new task (ret pops return address from stack)
    ret

; ================================================================
; task_entry_trampoline — first-time entry point for new tasks
; Called via 'ret' from context_switch when a new task starts.
; r15 = task entry function pointer (set up in initial stack frame)
; ================================================================
global task_entry_trampoline
extern task_exit
task_entry_trampoline:
    ; r15 = task entry function pointer
    ; After context_switch pops 6 regs + ret to here, rsp points into task stack
    ; Ensure 16-byte alignment: rsp should be 16-byte aligned before 'call'
    ; (call pushes 8-byte return addr, so rsp must be 0x...0 before call)
    and rsp, -16
    call r15            ; Call the actual task entry function

    ; The task returned: hand control to task_exit, which marks this task a
    ; zombie and switches away permanently (the scheduler reaps the slot).
    and rsp, -16
    call task_exit

    ; task_exit never returns; halt as a last-resort safety net.
    cli
.hang:
    hlt
    jmp .hang
