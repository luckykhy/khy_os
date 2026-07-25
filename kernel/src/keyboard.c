/* keyboard.c — PS/2 keyboard driver for KHY OS * @pattern Adapter
 *
 * Reads scancode set 1 from the i8042 controller on IRQ1, translates make
 * codes to ASCII honoring Shift/CapsLock/Ctrl, and pushes the result into a
 * lock-free single-producer/single-consumer ring buffer. The IRQ handler is
 * the sole producer; the shell task is the sole consumer.
 */

#include "keyboard.h"
#include "pic.h"
#include "process.h"

/* PS/2 controller I/O ports */
#define PS2_DATA    0x60  /* read: scancode / write: device command */
#define PS2_STATUS  0x64  /* read: status register */

/* Scancode set 1 make codes for the modifier keys we track */
#define SC_LSHIFT   0x2A
#define SC_RSHIFT   0x36
#define SC_CTRL     0x1D
#define SC_CAPS     0x3A
#define SC_EXTENDED 0xE0  /* prefix byte for extended (E0) keys */
#define SC_BREAK    0x80  /* bit set on break (key-release) codes */

/* Input ring buffer. Size must be a power of two for the cheap mask wrap. */
#define KBD_BUF_SIZE 128
#define KBD_BUF_MASK (KBD_BUF_SIZE - 1)

static char kbd_buf[KBD_BUF_SIZE];
static volatile uint32_t kbd_head; /* producer (IRQ) write index */
static volatile uint32_t kbd_tail; /* consumer (shell) read index */

/* Modifier state */
static int shift_down;
static int ctrl_down;
static int caps_lock;
static int extended;   /* set after an 0xE0 prefix, consumed by next byte */

static inline uint8_t inb(uint16_t port) {
    uint8_t ret;
    __asm__ volatile("inb %1, %0" : "=a"(ret) : "Nd"(port));
    return ret;
}

/* US QWERTY scancode set 1 → ASCII, unshifted. 0 = no printable mapping. */
static const char scancode_ascii[128] = {
    0,    27,  '1', '2', '3', '4', '5', '6', '7', '8', /* 0x00-0x09 */
    '9', '0', '-', '=', '\b', '\t', 'q', 'w', 'e', 'r', /* 0x0A-0x13 */
    't', 'y', 'u', 'i', 'o', 'p', '[', ']', '\n', 0,    /* 0x14-0x1D (0x1D=Ctrl) */
    'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';',   /* 0x1E-0x27 */
    '\'', '`', 0,  '\\', 'z', 'x', 'c', 'v', 'b', 'n',  /* 0x28-0x31 (0x2A=LShift) */
    'm', ',', '.', '/', 0,   '*', 0,   ' ', 0,   0,     /* 0x32-0x3B (0x36=RShift,0x3A=Caps) */
    0,   0,   0,   0,   0,   0,   0,   0,   0,   0,      /* 0x3C-0x45 */
    0,   0,   0,   0,   0,   0,   0,   0,   0,   0,      /* 0x46-0x4F */
    0,   0,   0,   0,   0,   0,   0,   0,   0,   0,      /* 0x50-0x59 */
    0,   0,   0,   0,   0,   0,   0,   0,   0,   0,      /* 0x5A-0x63 */
    0,   0,   0,   0,   0,   0,   0,   0,   0,   0,      /* 0x64-0x6D */
    0,   0,   0,   0,   0,   0,   0,   0,   0,   0,      /* 0x6E-0x77 */
    0,   0,   0,   0,   0,   0,   0,   0,               /* 0x78-0x7F */
};

/* US QWERTY scancode set 1 → ASCII, shifted. 0 = no printable mapping. */
static const char scancode_ascii_shift[128] = {
    0,    27,  '!', '@', '#', '$', '%', '^', '&', '*', /* 0x00-0x09 */
    '(', ')', '_', '+', '\b', '\t', 'Q', 'W', 'E', 'R', /* 0x0A-0x13 */
    'T', 'Y', 'U', 'I', 'O', 'P', '{', '}', '\n', 0,    /* 0x14-0x1D */
    'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ':',   /* 0x1E-0x27 */
    '"', '~', 0,  '|', 'Z', 'X', 'C', 'V', 'B', 'N',    /* 0x28-0x31 */
    'M', '<', '>', '?', 0,   '*', 0,   ' ', 0,   0,     /* 0x32-0x3B */
    0,   0,   0,   0,   0,   0,   0,   0,   0,   0,      /* 0x3C-0x45 */
    0,   0,   0,   0,   0,   0,   0,   0,   0,   0,      /* 0x46-0x4F */
    0,   0,   0,   0,   0,   0,   0,   0,   0,   0,      /* 0x50-0x59 */
    0,   0,   0,   0,   0,   0,   0,   0,   0,   0,      /* 0x5A-0x63 */
    0,   0,   0,   0,   0,   0,   0,   0,   0,   0,      /* 0x64-0x6D */
    0,   0,   0,   0,   0,   0,   0,   0,   0,   0,      /* 0x6E-0x77 */
    0,   0,   0,   0,   0,   0,   0,   0,               /* 0x78-0x7F */
};

