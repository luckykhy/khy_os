/* agentframe.h — Agent ⇄ OS wire frame codec (COBS + CRC16)
 *
 * Pure, I/O-free framing for the agent channel (stage A2). agentbus.c does the
 * COM2 byte transport and RX/TX state; this module only encodes and decodes
 * frames in memory, so it is small and self-contained.
 *
 * Logical frame layout (little-endian), before COBS encoding:
 *
 *     [type:1][seq:4][code:2][len:2][payload:len][crc16:2]
 *
 *   type    one of AGENTFRAME_TYPE_* (request / response / event / decision)
 *   seq     correlates a response with its request (echoed back unchanged)
 *   code    verb (control-plane action) or intent (decision plane)
 *   len     payload byte count (0..AGENTFRAME_PAYLOAD_MAX)
 *   payload code-specific bytes; host maps these to/from JSON
 *   crc16   CRC-16/CCITT-FALSE over every byte before it (type..payload)
 *
 * Wire encoding: the whole logical frame is COBS-encoded and terminated with a
 * single 0x00 byte. COBS guarantees the encoded body contains no 0x00, so the
 * delimiter is unambiguous and the stream is self-synchronizing — a host that
 * connects mid-stream simply waits for the next 0x00 to find a frame boundary.
 * @pattern Strategy
 */
#ifndef AGENTFRAME_H
#define AGENTFRAME_H

#include <stddef.h>
#include <stdint.h>

/* Frame types (the `type` field). */
#define AGENTFRAME_TYPE_REQUEST       0x01  /* agent -> OS: do something        */
#define AGENTFRAME_TYPE_RESPONSE      0x02  /* OS -> agent: result of a request */
#define AGENTFRAME_TYPE_EVENT         0x03  /* OS -> agent: async notification  */
#define AGENTFRAME_TYPE_DECISION_REQ  0x04  /* OS -> agent: please decide       */
#define AGENTFRAME_TYPE_DECISION_RESP 0x05  /* agent -> OS: the decision        */

/* Sizing. PAYLOAD_MAX bounds a single frame's payload; the raw (pre-COBS) and
 * wire (post-COBS, with delimiter) buffers are derived from it. COBS adds at
 * most ceil(n/254)+1 overhead bytes, so WIRE_MAX leaves generous headroom. */
#define AGENTFRAME_PAYLOAD_MAX 1024
#define AGENTFRAME_HEADER      9    /* type(1)+seq(4)+code(2)+len(2)            */
#define AGENTFRAME_CRC         2
#define AGENTFRAME_RAW_MAX     (AGENTFRAME_HEADER + AGENTFRAME_PAYLOAD_MAX + AGENTFRAME_CRC)
#define AGENTFRAME_WIRE_MAX    (AGENTFRAME_RAW_MAX + (AGENTFRAME_RAW_MAX / 254) + 2)

struct agentframe {
    uint8_t  type;
    uint32_t seq;
    uint16_t code;
    uint16_t len;                              /* payload length */
    uint8_t  payload[AGENTFRAME_PAYLOAD_MAX];
};

/* CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF). Exposed for host-parity tests. */
uint16_t agentframe_crc16(const uint8_t *data, size_t len);

/* COBS primitives. encode never emits a 0x00; decode rejects malformed input.
 * encode returns the encoded length; decode returns the decoded length or -1. */
size_t agentframe_cobs_encode(const uint8_t *in, size_t len, uint8_t *out);
int    agentframe_cobs_decode(const uint8_t *in, size_t len,
                              uint8_t *out, size_t out_max);

/* Serialize `f` to a wire frame (COBS-encoded, 0x00-terminated) in `out`.
 * Returns the wire byte count, or -1 if f->len is out of range or `out_max` is
 * too small. */
int agentframe_encode(const struct agentframe *f, uint8_t *out, size_t out_max);

/* Parse one wire frame `in` (the bytes BEFORE the 0x00 delimiter, delimiter not
 * included) into `f`. Validates the COBS decode, the length consistency and the
 * CRC. Returns 0 on success, -1 on any malformation (caller drops the frame). */
int agentframe_decode(const uint8_t *in, size_t len, struct agentframe *f);

#endif
