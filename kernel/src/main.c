/* main.c — KHY OS kernel entry point * @pattern Facade
 */

#include "serial.h"
#include "vga.h"
#include "pmm.h"
#include "kheap.h"
#include "idt.h"
#include "pic.h"
#include "timer.h"
#include "gdt.h"
#include "sched.h"
#include "vmm.h"
#include "process.h"
#include "syscall.h"
#include "ipc.h"
#include "capability.h"
#include "pe.h"
#include "wincompat.h"
#include "framebuffer.h"
#include "wm.h"
#include "desktop.h"
#include "ramfs.h"
#include "ata.h"
#include "persist.h"
#include "net.h"
#include "agentbus.h"
#include "vfs_service.h"
#include "net_service.h"
#include "shell.h"
#include "keyboard.h"
#include "mouse.h"
#include "moonbit_bridge.h"
#include "string.h"
#include <stdint.h>

/* Version info. Both may be overridden at build time via
 * -DKHY_OS_VERSION='"x.y.z"' so a distribution build can stamp the real
 * version from a single source of truth; the defaults keep a standalone
 * `make` self-contained. */
#ifndef KHY_OS_VERSION
#define KHY_OS_VERSION "0.1.0"
#endif
#ifndef KHY_OS_CODENAME
#define KHY_OS_CODENAME "Genesis"
#endif

static void cpu_enable_fpu_sse(void) {
    uint64_t cr0;
    uint64_t cr4;

    __asm__ volatile("mov %%cr0, %0" : "=r"(cr0));
    cr0 &= ~(1ULL << 2); /* Clear EM */
    cr0 |= (1ULL << 1);  /* Set MP */
    __asm__ volatile("mov %0, %%cr0" : : "r"(cr0));

    __asm__ volatile("mov %%cr4, %0" : "=r"(cr4));
    cr4 |= (1ULL << 9);   /* OSFXSR */
    cr4 |= (1ULL << 10);  /* OSXMMEXCPT */
    __asm__ volatile("mov %0, %%cr4" : : "r"(cr4));

    __asm__ volatile("clts");
    __asm__ volatile("fninit");
}

/* ── IPC demo tasks ──────────────────────────────────────────── */

static void ipc_server_task(void) {
    /* Register well-known port and serve one request */
    ipc_port_register(IPC_PORT_PROC);
    serial_print("[IPC-DEMO] Server: port 4 registered, waiting for message...\n");

    struct ipc_message msg;
    int rc = ipc_recv(IPC_PORT_PROC, &msg, 0);
    if (rc == IPC_OK) {
        serial_print("[IPC-DEMO] Server: received message from task ");
        serial_print_dec(msg.sender_pid);
        serial_print(", payload='");
        for (uint32_t i = 0; i < msg.payload_len && i < IPC_PAYLOAD_SIZE; i++)
            serial_putchar((char)msg.payload[i]);
        serial_print("'\n");

        /* Send reply */
        struct ipc_message reply;
        memset(&reply, 0, sizeof(reply));
        reply.sender_pid  = (uint16_t)sched_current_id();
        reply.sender_port = IPC_PORT_PROC;
        reply.type        = IPC_MSG_REPLY;
        reply.seq         = msg.seq;
        const char *ack = "ACK";
        reply.payload_len = 3;
        memcpy(reply.payload, ack, 3);
        ipc_send(msg.sender_port, &reply);
        serial_print("[IPC-DEMO] Server: reply sent\n");
    }

    ipc_port_unregister(IPC_PORT_PROC);
    serial_print("[IPC-DEMO] Server: done\n");
    for (;;) yield();
}

