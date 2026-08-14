/* net_service.h — Network IPC service wrapper
 *
 * Runs as a kernel task, listens on IPC_PORT_NET for network operations.
 * @pattern Strategy
 */
#ifndef NET_SERVICE_H
#define NET_SERVICE_H

/* Network IPC operation codes (placed in payload[0]) */
#define NET_OP_SEND       1
#define NET_OP_RECV       2
#define NET_OP_GET_STATS  3

/* Start the network service task (registers IPC_PORT_NET, enters message loop) */
void net_service_task(void);

#endif
