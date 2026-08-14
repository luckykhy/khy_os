/* persist.h — Bridge that backs the VFS subtree /disk with KhyFS.
 * @pattern Adapter
 *
 * After persist_init(): files created under /disk via the ordinary VFS calls
 * (write/append/rm in the shell) are mirrored to the ATA disk, and any files
 * already on disk are loaded into /disk at boot — so /disk survives reboot
 * while the rest of the VFS stays a volatile RAM tree.
 */
#ifndef PERSIST_H
#define PERSIST_H

/* Mount-or-format KhyFS, populate /disk from it, and install the VFS hooks.
 * No-op (returns <0) if no ATA disk is present. Returns 0 on success. */
int persist_init(void);

#endif /* PERSIST_H */
