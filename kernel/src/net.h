/* net.h — Minimal loopback network stack * @pattern Strategy
 */
#ifndef NET_H
#define NET_H

#include <stddef.h>
#include <stdint.h>

#define NET_MTU        1500
#define NET_QUEUE_SIZE 32

struct net_stats {
    uint64_t tx_packets;
    uint64_t rx_packets;
    uint64_t tx_bytes;
    uint64_t rx_bytes;
    uint64_t drops;
};

void net_init(void);
int net_send(const void *data, size_t len);
int net_recv(void *out, size_t max_len);
void net_get_stats(struct net_stats *out);

#endif
