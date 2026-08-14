/* desktop.h — Live system-monitor desktop for KHY OS
 *
 * Builds the graphical desktop's windows and keeps them reflecting *real*
 * kernel state (memory, processes, IPC ports, uptime) rather than static
 * placeholder text. A background task repaints the live panels once per second.
 * @pattern Observer
 */
#ifndef DESKTOP_H
#define DESKTOP_H

/* Create the desktop windows and spawn the live-monitor task. Requires the
 * window manager to be initialized (fb available). `version` is the kernel
 * version string shown in the terminal panel. No-op if the WM is unavailable. */
void desktop_start(const char *version);

/* Live-monitor task: repaints the system-info and process panels (and ticks the
 * taskbar clock) every second so the desktop tracks current system state. */
void desktop_monitor_task(void);

/* Input-router task: polls the keyboard ring and PS/2 mouse, echoing typed
 * characters into the terminal panel and driving window focus / title-bar drag
 * from the pointer, with a self-drawn cursor. Lets the *graphical* desktop
 * (not just the serial shell) consume real keyboard + mouse input — the path a
 * browser viewer drives through QEMU. No-op if the WM is unavailable. */
void desktop_input_task(void);

#endif
