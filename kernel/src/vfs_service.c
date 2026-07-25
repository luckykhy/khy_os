/* vfs_service.c — VFS IPC service for the hybrid kernel
 *
 * Kernel-mode task that owns IPC_PORT_VFS and serves file
 * operations over IPC messages. This is the componentized
 * version of the direct vfs.h calls — clients send IPC
 * requests instead of calling vfs_* directly.
 *
 * Message format (request):
 *   payload[0]     = VFS_OP_* operation code
 *   payload[1..]   = operation-specific data (path, offset, etc.)
 *
 * Message format (reply):
 *   payload[0]     = return code (0 = success, negative = error)
 *   payload[1..]   = operation-specific result data
 * @pattern Strategy
 */

#include "vfs_service.h"
#include "ipc.h"
#include "sched.h"
#include "serial.h"
#include "string.h"
#include "vfs.h"

/* Maximum path length that fits in an IPC payload (after 1-byte opcode) */
#define VFS_IPC_PATH_MAX (IPC_PAYLOAD_SIZE - 1)

/* ── Request handlers ────────────────────────────────────────── */

static void _handle_exists(const struct ipc_message *req, struct ipc_message *reply) {
    const char *path = (const char *)&req->payload[1];
    int exists = vfs_exists(path);
    reply->payload[0] = 0;
    reply->payload[1] = (uint8_t)exists;
    reply->payload_len = 2;
}

static void _handle_is_dir(const struct ipc_message *req, struct ipc_message *reply) {
    const char *path = (const char *)&req->payload[1];
    int is_dir = vfs_is_dir(path);
    reply->payload[0] = 0;
    reply->payload[1] = (uint8_t)is_dir;
    reply->payload_len = 2;
}

static void _handle_get_size(const struct ipc_message *req, struct ipc_message *reply) {
    const char *path = (const char *)&req->payload[1];
    size_t sz = 0;
    int rc = vfs_get_size(path, &sz);
    reply->payload[0] = (uint8_t)(rc == 0 ? 0 : (uint8_t)-1);
    /* Store size as 4 little-endian bytes */
    reply->payload[1] = (uint8_t)(sz & 0xFF);
    reply->payload[2] = (uint8_t)((sz >> 8) & 0xFF);
    reply->payload[3] = (uint8_t)((sz >> 16) & 0xFF);
    reply->payload[4] = (uint8_t)((sz >> 24) & 0xFF);
    reply->payload_len = 5;
}

static void _handle_mkdir(const struct ipc_message *req, struct ipc_message *reply) {
    const char *path = (const char *)&req->payload[1];
    int rc = vfs_mkdir(path);
    reply->payload[0] = (uint8_t)(rc == 0 ? 0 : (uint8_t)-1);
    reply->payload_len = 1;
}

static void _handle_read(const struct ipc_message *req, struct ipc_message *reply) {
    /*
     * Request: payload[0]=OP, payload[1..]=path (null-terminated)
     * Reply:   payload[0]=rc, payload[1..]=data (up to 47 bytes per reply)
     * For larger files, the client must issue multiple reads with offsets.
     */
    const char *path = (const char *)&req->payload[1];
    uint8_t buf[IPC_PAYLOAD_SIZE - 1];
    int n = vfs_read_file(path, buf, sizeof(buf));
    if (n < 0) {
        reply->payload[0] = (uint8_t)-1;
        reply->payload_len = 1;
    } else {
        reply->payload[0] = 0;
        memcpy(&reply->payload[1], buf, (size_t)n);
        reply->payload_len = (uint32_t)(1 + n);
    }
}

/* ── Main service loop ───────────────────────────────────────── */

void vfs_service_task(void) {
    int rc = ipc_port_register(IPC_PORT_VFS);
    if (rc != IPC_OK) {
        serial_print("[VFS-SVC] ERROR: Failed to register port\n");
        for (;;) yield();
    }

    serial_print("[VFS-SVC] VFS service running on port ");
    serial_print_dec(IPC_PORT_VFS);
    serial_print("\n");

    for (;;) {
        struct ipc_message req;
        rc = ipc_recv(IPC_PORT_VFS, &req, 0);
        if (rc != IPC_OK) {
            yield();
            continue;
        }

        /* Build reply */
        struct ipc_message reply;
        memset(&reply, 0, sizeof(reply));
        reply.sender_pid  = (uint16_t)sched_current_id();
        reply.sender_port = IPC_PORT_VFS;
        reply.type        = IPC_MSG_REPLY;
        reply.seq         = req.seq;

        uint8_t op = req.payload[0];
        switch (op) {
        case VFS_OP_EXISTS:
            _handle_exists(&req, &reply);
            break;
        case VFS_OP_READ:
            _handle_read(&req, &reply);
            break;
        case VFS_OP_MKDIR:
            _handle_mkdir(&req, &reply);
            break;
        case VFS_OP_GET_SIZE:
            _handle_get_size(&req, &reply);
            break;
        case VFS_OP_IS_DIR:
            _handle_is_dir(&req, &reply);
            break;
        default:
            reply.type = IPC_MSG_ERROR;
            reply.payload[0] = (uint8_t)-1;
            reply.payload_len = 1;
            break;
        }

        /* Send reply back to the caller's reply port */
        if (req.sender_port > 0) {
            ipc_send(req.sender_port, &reply);
        }
    }
}
