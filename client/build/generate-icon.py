"""
Génère l'icône de l'application (build/icon.ico, build/icon.png,
build/icons/*.png) à partir d'un dessin programmatique (pas d'asset externe
à maintenir). Nécessite Pillow (`pip install Pillow`).

Design : billet stylisé (motif espèces) sur fond dégradé bleu reprenant les
couleurs d'accent de l'UI (client/src/ui/styles.css, --accent/--accent-ink).

Exécution : `python build/generate-icon.py` depuis `client/`.
"""

from PIL import Image, ImageDraw

SIZE = 1024
OUT_DIR = "build"
ICONS_DIR = OUT_DIR + "/icons"


def rounded_rect_mask(size, radius):
    mask = Image.new("L", size, 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return mask


def make_icon():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # Vertical gradient background (accent blue -> deeper blue), matching
    # the app's CSS custom properties --accent (#2f6fed) / --accent-ink (#1c4fc4).
    grad = Image.new("RGB", (1, SIZE), color=0)
    top = (58, 122, 246)     # slightly lighter than --accent for a subtle highlight
    bottom = (23, 66, 168)   # deeper than --accent-ink for contrast/depth
    for y in range(SIZE):
        t = y / (SIZE - 1)
        r = round(top[0] + (bottom[0] - top[0]) * t)
        g = round(top[1] + (bottom[1] - top[1]) * t)
        b = round(top[2] + (bottom[2] - top[2]) * t)
        grad.putpixel((0, y), (r, g, b))
    grad = grad.resize((SIZE, SIZE))

    mask = rounded_rect_mask((SIZE, SIZE), radius=int(SIZE * 0.22))
    img.paste(grad, (0, 0), mask)

    draw = ImageDraw.Draw(img)

    # Subtle inner highlight ring for depth (thin lighter border inset).
    inset = int(SIZE * 0.012)
    draw.rounded_rectangle(
        [inset, inset, SIZE - 1 - inset, SIZE - 1 - inset],
        radius=int(SIZE * 0.21),
        outline=(255, 255, 255, 40),
        width=int(SIZE * 0.006),
    )

    # Foreground glyph: a stylized banknote (payment/cash motif), tilted
    # slightly for a more dynamic mark rather than a flat static icon.
    banknote_w, banknote_h = SIZE * 0.56, SIZE * 0.34
    note = Image.new("RGBA", (int(banknote_w), int(banknote_h)), (0, 0, 0, 0))
    nd = ImageDraw.Draw(note)
    corner = int(banknote_h * 0.18)
    nd.rounded_rectangle(
        [0, 0, banknote_w - 1, banknote_h - 1],
        radius=corner,
        fill=(255, 255, 255, 255),
    )
    # Currency roundel in the center of the note.
    cx, cy = banknote_w / 2, banknote_h / 2
    r_outer = banknote_h * 0.30
    nd.ellipse(
        [cx - r_outer, cy - r_outer, cx + r_outer, cy + r_outer],
        outline=(58, 122, 246, 255),
        width=int(banknote_h * 0.07),
    )
    r_inner = banknote_h * 0.10
    nd.ellipse([cx - r_inner, cy - r_inner, cx + r_inner, cy + r_inner], fill=(58, 122, 246, 255))
    # Corner accent marks (typical banknote detailing), top-left / bottom-right.
    mark_w, mark_h = banknote_w * 0.12, banknote_h * 0.22
    margin = banknote_h * 0.16
    nd.rounded_rectangle([margin, margin, margin + mark_w, margin + mark_h], radius=mark_h * 0.25, fill=(58, 122, 246, 255))
    nd.rounded_rectangle(
        [banknote_w - margin - mark_w, banknote_h - margin - mark_h, banknote_w - margin, banknote_h - margin],
        radius=mark_h * 0.25,
        fill=(58, 122, 246, 255),
    )

    note = note.rotate(-10, expand=True, resample=Image.BICUBIC)
    nx = int((SIZE - note.width) / 2)
    ny = int((SIZE - note.height) / 2)
    img.alpha_composite(note, (nx, ny))

    return img


if __name__ == "__main__":
    icon = make_icon()  # 1024x1024 RGBA master

    icon.save(
        f"{OUT_DIR}/icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"Wrote {OUT_DIR}/icon.ico")

    icon.save(f"{OUT_DIR}/icon.png")
    print(f"Wrote {OUT_DIR}/icon.png")

    import os
    os.makedirs(ICONS_DIR, exist_ok=True)
    for size in [16, 24, 32, 48, 64, 128, 256, 512, 1024]:
        resized = icon.resize((size, size), resample=Image.LANCZOS)
        resized.save(f"{ICONS_DIR}/{size}x{size}.png")
    print(f"Wrote {ICONS_DIR}/*.png (16..1024)")
