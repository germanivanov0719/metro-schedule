#!/usr/bin/env python3
# Иконки приложения из настоящего логотипа Петербургского метрополитена
# (Spb_metro_logo.svg): белый логотип на синем фоне со скруглением.
# SVG растеризуется встроенным флэттенером путей; для чёткости (без «мыла»
# на macOS) рендерим в 4× и уменьшаем с LANCZOS-сглаживанием.
import re
from PIL import Image, ImageDraw

BLUE = (32, 73, 130)     # фирменный синий метрополитена
WHITE = (255, 255, 255)
SS = 4                   # коэффициент суперсэмплинга

SVG = open('Spb_metro_logo.svg', encoding='utf-8').read()
PATH = re.search(r'\sd="([^"]+)"', SVG).group(1)
TOKS = re.findall(r'[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?', PATH)

def _bez(p0, p1, p2, p3, n=64):
    out = []
    for k in range(1, n + 1):
        t = k / n; u = 1 - t
        out.append((u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
                    u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]))
    return out

def flatten():
    pts = []; i = 0; cur = (0, 0); start = (0, 0); cmd = None; pc2 = None
    def nx():
        nonlocal i
        v = float(TOKS[i]); i += 1; return v
    while i < len(TOKS):
        if re.match(r'[a-zA-Z]', TOKS[i]): cmd = TOKS[i]; i += 1
        rel = cmd.islower(); c = cmd.lower()
        if c == 'm':
            x = nx(); y = nx(); cur = (cur[0]+x, cur[1]+y) if rel else (x, y); start = cur; pts.append(cur); cmd = 'l' if rel else 'L'; pc2 = None
        elif c == 'l':
            x = nx(); y = nx(); cur = (cur[0]+x, cur[1]+y) if rel else (x, y); pts.append(cur); pc2 = None
        elif c == 'h':
            x = nx(); cur = (cur[0]+x, cur[1]) if rel else (x, cur[1]); pts.append(cur); pc2 = None
        elif c == 'v':
            y = nx(); cur = (cur[0], cur[1]+y) if rel else (cur[0], y); pts.append(cur); pc2 = None
        elif c == 'c':
            a = [nx() for _ in range(6)]
            p1 = (cur[0]+a[0], cur[1]+a[1]) if rel else (a[0], a[1])
            p2 = (cur[0]+a[2], cur[1]+a[3]) if rel else (a[2], a[3])
            p3 = (cur[0]+a[4], cur[1]+a[5]) if rel else (a[4], a[5])
            pts.extend(_bez(cur, p1, p2, p3)); pc2 = p2; cur = p3
        elif c == 's':
            a = [nx() for _ in range(4)]
            p2 = (cur[0]+a[0], cur[1]+a[1]) if rel else (a[0], a[1])
            p3 = (cur[0]+a[2], cur[1]+a[3]) if rel else (a[2], a[3])
            p1 = (2*cur[0]-pc2[0], 2*cur[1]-pc2[1]) if pc2 else cur
            pts.extend(_bez(cur, p1, p2, p3)); pc2 = p2; cur = p3
        elif c == 'z':
            cur = start; pc2 = None
        else:
            i += 1
    return pts

PTS = flatten()
XS = [p[0] for p in PTS]; YS = [p[1] for p in PTS]
MINX, MAXX, MINY, MAXY = min(XS), max(XS), min(YS), max(YS)
W, H = MAXX - MINX, MAXY - MINY

def render(size, pad_frac, maskable=False):
    big = size * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    dr = ImageDraw.Draw(img)
    if maskable:
        dr.rectangle([0, 0, big, big], fill=BLUE)
    else:
        dr.rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * 0.22), fill=BLUE)
    avail = big * (1 - 2 * pad_frac)
    s = min(avail / W, avail / H)
    ox = (big - W * s) / 2 - MINX * s
    oy = (big - H * s) / 2 - MINY * s
    dr.polygon([(ox + x * s, oy + y * s) for (x, y) in PTS], fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)

render(192, 0.22).save('icons/icon-192.png')
render(512, 0.22).save('icons/icon-512.png')
render(512, 0.32, maskable=True).save('icons/icon-maskable-512.png')
render(180, 0.22).save('icons/apple-touch-icon.png')
render(32, 0.16).save('icons/favicon-32.png')
print('Иконки обновлены: синий фон, белый логотип, суперсэмплинг 4×.')
