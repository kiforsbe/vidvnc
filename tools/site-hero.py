"""Draws the website's hero image: the Windows and Mac apps' Overview pages, overlapping, with
soft shadows on a transparent background, light and dark, from the screenshots in docs/images.

    python3 tools/site-hero.py

Writes site/images/hero-light.png and site/images/hero-dark.png. Needs Pillow
(python3 -m pip install pillow). The README's image, with its gradient, is
tools/readme-hero.swift's; this one uses the same layout without the background.
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

root = Path(__file__).resolve().parent.parent
images = root / "docs" / "images"
output = root / "site" / "images"

# Sizes in pixels at 1x. The Windows screenshots are at 100 %, the Mac ones at 200 %, so the
# Mac window is scaled down. The margin leaves room for the shadows, so none is cut off.
margin = 140
windows_frame = (margin, margin - 32, 986, 713)
mac_frame = (margin + 588, margin + 96, 900, 760)
canvas = (mac_frame[0] + mac_frame[2] + margin, mac_frame[1] + mac_frame[3] + margin)


def rounded_mask(size, radius, scale=4):
    # Drawn large and scaled down so the corners are anti-aliased.
    big = Image.new("L", (size[0] * scale, size[1] * scale), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, big.width - 1, big.height - 1), radius * scale, fill=255
    )
    return big.resize(size, Image.LANCZOS)


def place(base, image, frame, radius, theme):
    x, y, width, height = frame
    image = image.convert("RGBA").resize((width, height), Image.LANCZOS)
    mask = ImageChops.multiply(rounded_mask((width, height), radius), image.getchannel("A"))

    # A wide soft shadow and a tighter contact shadow under it.
    for offset, blur, strength in ((24, 40, 0.30 if theme == "light" else 0.55), (4, 6, 0.18)):
        shadow = Image.new("L", base.size, 0)
        shadow.paste(rounded_mask((width, height), radius), (x, y + offset))
        shadow = shadow.filter(ImageFilter.GaussianBlur(blur)).point(lambda v: int(v * strength))
        layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
        layer.putalpha(shadow)
        base.alpha_composite(layer)

    window = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    window.paste(image, (0, 0), mask)
    # A hairline edge so a light window still reads on a light page.
    edge = Image.new("L", (width, height), 0)
    ImageDraw.Draw(edge).rounded_rectangle(
        (0, 0, width - 1, height - 1), radius, outline=255, width=1
    )
    tint = (0, 0, 0, 40) if theme == "light" else (255, 255, 255, 36)
    outline = Image.new("RGBA", (width, height), tint)
    outline.putalpha(ImageChops.multiply(edge, Image.new("L", (width, height), tint[3])))
    window.alpha_composite(outline)
    base.alpha_composite(window, (x, y))


for theme in ("light", "dark"):
    base = Image.new("RGBA", canvas, (0, 0, 0, 0))
    place(base, Image.open(images / "windows-host" / f"overview-{theme}.png"), windows_frame, 8, theme)
    place(base, Image.open(images / "macos-host" / f"overview-{theme}.png"), mac_frame, 16, theme)
    path = output / f"hero-{theme}.png"
    base.save(path, optimize=True)
    print(f"Saved {path.relative_to(root)} ({base.width}x{base.height})")
