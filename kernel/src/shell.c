/* shell.c — Serial shell task * @pattern Strategy
 */

#include "shell.h"
#include "net.h"
#include "pmm.h"
#include "process.h"
#include "console.h"
#include "sched.h"
#include "string.h"
#include "syscall.h"
#include "timer.h"
#include "vfs.h"
#include "kheap.h"

#define SHELL_LINE_MAX 256
#define SHELL_ARGV_MAX 16

static char line_buf[SHELL_LINE_MAX];
static size_t line_len;
static int prompt_shown;

static void shell_prompt(void) {
    if (!prompt_shown) {
        console_print("khy> ");
        prompt_shown = 1;
    }
}

static int is_space(char c) {
    return c == ' ' || c == '\t';
}

static int is_printable(char c) {
    return c >= 32 && c <= 126;
}

static void print_u64_hex_or_dash(uint32_t v) {
    if (v == (uint32_t)-1) {
        console_print("-");
    } else {
        console_print_dec(v);
    }
}

static void cmd_help(void) {
    console_print("Commands:\n");
    console_print("  help              - Show this help\n");
    console_print("  ps                - List processes\n");
    console_print("  mem               - Show memory and uptime\n");
    console_print("  ls [path]         - List directory (default /)\n");
    console_print("  cat <path>        - Print file\n");
    console_print("  write <p> <txt>   - Overwrite file with text\n");
    console_print("  append <p> <txt>  - Append text to file\n");
    console_print("  run <elf-path>    - Load ELF into user address space\n");
    console_print("  netstat           - Show network counters\n");
    console_print("  netsend <txt>     - Send loopback packet\n");
    console_print("  netrecv           - Receive one loopback packet\n");
    console_print("  syscalltest       - Test int 0x80 path\n");
}

static void cmd_ps(void) {
    struct process_info list[PROCESS_MAX];
    size_t n = process_list(list, PROCESS_MAX);
    console_print("PID   TID   TYPE   STATE    ENTRY\n");
    for (size_t i = 0; i < n; i++) {
        console_print_dec(list[i].pid);
        console_print("    ");
        print_u64_hex_or_dash(list[i].task_id);
        console_print("    ");
        console_print(list[i].is_user ? "user   " : "kern   ");
        console_print(process_state_string(list[i].state));
        console_print("   ");
        console_print_hex(list[i].entry);
        console_print("  ");
        console_print(list[i].name);
        console_print("\n");
    }
}

static void cmd_mem(void) {
    console_print("Total memory: ");
    console_print_dec(pmm_total_memory() / (1024 * 1024));
    console_print(" MB\n");
    console_print("Free memory : ");
    console_print_dec(pmm_free_memory() / 1024);
    console_print(" KB\n");
    console_print("Uptime ticks: ");
    console_print_dec(timer_get_ticks());
    console_print("\n");
}

static void cmd_ls(const char *path) {
    struct vfs_dirent ents[64];
    int n = vfs_list_dir(path, ents, 64);
    if (n < 0) {
        console_print("ls: cannot open directory\n");
        return;
    }
    for (int i = 0; i < n; i++) {
        console_print(ents[i].type == VFS_NODE_DIR ? "d " : "f ");
        console_print(ents[i].name);
        if (ents[i].type == VFS_NODE_FILE) {
            console_print(" (");
            console_print_dec(ents[i].size);
            console_print(")");
        }
        console_print("\n");
    }
}

static void cmd_cat(const char *path) {
    size_t sz = 0;
    if (vfs_get_size(path, &sz) != 0) {
        console_print("cat: file not found\n");
        return;
    }
    char *buf = (char *)kmalloc(sz + 1);
    if (!buf) {
        console_print("cat: out of memory\n");
        return;
    }
    int n = vfs_read_file(path, buf, sz);
    if (n < 0) {
        console_print("cat: read failed\n");
        kfree(buf);
        return;
    }
    buf[n] = '\0';
    console_print(buf);
    if (n == 0 || buf[n - 1] != '\n')
        console_print("\n");
    kfree(buf);
}

static void cmd_write_like(const char *path, const char *text, int append) {
    if (!path || !text) {
        console_print("write: bad args\n");
        return;
    }
    int rc = vfs_write_file(path, text, strlen(text), append);
    if (rc < 0) {
        console_print("write: failed\n");
        return;
    }
    console_print("ok\n");
}

static void cmd_run(const char *path) {
    if (!path) {
        console_print("run: missing path\n");
        return;
    }
    int pid = process_create_from_elf(path);
    if (pid < 0) {
        console_print("run: ELF load failed\n");
        return;
    }
    console_print("run: loaded pid=");
    console_print_dec((uint64_t)pid);
    console_print(" (execution path pending user-mode switch)\n");
}

static void cmd_netstat(void) {
    struct net_stats st;
    net_get_stats(&st);
    console_print("tx_packets=");
    console_print_dec(st.tx_packets);
    console_print(" rx_packets=");
    console_print_dec(st.rx_packets);
    console_print(" tx_bytes=");
    console_print_dec(st.tx_bytes);
    console_print(" rx_bytes=");
    console_print_dec(st.rx_bytes);
    console_print(" drops=");
    console_print_dec(st.drops);
    console_print("\n");
}

