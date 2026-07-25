/* agentframe.c — Agent ⇄ OS wire frame codec (COBS + CRC16)
 *
 * Pure in-memory framing; see agentframe.h for the wire layout. No I/O, no
 * global state — safe to call from the agent bridge task or a test.
 * @pattern Strategy
 */

#include "agentframe.h"

/* ── CRC-16/CCITT-FALSE ──────────────────────────────────────────────────── */

uint16_t agentframe_crc16(const uint8_t *data, size_t len) {
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < len; i++) {
        crc ^= (uint16_t)data[i] << 8;
        for (int b = 0; b < 8; b++) {
            if (crc & 0x8000)
                crc = (uint16_t)((crc << 1) ^ 0x1021);
            else
                crc = (uint16_t)(crc << 1);
        }
    }
    return crc;
}

/* ── COBS ────────────────────────────────────────────────────────────────── */

size_t agentframe_cobs_encode(const uint8_t *in, size_t len, uint8_t *out) {
    size_t read_idx = 0, write_idx = 1, code_idx = 0;
    uint8_t code = 1;

    while (read_idx < len) {
        if (in[read_idx] == 0) {
            out[code_idx] = code;
            code = 1;
            code_idx = write_idx++;
            read_idx++;
        } else {
            out[write_idx++] = in[read_idx++];
            code++;
            if (code == 0xFF) {
                out[code_idx] = code;
                code = 1;
                code_idx = write_idx++;
            }
        }
    }
    out[code_idx] = code;
    return write_idx;
}

int agentframe_cobs_decode(const uint8_t *in, size_t len,
                           uint8_t *out, size_t out_max) {
    size_t read_idx = 0, write_idx = 0;

    while (read_idx < len) {
        uint8_t code = in[read_idx];
        if (code == 0)
            return -1; /* a real 0x00 inside COBS data is malformed */
        read_idx++;

        for (uint8_t i = 1; i < code; i++) {
            if (read_idx >= len || write_idx >= out_max)
                return -1;
            out[write_idx++] = in[read_idx++];
        }
        /* A non-0xFF block that is not the final block stood for a literal 0. */
        if (code < 0xFF && read_idx < len) {
            if (write_idx >= out_max)
                return -1;
            out[write_idx++] = 0;
        }
    }
    return (int)write_idx;
}

/* ── Little-endian helpers ───────────────────────────────────────────────── */

static void put_u16(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
}

static void put_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
    p[2] = (uint8_t)((v >> 16) & 0xFF);
    p[3] = (uint8_t)((v >> 24) & 0xFF);
}

static uint16_t get_u16(const uint8_t *p) {
    return (uint16_t)(p[0] | ((uint16_t)p[1] << 8));
}

static uint32_t get_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/* ── Frame encode / decode ───────────────────────────────────────────────── */

int agentframe_encode(const struct agentframe *f, uint8_t *out, size_t out_max) {
    if (!f || f->len > AGENTFRAME_PAYLOAD_MAX)
        return -1;

    uint8_t raw[AGENTFRAME_RAW_MAX];
    size_t n = 0;

    raw[n++] = f->type;
    put_u32(&raw[n], f->seq);  n += 4;
    put_u16(&raw[n], f->code); n += 2;
    put_u16(&raw[n], f->len);  n += 2;
    for (uint16_t i = 0; i < f->len; i++)
        raw[n++] = f->payload[i];

    uint16_t crc = agentframe_crc16(raw, n);
    put_u16(&raw[n], crc);     n += 2;

    /* COBS output is at most n + ceil(n/254) + 1; require room for that plus the
     * trailing 0x00 delimiter. */
    if (out_max < n + (n / 254) + 2)
        return -1;

    size_t enc = agentframe_cobs_encode(raw, n, out);
    out[enc++] = 0x00; /* frame delimiter */
    return (int)enc;
}

int agentframe_decode(const uint8_t *in, size_t len, struct agentframe *f) {
    if (!in || !f)
        return -1;

    uint8_t raw[AGENTFRAME_RAW_MAX];
    int rawlen = agentframe_cobs_decode(in, len, raw, sizeof(raw));
    if (rawlen < AGENTFRAME_HEADER + AGENTFRAME_CRC)
        return -1; /* too short to hold header + crc */

    size_t n = 0;
    uint8_t  type = raw[n++];
    uint32_t seq  = get_u32(&raw[n]); n += 4;
    uint16_t code = get_u16(&raw[n]); n += 2;
    uint16_t plen = get_u16(&raw[n]); n += 2;

    /* The declared payload length must exactly account for the frame size:
     * header + payload + crc. A mismatch is a corrupt or hostile frame. */
    if ((size_t)rawlen != (size_t)AGENTFRAME_HEADER + plen + AGENTFRAME_CRC)
        return -1;
    if (plen > AGENTFRAME_PAYLOAD_MAX)
        return -1;

    uint16_t want = get_u16(&raw[AGENTFRAME_HEADER + plen]);
    uint16_t have = agentframe_crc16(raw, (size_t)AGENTFRAME_HEADER + plen);
    if (want != have)
        return -1;

    f->type = type;
    f->seq  = seq;
    f->code = code;
    f->len  = plen;
    for (uint16_t i = 0; i < plen; i++)
        f->payload[i] = raw[AGENTFRAME_HEADER + i];
    return 0;
}
