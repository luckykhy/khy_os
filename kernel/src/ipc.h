/* ipc.h — Port-based IPC for the hybrid kernel
 *
 * Synchronous message passing with blocking semantics.
 * Fixed 64-byte messages, 32 ports, 8-message deep queues.
 * @pattern Strategy
 */
#ifndef IPC_H
#define IPC_H

#include <stdint.h>

#define IPC_MAX_PORTS     32
#define IPC_QUEUE_DEPTH   8
#define IPC_PAYLOAD_SIZE  48

/* Well-known service ports */
#define IPC_PORT_VFS      1
#define IPC_PORT_NET      2
#define IPC_PORT_VGA      3
#define IPC_PORT_PROC     4

/* Message types */
enum ipc_msg_type {
    IPC_MSG_REQUEST   = 1,
    IPC_MSG_REPLY     = 2,
    IPC_MSG_NOTIFY    = 3,
    IPC_MSG_ERROR     = 4,
};

/* Flags */
#define IPC_FLAG_NONBLOCK  (1 << 0)

/* IPC message (exactly 64 bytes) */
struct ipc_message {
    uint16_t sender_pid;
    uint16_t sender_port;
    uint16_t type;               /* enum ipc_msg_type */
    uint16_t flags;
    uint32_t seq;                /* Sequence number for request/reply matching */
    uint32_t payload_len;        /* Actual bytes used in payload */
    uint8_t  payload[IPC_PAYLOAD_SIZE]; /* 48 bytes */
};

/* Error codes */
#define IPC_OK             0
#define IPC_ERR_INVAL     -1
#define IPC_ERR_BUSY      -2  /* Port already registered */
#define IPC_ERR_FULL      -3  /* Queue full (non-blocking mode) */
#define IPC_ERR_EMPTY     -4  /* Queue empty (non-blocking mode) */
#define IPC_ERR_NOPORT    -5  /* Target port not registered */
#define IPC_ERR_PERM      -6  /* Permission denied */
#define IPC_ERR_TIMEOUT   -7

/* Initialize IPC subsystem */
void ipc_init(void);

/* Register a port owned by the calling task. Returns IPC_OK or error. */
int ipc_port_register(uint16_t port);

/* Unregister a port. Returns IPC_OK or error. */
int ipc_port_unregister(uint16_t port);

/* Send a message to a destination port.
 * Blocks if queue is full (unless IPC_FLAG_NONBLOCK). */
int ipc_send(uint16_t dest_port, const struct ipc_message *msg);

/* Receive a message on a port owned by the caller.
 * Blocks if queue is empty (unless IPC_FLAG_NONBLOCK). */
int ipc_recv(uint16_t port, struct ipc_message *out, uint32_t flags);

/* Synchronous call: send request, block until reply arrives.
 * Stores reply in *reply. Returns IPC_OK or error. */
int ipc_call(uint16_t dest_port, const struct ipc_message *request,
             struct ipc_message *reply);

/* Get the task ID that owns a given port. Returns -1 if not registered. */
int ipc_port_owner(uint16_t port);

#endif