static void ipc_client_task(void) {
    /* Give server a moment to register its port */
    yield();
    yield();

    serial_print("[IPC-DEMO] Client: sending request to port 4...\n");

    struct ipc_message request;
    memset(&request, 0, sizeof(request));
    const char *hello = "HELLO-IPC";
    request.payload_len = 9;
    memcpy(request.payload, hello, 9);

    struct ipc_message reply;
    int rc = ipc_call(IPC_PORT_PROC, &request, &reply);
    if (rc == IPC_OK) {
        serial_print("[IPC-DEMO] Client: got reply, payload='");
        for (uint32_t i = 0; i < reply.payload_len && i < IPC_PAYLOAD_SIZE; i++)
            serial_putchar((char)reply.payload[i]);
        serial_print("'\n");
    } else {
        serial_print("[IPC-DEMO] Client: ipc_call failed (rc=");
        serial_print_dec(rc);
        serial_print(")\n");
    }

    serial_print("[IPC-DEMO] Client: done\n");
    for (;;) yield();
}

/* ── Preemption smoke test ───────────────────────────────────────
 * A CPU-bound task that NEVER yields. Under cooperative-only scheduling it
 * starves every other task; if the shell and timer heartbeat keep making
 * progress alongside it, timer-driven preemption is provably working.
 * TODO(verification-only): remove once preemption is confirmed in QEMU. */
static void hog_task(void) {
    uint64_t n = 0;
    for (;;) {
        n++;
        if ((n & 0xFFFFFFF) == 0)
            serial_print("[HOG] alive (never yields)\n");
    }
}

/* ── Kernel entry point ──────────────────────────────────────── */

