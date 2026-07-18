#!/usr/bin/env python3
# gen-cjk-font.py — dev-time generator for the kernel's 16x16 CJK bitmap font.
#
# Why generated, not hand-authored: a 16x16 Chinese glyph is 32 bytes of bit
# data; hand-encoding even a dozen characters is error-prone and unverifiable.
# This rasterizes a *curated* charset from a real font (Noto Sans CJK SC) into
# kernel/src/cjk_font16.h. The kernel stays self-contained (no runtime font
# parsing); regenerate by re-running this on any host with PIL + the font.
#
# The charset is intentionally small (only what the Chinese desktop renders) to
# keep the kernel image tiny — this is a *minimal* landing, not full Unicode.
# Add characters to CHARSET below and re-run to extend coverage.
#
# Usage:
#   python3 kernel/tools/gen-cjk-font.py            # writes kernel/src/cjk_font16.h
#   python3 kernel/tools/gen-cjk-font.py --font /path/to/font.ttc --index 0
#
# Output contract (consumed by framebuffer.c fb_draw_utf8):
#   - cjk_glyph16[N][32]   : N glyphs, 32 bytes each (16 rows x 2 bytes, MSB=left)
#   - cjk_codepoints[N]    : ascending Unicode code points, parallel to glyphs
#   - CJK_GLYPH_COUNT      : N
#   - cjk_lookup(uint32_t) : binary search -> glyph index or -1

import argparse
import os
import sys

# Curated charset for the minimal Chinese desktop. Grouped for readability; the
# generator sorts/dedupes by code point. Keep this the single source of which
# Chinese characters the kernel can render.
CHARSET = (
    # Desktop / window chrome
    "欢迎使用桌面终端系统信息关于设置文件管理器"
    # Kernel / arch vocabulary shown in System Info window
    "混合内核架构格式端口就绪运行中状态版本"
    # Common shell / help words
    "命令帮助输入查看清屏列表进程内存磁盘网络时间"
    # Generic high-frequency characters
    "你好我是的了在有和不这中人上来个到大小开关打"
    # Desktop UI extras (graphics / interface vocabulary)
    "图形界已就绪点阅读写画始应用程序桌秒"
    # Punctuation (fullwidth) commonly mixed into Chinese UI
    "，。：；！？、（）"
)


def build_codepoints():
    seen = {}
    for ch in CHARSET:
        cp = ord(ch)
        if cp < 0x80:
            continue  # ASCII handled by the existing 8x16 font
        seen[cp] = ch
    return sorted(seen.keys()), seen


SUPERSAMPLE = 4  # render at 4x then downsample for antialiased edges
CELL = 16        # glyph cell size in px
GLYPH_PT = (CELL - 1) * SUPERSAMPLE  # font point size on the supersampled canvas


def rasterize(font, ch, size=CELL, ss=SUPERSAMPLE):
    """Render a glyph as 8-bit grayscale alpha (0=bg, 255=full ink).

    `font` must already be sized for the supersampled canvas (size*ss). We draw
    big, then box-downsample to `size` so the kernel can blend these alphas over
    the background — Chinese strokes look crisp instead of jagged 1bpp."""
    from PIL import Image, ImageDraw

    big = size * ss
    img = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(img)
    # Center the glyph in the supersampled cell using its bounding box.
    try:
        bbox = draw.textbbox((0, 0), ch, font=font)
        gw = bbox[2] - bbox[0]
        gh = bbox[3] - bbox[1]
        ox = (big - gw) // 2 - bbox[0]
        oy = (big - gh) // 2 - bbox[1]
    except Exception:
        ox, oy = 0, 0
    draw.text((ox, oy), ch, fill=255, font=font)
    img = img.resize((size, size), Image.BILINEAR)

    out = []
    px = img.load()
    for y in range(size):
        for x in range(size):
            out.append(px[x, y])  # one alpha byte per pixel, row-major
    return out  # size*size bytes