static int is_alpha(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

static void kbd_push(char c) {
    uint32_t next = (kbd_head + 1) & KBD_BUF_MASK;
    if (next == kbd_tail)
        return; /* buffer full → drop, never block the IRQ */
    kbd_buf[kbd_head] = c;
    kbd_head = next;
}

/* Push a NUL-terminated byte sequence. Used to emit VT100/ANSI escape
 * sequences for the extended navigation keys so the shell's line editor sees
 * the exact same input a real serial terminal would send (e.g. ESC [ A for
 * Up). On a full buffer the tail bytes are dropped by kbd_push; worst case is
 * a truncated escape, which the shell parser harmlessly discards. */
static void kbd_push_str(const char *s) {
    while (*s)
        kbd_push(*s++);
}

/* Translate an extended (0xE0-prefixed) make code to a VT100 escape sequence.
 * Returns NULL for codes we don't map (e.g. PgUp/PgDn/keypad). */
static const char *extended_escape(uint8_t code) {
    switch (code) {
    case 0x48: return "\x1b[A"; /* Up    */
    case 0x50: return "\x1b[B"; /* Down  */
    case 0x4D: return "\x1b[C"; /* Right */
    case 0x4B: return "\x1b[D"; /* Left  */
    case 0x47: return "\x1b[H"; /* Home  */
    case 0x4F: return "\x1b[F"; /* End   */
    case 0x53: return "\x1b[3~";/* Delete*/
    default:   return 0;
    }
}

void keyboard_init(void) {
    kbd_head = 0;
    kbd_tail = 0;
    shift_down = 0;
    ctrl_down = 0;
    caps_lock = 0;
    extended = 0;
}

void keyboard_handler(void) {
    /* Always drain the data port exactly once, even if we end up ignoring the
     * byte — leaving it unread wedges the controller and stops further IRQs. */
    uint8_t sc = inb(PS2_DATA);

    /* Extended-key prefix: remember it and skip translation of this byte. The
     * following byte (arrows / keypad / right-ctrl etc.) is consumed but not
     * mapped to ASCII in this pass. */
    if (sc == SC_EXTENDED) {
        extended = 1;
        pic_send_eoi(1);
        return;
    }
    if (extended) {
        extended = 0;
        /* Only navigation make codes emit a sequence; break codes (0x80 bit)
         * and unmapped keys are consumed silently. */
        if (!(sc & SC_BREAK)) {
            const char *esc = extended_escape(sc & 0x7F);
            if (esc)
                kbd_push_str(esc);
        }
        pic_send_eoi(1);
        return;
    }

    int is_break = (sc & SC_BREAK) != 0;
    uint8_t code = sc & 0x7F;

    /* Modifier key state tracking */
    if (code == SC_LSHIFT || code == SC_RSHIFT) {
        shift_down = !is_break;
        pic_send_eoi(1);
        return;
    }
    if (code == SC_CTRL) {
        ctrl_down = !is_break;
        pic_send_eoi(1);
        return;
    }
    if (code == SC_CAPS) {
        if (!is_break)
            caps_lock = !caps_lock; /* toggle on make only */
        pic_send_eoi(1);
        return;
    }

    /* Only make codes produce characters */
    if (is_break) {
        pic_send_eoi(1);
        return;
    }

    /* CapsLock affects letters only: for alpha keys the effective shift is
     * (shift XOR caps); for every other key only the real shift applies. */
    int effective_shift = shift_down;
    if (caps_lock && is_alpha(scancode_ascii[code]))
        effective_shift = shift_down ^ 1;

    char ch = effective_shift ? scancode_ascii_shift[code]
                              : scancode_ascii[code];

    if (ch) {
        /* Ctrl combines with letters to yield control codes (Ctrl-A=0x01 …). */
        if (ctrl_down && is_alpha(ch)) {
            char upper = (ch >= 'a' && ch <= 'z') ? (char)(ch - 'a' + 'A') : ch;
            ch = (char)(upper - 'A' + 1);
        }
        /* Ctrl-C (0x03) is the terminal INTR character: raise SIGINT on the
         * foreground program so even a CPU-bound loop that never calls read() is
         * interrupted (delivered on the IRQ return-to-user path). The byte is
         * still buffered so a program blocked in read() returns promptly and the
         * signal is delivered on its syscall return; the pending bit is
         * idempotent, so the two paths cannot double-deliver. With no foreground
         * program (shell at its prompt) the byte is left for the line editor. */
        if (ch == 0x03) {
            uint32_t fg = process_foreground();
            if (fg != 0)
                process_raise_signal(fg, PROCESS_SIGINT);
        }
        kbd_push(ch);
    }

    pic_send_eoi(1);
}

int keyboard_getchar_nonblock(char *out) {
    if (!out)
        return 0;
    if (kbd_tail == kbd_head)
        return 0; /* empty */
    *out = kbd_buf[kbd_tail];
    kbd_tail = (kbd_tail + 1) & KBD_BUF_MASK;
    return 1;
}
