/* vfs_service.h — VFS IPC service wrapper
 *
 * Runs as a kernel task, listens on IPC_PORT_VFS for file operation requests.
 * Translates IPC messages into vfs.h calls and returns results.
 * @pattern Strategy
 */
#ifndef VFS_SERVICE_H
#define VFS_SERVICE_H

/* VFS IPC operation codes (placed in payload[0]) */
#define VFS_OP_EXISTS    1
#define VFS_OP_READ      2
#define VFS_OP_WRITE     3
#define VFS_OP_MKDIR     4
#define VFS_OP_LIST_DIR  5
#define VFS_OP_GET_SIZE  6
#define VFS_OP_IS_DIR    7

/* Start the VFS service task (registers IPC_PORT_VFS, enters message loop) */
void vfs_service_task(void);

#endif
