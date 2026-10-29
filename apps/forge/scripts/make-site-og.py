# Regenerates public/og/site.png (the site-wide share image). Run: python3 scripts/make-site-og.py public/fonts public/og/site.png
# Needs: pip install fonttools brotli pillow. Text: the BRAND.md v1.2 descriptor and the tagline (BRAND.md §1).
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from PIL import Image, ImageDraw, ImageFont
fonts = sys.argv[1]; out = sys.argv[2]
def inst(src, dst, axes):
    f = TTFont(src); f.flavor = None
    instancer.instantiateVariableFont(f, axes, inplace=True); f.save(dst)
inst(f"{fonts}/archivo.woff2", "archivo-x.ttf", {"wght": 800, "wdth": 125})
inst(f"{fonts}/archivo.woff2", "archivo-r.ttf", {"wght": 450, "wdth": 100})
inst(f"{fonts}/jetbrains-mono.woff2", "mono.ttf", {"wght": 500})
W, H = 1200, 630
BG, TEXT, MUTED, BRAND, SEAM, CLEAR = "#0B0E12", "#E8ECF1", "#9AA5B4", "#4AA8FF", "#2A3340", "#3DDC97"
im = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(im)
def punch(x, y, s, color, inner):
    pts = [(5,0),(29,0),(34,5),(34,35),(29,40),(5,40),(0,35),(0,5)]
    d.polygon([(x+px*s, y+py*s) for px,py in pts], fill=color)
    d.polygon([(x+px*s, y+py*s) for px,py in inner], fill=BG)
F = [(9,8),(26,8),(26,14),(15.5,14),(15.5,17.5),(24,17.5),(24,23.5),(15.5,23.5),(15.5,32),(9,32)]
CHECK = [(5.5,20.5),(10,16),(14.5,20.5),(25,10),(29.5,14.5),(14.5,29.5)]
s = 2.2; x0, y0 = 72, 64
punch(x0, y0, s, TEXT, F); punch(x0 + 38*s, y0, s, BRAND, CHECK)
small = ImageFont.truetype("archivo-x.ttf", 22); word = ImageFont.truetype("archivo-x.ttf", 40)
d.text((x0 + 80*s, y0 + 6), "THE", font=small, fill=MUTED)
d.text((x0 + 80*s, y0 + 32), "AGENT FORGE", font=word, fill=TEXT)
# BRAND.md v1.2 (28 Oct 2026): the one-line descriptor (AQ-01), wrapped to the card's width.
DESCRIPTOR = "A planted-trap test for AI agents, and safety data on the skills, MCP servers and packages they install."
head = ImageFont.truetype("archivo-x.ttf", 46)
lines, cur = [], ""
for wd in DESCRIPTOR.split():
    nxt = f"{cur} {wd}".strip()
    if cur and d.textlength(nxt, font=head) > W - 144: lines.append(cur); cur = wd
    else: cur = nxt
lines.append(cur)
assert len(lines) <= 4, lines
y = 214
for ln in lines:
    d.text((72, y), ln, font=head, fill=TEXT); y += 62
mono = ImageFont.truetype("mono.ttf", 28)
d.line([(72, 500), (W-72, 500)], fill=SEAM, width=2)
sym = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 28)
x = 72
for part, f in (("[F", mono), ("✓", sym), ("]", mono)):
    d.text((x, 528), part, font=f, fill=CLEAR); x += d.textlength(part, font=f)
d.text((x + d.textlength(" ", font=mono), 528), "AI, tested on everyday jobs.", font=mono, fill=TEXT)
dom = "theagentforge.io"
d.text((W - 72 - d.textlength(dom, font=mono), 528), dom, font=mono, fill=BRAND)
im.save(out, optimize=True)
print("ok", out)
