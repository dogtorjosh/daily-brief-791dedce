"""
One-time icon generator for the Daily Brief PWA.
Run with: python make_icons.py
Produces a clean green monogram icon in several sizes under icons/.
Re-run only if you want to change the look. Icons are committed to the repo.
"""
from PIL import Image, ImageDraw, ImageFont
import os

GREEN = (47, 111, 79)      # --accent #2f6f4f
WHITE = (255, 255, 255)
HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(HERE, "icons")
os.makedirs(ICONS, exist_ok=True)

FONT_PATH = "C:/Windows/Fonts/seguisb.ttf"  # Segoe UI Semibold
MONOGRAM = "DB"


def font(size):
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except Exception:
        return ImageFont.load_default()


def make_icon(size, maskable=False):
    """Full-bleed green tile with a centered white monogram.
    maskable=True keeps the monogram well inside the safe zone for iOS/Android masking."""
    img = Image.new("RGB", (size, size), GREEN)
    d = ImageDraw.Draw(img)
    # font size: smaller for maskable so it survives a circular mask
    fs = int(size * (0.42 if maskable else 0.5))
    f = font(fs)
    bbox = d.textbbox((0, 0), MONOGRAM, font=f)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = (size - w) / 2 - bbox[0]
    y = (size - h) / 2 - bbox[1]
    d.text((x, y), MONOGRAM, font=f, fill=WHITE)
    return img


def save(img, name):
    p = os.path.join(ICONS, name)
    img.save(p, "PNG")
    print("wrote", p)


if __name__ == "__main__":
    save(make_icon(192, maskable=True), "icon-192.png")
    save(make_icon(512, maskable=True), "icon-512.png")
    # iOS home-screen icon: no transparency, no rounded corners (iOS rounds it itself)
    save(make_icon(180, maskable=False), "apple-touch-icon.png")
    save(make_icon(32, maskable=False), "favicon-32.png")
    print("done")