void kernel_main(uint32_t multiboot_info_addr) {

    /* Initialize serial port for debug output */
    serial_init();

    /* Initialize VGA text mode */
    vga_init();

    /* Boot banner on serial */
    serial_print("\n");
    serial_print("========================================\n");
    serial_print("  KHY OS v" KHY_OS_VERSION " (" KHY_OS_CODENAME ")\n");
    serial_print("  Hybrid Kernel Operating System\n");
    serial_print("  Architecture: x86_64\n");
    serial_print("========================================\n");
    serial_print("\n");
    serial_print("[BOOT] Serial port initialized (COM1 @ 38400 baud)\n");
    serial_print("[BOOT] VGA text mode initialized (80x25)\n");

    cpu_enable_fpu_sse();
    serial_print("[BOOT] FPU/SSE enabled\n");

    /* Boot banner on VGA */
    vga_set_color(VGA_LIGHT_CYAN, VGA_BLACK);
    vga_print("  _  ___  ___   __   ___  ___\n");
    vga_print(" | |/ / || \\ \\ / /  / _ \\/ __|\n");
    vga_print(" | ' <| __ |\\ V /  | (_) \\__ \\\n");
    vga_print(" |_|\\_\\_||_| |_|    \\___/|___/\n");
    vga_print("\n");

    vga_set_color(VGA_WHITE, VGA_BLACK);
    vga_print(" KHY OS v" KHY_OS_VERSION " - Hybrid Kernel OS\n");
    vga_print(" Architecture: x86_64 | Language: C + MoonBit\n");
    vga_print("\n");

    vga_set_color(VGA_LIGHT_GREEN, VGA_BLACK);
    vga_print(" [OK] Serial port initialized\n");
    vga_print(" [OK] VGA display initialized\n");

    /* Phase 2: Physical memory manager */
    pmm_init(multiboot_info_addr);
    vga_print(" [OK] Physical memory manager initialized\n");

    /* Phase 2: Kernel heap */
    kheap_init();
    vga_print(" [OK] Kernel heap initialized\n");

    /* Test PMM: allocate and free a page */
    serial_print("[TEST] PMM alloc/free test...\n");
    uint64_t page1 = pmm_alloc_page();
    uint64_t page2 = pmm_alloc_page();
    serial_print("  Allocated page1 @ ");
    serial_print_hex(page1);
    serial_print("\n");
    serial_print("  Allocated page2 @ ");
    serial_print_hex(page2);
    serial_print("\n");
    pmm_free_page(page1);
    serial_print("  Freed page1\n");
    uint64_t page3 = pmm_alloc_page();
    serial_print("  Re-allocated page3 @ ");
    serial_print_hex(page3);
    serial_print(" (should match page1)\n");
    pmm_free_page(page2);
    pmm_free_page(page3);
    serial_print("[TEST] PMM test passed.\n\n");

    /* Test kheap: malloc/free */
    serial_print("[TEST] Heap alloc/free test...\n");
    char *buf = (char *)kmalloc(128);
    serial_print("  kmalloc(128) @ ");
    serial_print_hex((uint64_t)buf);
    serial_print("\n");
    if (buf) {
        /* Write and verify */
        for (int i = 0; i < 127; i++)
            buf[i] = 'A' + (i % 26);
        buf[127] = '\0';
        serial_print("  Write/read test: OK\n");
        kfree(buf);
        serial_print("  kfree: OK\n");
    }
    serial_print("[TEST] Heap test passed.\n\n");

    /* Phase 3: Interrupt system */
    pic_init();
    serial_print("[BOOT] PIC remapped (IRQ 0-15 → INT 32-47)\n");
    vga_print(" [OK] PIC initialized\n");

    idt_init();
    vga_print(" [OK] IDT loaded\n");

    /* Register timer handler and start PIT */
    irq_register_handler(0, timer_handler);
    timer_init();
    vga_print(" [OK] PIT timer started (100 Hz)\n");

    /* Register PS/2 keyboard handler and unmask IRQ1 */
    keyboard_init();
    irq_register_handler(1, keyboard_handler);
    pic_unmask_irq(1);
    vga_print(" [OK] PS/2 keyboard initialized (IRQ1)\n");

    /* Register PS/2 mouse handler and unmask IRQ12. IRQ12 is on the slave PIC,
     * so IRQ2 (the master's cascade line) must also be unmasked for the slave's
     * interrupts to reach the CPU. Lets the graphical desktop take pointer input
     * (the path a browser viewer drives via QEMU). */
    mouse_init();
    irq_register_handler(12, mouse_handler);
    pic_unmask_irq(2);
    pic_unmask_irq(12);
    vga_print(" [OK] PS/2 mouse initialized (IRQ12)\n");

    /* Phase 4: Virtual memory, GDT, and scheduler/process substrate */
    vmm_init();
    vga_print(" [OK] VMM initialized\n");

    gdt_init();
    vga_print(" [OK] GDT loaded (Ring 0/3 segments + TSS)\n");

    sched_init();
    vga_print(" [OK] Scheduler initialized\n");

    process_init();
    vga_print(" [OK] Process manager initialized\n");

    /* Phase 5: Syscall and core OS services */
    syscall_init();
    vga_print(" [OK] Syscall interface initialized (int 0x80)\n");

    ipc_init();
    vga_print(" [OK] IPC message passing initialized\n");

    cap_init();
    vga_print(" [OK] Capability subsystem initialized\n");

    wincompat_init();
    vga_print(" [OK] Windows API compatibility layer ready\n");

    ramfs_init();
    vga_print(" [OK] RAMFS mounted on /\n");

    /* Persistent block storage: probe the primary IDE master. */
    if (ata_init() == 0) {
        vga_print(" [OK] ATA disk detected (persistent storage)\n");
        /* Layer a persistent filesystem over it and expose it at /disk. */
        if (persist_init() == 0)
            vga_print(" [OK] KhyFS mounted on /disk (survives reboot)\n");
    } else {
        vga_print(" [--] No ATA disk (storage is volatile)\n");
    }

    net_init();
    vga_print(" [OK] Network loopback stack initialized\n");

    /* Agent ⇄ OS control channel on COM2 (separate from the human TTY on COM1). */
    agentbus_init();
    vga_print(" [OK] Agent bridge channel initialized (COM2)\n");

    /* Framebuffer and window manager */
    fb_init(multiboot_info_addr);
    if (fb_is_available()) {
        vga_print(" [OK] Framebuffer initialized\n");
        wm_init();
        vga_print(" [OK] Window manager initialized\n");
    }

    /* Phase 6: MoonBit integration */
    serial_print("\n[BOOT] === MoonBit Integration ===\n");
    moonbit_kernel_run();
    vga_print(" [OK] MoonBit module loaded\n");

    /* IPC demo: server and client exchange a message */
    int srv_tid = sched_create_task(ipc_server_task, "ipc-server");
    int cli_tid = sched_create_task(ipc_client_task, "ipc-client");
    if (srv_tid >= 0) process_register_kernel_task("ipc-server", srv_tid);
    if (cli_tid >= 0) process_register_kernel_task("ipc-client", cli_tid);
    vga_print(" [OK] IPC demo tasks created\n");

    /* Start VFS and NET IPC services (hybrid kernel: in-kernel but IPC-accessible) */
    int vfs_tid = sched_create_task(vfs_service_task, "vfs-service");
    int net_tid = sched_create_task(net_service_task, "net-service");
    if (vfs_tid >= 0) process_register_kernel_task("vfs-service", vfs_tid);
    if (net_tid >= 0) process_register_kernel_task("net-service", net_tid);
    vga_print(" [OK] VFS/NET IPC services started\n");

    /* Agent bridge service task (COM2). Loosely coupled: idle when no host is
     * connected, never blocks the kernel. */
    int agent_tid = sched_create_task(agentbus_task, "agent-bridge");
    if (agent_tid >= 0) process_register_kernel_task("agent-bridge", agent_tid);
    vga_print(" [OK] Agent bridge service started\n");

    /* Start window manager IPC service */
    if (fb_is_available()) {
        int wm_tid = sched_create_task(wm_service_task, "wm-service");
        if (wm_tid >= 0) process_register_kernel_task("wm-service", wm_tid);

        /* Build the live system-monitor desktop: windows whose content tracks
         * real kernel state (memory, processes, IPC ports, uptime), repainted
         * every second by a background task. */
        desktop_start(KHY_OS_VERSION);

        vga_print(" [OK] Live desktop started\n");
    }

    /* Preemption smoke test: a non-yielding CPU hog (verification only) */
    int hog_tid = sched_create_task(hog_task, "hog");
    if (hog_tid >= 0) process_register_kernel_task("hog", hog_tid);

    /* Create shell task */
    int shell_tid = sched_create_task(shell_task, "shell");
    if (shell_tid >= 0) {
        process_register_kernel_task("shell", shell_tid);
        vga_print(" [OK] Shell task created\n");
    } else {
        vga_set_color(VGA_LIGHT_RED, VGA_BLACK);
        vga_print(" [ERR] Failed to create shell task\n");
        vga_set_color(VGA_WHITE, VGA_BLACK);
    }

    /* Enable interrupts after all handlers/services are ready */
    __asm__ volatile("sti");
    serial_print("[BOOT] Interrupts enabled\n");

    /* Enable timer-driven preemption now that the scheduler and all tasks
     * exist. From here a non-yielding task can no longer starve the system. */
    timer_enable_preemption();
    serial_print("[SCHED] Preemptive scheduling enabled (100 Hz)\n");

    /* Pre-installed tool download links */
    serial_print("[INFO] Pre-configured tool links:\n");
    serial_print("  Claude Code : https://docs.anthropic.com/en/docs/claude-code\n");
    serial_print("  Codex CLI   : https://github.com/openai/codex\n");
    serial_print("\n");

    vga_set_color(VGA_YELLOW, VGA_BLACK);
    vga_print("\n All systems operational. Shell is running.\n");

    serial_print("[BOOT] Kernel initialization complete. Entering idle loop.\n");

    /* Idle loop: the timer now preempts us into other tasks, and we also
     * yield cooperatively so the idle task never hogs a quantum. */
    serial_print("[SCHED] Starting preemptive multitasking...\n");
    for (;;) {
        yield();
    }
}