static void cmd_netsend(const char *text) {
    if (!text) {
        console_print("netsend: missing payload\n");
        return;
    }
    int rc = net_send(text, strlen(text));
    if (rc < 0) {
        console_print("netsend: failed\n");
        return;
    }
    console_print("netsend: ");
    console_print_dec((uint64_t)rc);
    console_print(" bytes queued\n");
}

static void cmd_netrecv(void) {
    char buf[NET_MTU + 1];
    int n = net_recv(buf, NET_MTU);
    if (n < 0) {
        console_print("netrecv: error\n");
        return;
    }
    if (n == 0) {
        console_print("netrecv: no packet\n");
        return;
    }
    buf[n] = '\0';
    console_print("netrecv: ");
    console_print_dec((uint64_t)n);
    console_print(" bytes: ");
    console_print(buf);
    console_print("\n");
}

static void cmd_syscalltest(void) {
    const char *msg = "[syscall] hello from int 0x80\n";
    long w = syscall_invoke(SYSCALL_WRITE, (uint64_t)msg, strlen(msg), 0, 0, 0, 0);
    long pid = syscall_invoke(SYSCALL_GETPID, 0, 0, 0, 0, 0, 0);
    long up = syscall_invoke(SYSCALL_UPTIME, 0, 0, 0, 0, 0, 0);
    console_print("syscalltest: write=");
    console_print_dec((uint64_t)w);
    console_print(" pid=");
    console_print_dec((uint64_t)pid);
    console_print(" ticks=");
    console_print_dec((uint64_t)up);
    console_print("\n");
}

static int parse_line(char *line, char *argv[SHELL_ARGV_MAX]) {
    int argc = 0;
    char *p = line;
    while (*p) {
        while (*p && is_space(*p))
            p++;
        if (!*p)
            break;
        if (argc >= SHELL_ARGV_MAX)
            break;
        argv[argc++] = p;
        while (*p && !is_space(*p))
            p++;
        if (*p) {
            *p = '\0';
            p++;
        }
    }
    return argc;
}

static void execute_line(char *line) {
    char *argv[SHELL_ARGV_MAX];
    int argc = parse_line(line, argv);
    if (argc == 0)
        return;

    if (strcmp(argv[0], "help") == 0) {
        cmd_help();
        return;
    }
    if (strcmp(argv[0], "ps") == 0) {
        cmd_ps();
        return;
    }
    if (strcmp(argv[0], "mem") == 0) {
        cmd_mem();
        return;
    }
    if (strcmp(argv[0], "ls") == 0) {
        cmd_ls(argc > 1 ? argv[1] : "/");
        return;
    }
    if (strcmp(argv[0], "cat") == 0) {
        if (argc < 2) {
            console_print("cat: missing path\n");
            return;
        }
        cmd_cat(argv[1]);
        return;
    }
    if (strcmp(argv[0], "write") == 0) {
        if (argc < 3) {
            console_print("write: usage write <path> <text>\n");
            return;
        }
        cmd_write_like(argv[1], argv[2], 0);
        return;
    }
    if (strcmp(argv[0], "append") == 0) {
        if (argc < 3) {
            console_print("append: usage append <path> <text>\n");
            return;
        }
        cmd_write_like(argv[1], argv[2], 1);
        return;
    }
    if (strcmp(argv[0], "run") == 0) {
        cmd_run(argc > 1 ? argv[1] : 0);
        return;
    }
    if (strcmp(argv[0], "netstat") == 0) {
        cmd_netstat();
        return;
    }
    if (strcmp(argv[0], "netsend") == 0) {
        cmd_netsend(argc > 1 ? argv[1] : 0);
        return;
    }
    if (strcmp(argv[0], "netrecv") == 0) {
        cmd_netrecv();
        return;
    }
    if (strcmp(argv[0], "syscalltest") == 0) {
        cmd_syscalltest();
        return;
    }

    console_print("unknown command: ");
    console_print(argv[0]);
    console_print("\n");
}

static void handle_char(char c) {
    if (c == '\r' || c == '\n') {
        console_print("\n");
        line_buf[line_len] = '\0';
        execute_line(line_buf);
        line_len = 0;
        prompt_shown = 0;
        return;
    }

    if (c == 8 || c == 127) {
        if (line_len > 0) {
            line_len--;
            console_print("\b \b");
        }
        return;
    }

    if (!is_printable(c))
        return;
    if (line_len + 1 >= SHELL_LINE_MAX)
        return;

    line_buf[line_len++] = c;
    console_putchar(c);
}

void shell_task(void) {
    console_print("[SHELL] Interactive shell started. type 'help'.\n");
    line_len = 0;
    prompt_shown = 0;

    for (;;) {
        shell_prompt();
        char c;
        if (console_getchar_nonblock(&c))
            handle_char(c);
        yield();
    }
}
