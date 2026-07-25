/* net_service.c — Network IPC service for the hybrid kernel
 *
 * Kernel-mode task that owns IPC_PORT_NET and serves network
 * operations over IPC messages. Wraps net.h loopback stack.
 *
 * Message format:
 *   Request payload[0] = NET_OP_* operation code
 *   Request payload[1..] = operation-specific data
 *   Reply   payload[0] = return code
 *   Reply   payload[1..] = result data
 * @pattern Strategy
 */

#include "net_service.h"
#include "ipc.h"
#include "net.h"
#include "sched.h"
#include "serial.h"
#include "string.h"

/* ── Request handlers ────────────────────────────────────────── */

static void _handle_send(const struct ipc_message *req, struct ipc_message *reply) {
    /* payload[1] = data length, payload[2..] = data bytes */
    uint8_t len = req->payload[1];
    if (len > IPC_PAYLOAD_SIZE - 2)
        len = IPC_PAYLOAD_SIZE - 2;
    int rc = net_send(&req->payload[2], len);
    reply->payload[0] = (rc >= 0) ? 0 : (uint8_t)-1;
    reply->payload[1] = (uint8_t)rc;
    reply->payload_len = 2;
}

static void _handle_recv(const struct ipc_message *req, struct ipc_message *reply) {
    (void)req;
    uint8_t buf[IPC_PAYLOAD_SIZE - 2];
    int n = net_recv(buf, sizeof(buf));
    if (n <= 0) {
        reply->payload[0] = (uint8_t)(n == 0 ? 0 : (uint8_t)-1);
        reply->payload[1] = 0;
        reply->payload_len = 2;
    } else {
        reply->payload[0] = 0;
        reply->payload[1] = (uint8_t)n;
        memcpy(&reply->payload[2], buf, (size_t)n);
        reply->payload_len = (uint32_t)(2 + n);
    }
}

static void _handle_stats(const struct ipc_message *req, struct ipc_message *reply) {
    (void)req;
    struct net_stats stats;
    net_get_stats(&stats);
    reply->payload[0] = 0;
    /* Pack stats as 4 x uint32_t (tx_packets, rx_packets, tx_bytes, rx_bytes) */
    uint32_t *out = (uint32_t *)&reply->payload[4]; /* align to 4 bytes */
    reply->payload[1] = (uint8_t)(stats.tx_packets & 0xFF);
    reply->payload[2] = (uint8_t)(stats.rx_packets & 0xFF);
    reply->payload[3] = (uint8_t)(stats.tx_bytes & 0xFF);
    reply->payload[4] = (uint8_t)(stats.rx_bytes & 0xFF);
    (void)out;
    reply->payload_len = 5;
}

/* ── Main service loop ───────────────────────────────────────── */

void net_service_task(void) {
    int rc = ipc_port_register(IPC_PORT_NET);
    if (rc != IPC_OK) {
        serial_print("[NET-SVC] ERROR: Failed to register port\n");
        for (;;) yield();
    }

    serial_print("[NET-SVC] Network service running on port ");
    serial_print_dec(IPC_PORT_NET);
    serial_print("\n");

    for (;;) {
        struct ipc_message req;
        rc = ipc_recv(IPC_PORT_NET, &req, 0);
        if (rc != IPC_OK) {
            yield();
            continue;
        }

        struct ipc_message reply;
        memset(&reply, 0, sizeof(reply));
        reply.sender_pid  = (uint16_t)sched_current_id();
        reply.sender_port = IPC_PORT_NET;
        reply.type        = IPC_MSG_REPLY;
        reply.seq         = req.seq;

        uint8_t op = req.payload[0];
        switch (op) {
        case NET_OP_SEND:
            _handle_send(&req, &reply);
            break;
        case NET_OP_RECV:
            _handle_recv(&req, &reply);
            break;
        case NET_OP_GET_STATS:
            _handle_stats(&req, &reply);
            break;
        default:
            reply.type = IPC_MSG_ERROR;
            reply.payload[0] = (uint8_t)-1;
            reply.payload_len = 1;
            break;
        }

        if (req.sender_port > 0) {
            ipc_send(req.sender_port, &reply);
        }
    }
}