def find_font():
    candidates = [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Black.ttc",
        "/usr/share/fonts/truetype/arphic/uming.ttc",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--font", default=None, help="TTF/TTC path (CJK)")
    ap.add_argument("--index", type=int, default=0, help="face index in a TTC")
    ap.add_argument(
        "--out",
        default=os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "src", "cjk_font16.h"
        ),
    )
    args = ap.parse_args()

    try:
        from PIL import ImageFont
    except ImportError:
        print("ERROR: Pillow (PIL) required: pip install Pillow", file=sys.stderr)
        return 1

    font_path = args.font or find_font()
    if not font_path or not os.path.exists(font_path):
        print(
            "ERROR: no CJK font found. Pass --font /path/to/NotoSansCJK-Regular.ttc",
            file=sys.stderr,
        )
        return 1

    # The font is sized for the supersampled canvas (GLYPH_PT = (CELL-1)*ss);
    # rasterize() draws big then box-downsamples, smoothing edges into alpha.
    font = ImageFont.truetype(font_path, GLYPH_PT, index=args.index)

    cps, table = build_codepoints()
    glyphs = [(cp, rasterize(font, table[cp])) for cp in cps]

    lines = []
    lines.append("/* cjk_font16.h — 16x16 grayscale CJK font (GENERATED, do not edit). */")
    lines.append("/* Source: %s (face %d). Regenerate via kernel/tools/gen-cjk-font.py. */"
                 % (os.path.basename(font_path), args.index))
    lines.append("/* Each glyph: 256 bytes = 16x16 8-bit alpha (row-major, 0=bg 255=ink). */")
    lines.append("#ifndef CJK_FONT16_H")
    lines.append("#define CJK_FONT16_H")
    lines.append("")
    lines.append("#include <stdint.h>")
    lines.append("")
    lines.append("#define CJK_GLYPH_WIDTH  16")
    lines.append("#define CJK_GLYPH_HEIGHT 16")
    lines.append("#define CJK_GLYPH_BYTES  256")
    lines.append("#define CJK_GLYPH_COUNT  %d" % len(glyphs))
    lines.append("")
    lines.append("static const uint32_t cjk_codepoints[CJK_GLYPH_COUNT] = {")
    for i in range(0, len(cps), 8):
        chunk = ", ".join("0x%04X" % cp for cp in cps[i:i + 8])
        lines.append("    %s," % chunk)
    lines.append("};")
    lines.append("")
    lines.append("/* Alpha coverage per pixel; kernel blends ink over background. */")
    lines.append("static const uint8_t cjk_glyph16[CJK_GLYPH_COUNT][CJK_GLYPH_BYTES] = {")
    for cp, data in glyphs:
        try:
            ch = chr(cp)
        except ValueError:
            ch = "?"
        lines.append("    /* U+%04X %s */ {" % (cp, ch))
        for r in range(16):
            row = data[r * 16:(r + 1) * 16]
            lines.append("        %s," % ",".join("0x%02X" % b for b in row))
        lines.append("    },")
    lines.append("};")
    lines.append("")
    lines.append("/* Binary search the ascending code-point table. Returns glyph index or -1. */")
    lines.append("static inline int cjk_lookup(uint32_t cp) {")
    lines.append("    int lo = 0, hi = CJK_GLYPH_COUNT - 1;")
    lines.append("    while (lo <= hi) {")
    lines.append("        int mid = (lo + hi) / 2;")
    lines.append("        uint32_t v = cjk_codepoints[mid];")
    lines.append("        if (v == cp) return mid;")
    lines.append("        if (v < cp) lo = mid + 1; else hi = mid - 1;")
    lines.append("    }")
    lines.append("    return -1;")
    lines.append("}")
    lines.append("")
    lines.append("#endif /* CJK_FONT16_H */")

    out_path = os.path.abspath(args.out)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print("Wrote %d CJK glyphs -> %s" % (len(glyphs), out_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
