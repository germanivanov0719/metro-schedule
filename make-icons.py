#!/usr/bin/env python3
"""Иконки PWA: тёмный роундель с «М» и кольцом из цветов линий метро."""
import math
from PIL import Image, ImageDraw, ImageFont

LINE_COLORS = ["#D6083B", "#0072BA", "#009A49", "#EA7125", "#702082", "#B5651D"]
NAVY = (10, 22, 40)        # тёмно-синий фон
NAVY2 = (16, 34, 58)
WHITE = (238, 242, 247)

def font(sz):
    for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]:
        try:
            return ImageFont.truetype(p, sz)
        except Exception:
            pass
    return ImageFont.load_default()

def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def make(size, maskable=False, ring=True):
    S = size * 4  # суперсэмплинг
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = 0 if maskable else int(S * 0.06)
    # фоновый круг с лёгким вертикальным градиентом
    bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bgd = ImageDraw.Draw(bg)
    for y in range(S):
        t = y / S
        c = tuple(int(NAVY[i] * (1 - t) + NAVY2[i] * t) for i in range(3))
        bgd.line([(0, y), (S, y)], fill=c + (255,))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).ellipse([pad, pad, S - pad, S - pad], fill=255)
    img.paste(bg, (0, 0), mask)
    d = ImageDraw.Draw(img)

    # кольцо из 6 цветов линий
    if ring:
        r_out = (S - pad) / 2 - S * 0.015
        r_in = r_out - S * 0.055
        cx = cy = S / 2
        seg = 360 / len(LINE_COLORS)
        for i, hx in enumerate(LINE_COLORS):
            a0 = -90 + i * seg + 3
            a1 = -90 + (i + 1) * seg - 3
            d.arc([cx - r_out, cy - r_out, cx + r_out, cy + r_out],
                  a0, a1, fill=hex2rgb(hx), width=int(S * 0.045))

    # буква М
    f = font(int(S * 0.5))
    tb = d.textbbox((0, 0), "М", font=f)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    d.text(((S - tw) / 2 - tb[0], (S - th) / 2 - tb[1]), "М", font=f, fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)

make(192).save("icons/icon-192.png")
make(512).save("icons/icon-512.png")
make(512, maskable=True).save("icons/icon-maskable-512.png")
make(180, maskable=True).save("icons/apple-touch-icon.png")
make(32, ring=False).save("icons/favicon-32.png")
print("icons written")
