/* net.c — Minimal loopback network stack * @pattern Strategy
 */

#include "net.h"
#include "serial.h"
#include "string.h"

struct net_packet {
    uint16_t len;
    uint8_t data[NET_MTU];
};

static struct net_packet rx_queue[NET_QUEUE_SIZE];
static uint32_t rx_head;
static uint32_t rx_tail;
static uint32_t rx_count;
static struct net_stats stats;

void net_init(void) {
    memset(rx_queue, 0, sizeof(rx_queue));
    memset(&stats, 0, sizeof(stats));
    rx_head = 0;
    rx_tail = 0;
    rx_count = 0;
    serial_print("[NET] Loopback stack initialized\n");
}

int net_send(const void *data, size_t len) {
    if (!data || len == 0)
        return -1;
    if (len > NET_MTU)
        return -2;

    stats.tx_packets++;
    stats.tx_bytes += len;

    if (rx_count >= NET_QUEUE_SIZE) {
        stats.drops++;
        return -3;
    }

    struct net_packet *pkt = &rx_queue[rx_tail];
    pkt->len = (uint16_t)len;
    memcpy(pkt->data, data, len);

    rx_tail = (rx_tail + 1) % NET_QUEUE_SIZE;
    rx_count++;
    return (int)len;
}

int net_recv(void *out, size_t max_len) {
    if (!out || max_len == 0)
        return -1;
    if (rx_count == 0)
        return 0;

    struct net_packet *pkt = &rx_queue[rx_head];
    size_t n = pkt->len;
    if (n > max_len)
        n = max_len;

    memcpy(out, pkt->data, n);
    rx_head = (rx_head + 1) % NET_QUEUE_SIZE;
    rx_count--;

    stats.rx_packets++;
    stats.rx_bytes += n;
    return (int)n;
}

void net_get_stats(struct net_stats *out) {
    if (!out)
        return;
    out->tx_packets = stats.tx_packets;
    out->rx_packets = stats.rx_packets;
    out->tx_bytes = stats.tx_bytes;
    out->rx_bytes = stats.rx_bytes;
    out->drops = stats.drops;
}
