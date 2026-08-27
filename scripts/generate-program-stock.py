from pathlib import Path
import random

from PIL import Image, ImageDraw, ImageFilter


WIDTH = 1800
HEIGHT = 1200
SEED = 20260827
OUTPUT = Path(__file__).resolve().parents[1] / "public" / "assets" / "program-stock.webp"


def build_program_stock() -> Image.Image:
    rng = random.Random(SEED)
    stock = Image.new("RGB", (WIDTH, HEIGHT), (211, 197, 166))

    cloud = Image.new("RGBA", stock.size, (0, 0, 0, 0))
    cloud_draw = ImageDraw.Draw(cloud)
    for _ in range(180):
        x = rng.randint(-220, WIDTH)
        y = rng.randint(-160, HEIGHT)
        radius_x = rng.randint(90, 360)
        radius_y = rng.randint(45, 210)
        warm = rng.choice(((119, 78, 42, 8), (255, 244, 214, 10), (76, 55, 34, 6)))
        cloud_draw.ellipse((x, y, x + radius_x, y + radius_y), fill=warm)
    stock = Image.alpha_composite(stock.convert("RGBA"), cloud.filter(ImageFilter.GaussianBlur(48)))

    fibers = Image.new("RGBA", stock.size, (0, 0, 0, 0))
    fiber_draw = ImageDraw.Draw(fibers)
    for _ in range(5600):
        x = rng.randrange(WIDTH)
        y = rng.randrange(HEIGHT)
        length = rng.randint(4, 36)
        drift = rng.choice((-2, -1, 0, 0, 0, 1, 2))
        color = rng.choice(((76, 55, 34, 18), (247, 232, 195, 23), (139, 103, 63, 14)))
        fiber_draw.line((x, y, min(WIDTH - 1, x + length), max(0, min(HEIGHT - 1, y + drift))), fill=color, width=1)
    for _ in range(1300):
        x = rng.randrange(WIDTH)
        y = rng.randrange(HEIGHT)
        radius = rng.choice((1, 1, 1, 2))
        color = rng.choice(((65, 46, 29, 22), (252, 238, 207, 28), (154, 105, 58, 18)))
        fiber_draw.ellipse((x, y, x + radius, y + radius), fill=color)
    stock = Image.alpha_composite(stock, fibers)

    marks = Image.new("RGBA", stock.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(marks)
    ink = (54, 45, 35, 80)
    cue = (190, 78, 28, 145)
    faint = (74, 59, 40, 38)
    inset = 54
    draw.rectangle((inset, inset, WIDTH - inset, HEIGHT - inset), outline=faint, width=2)
    for x, y, sx, sy in (
        (inset, inset, 1, 1),
        (WIDTH - inset, inset, -1, 1),
        (inset, HEIGHT - inset, 1, -1),
        (WIDTH - inset, HEIGHT - inset, -1, -1),
    ):
        draw.line((x, y, x + sx * 72, y), fill=ink, width=2)
        draw.line((x, y, x, y + sy * 72), fill=ink, width=2)
        draw.line((x + sx * 18, y + sy * 18, x + sx * 56, y + sy * 18), fill=cue, width=3)
    for x, y in ((150, HEIGHT // 2), (WIDTH - 150, HEIGHT // 2), (WIDTH // 2, 125), (WIDTH // 2, HEIGHT - 125)):
        draw.ellipse((x - 18, y - 18, x + 18, y + 18), outline=ink, width=2)
        draw.line((x - 31, y, x + 31, y), fill=ink, width=1)
        draw.line((x, y - 31, x, y + 31), fill=ink, width=1)
    for x in (330, 690, 1050, 1410):
        draw.line((x, 72, x + 72, 72), fill=cue, width=3)
        draw.line((x, HEIGHT - 72, x + 72, HEIGHT - 72), fill=cue, width=3)
    for y in range(170, HEIGHT - 130, 105):
        draw.ellipse((81, y, 91, y + 10), fill=(76, 57, 37, 42))
        draw.ellipse((WIDTH - 91, y, WIDTH - 81, y + 10), fill=(76, 57, 37, 42))

    return Image.alpha_composite(stock, marks).convert("RGB")


if __name__ == "__main__":
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    build_program_stock().save(OUTPUT, "WEBP", quality=92, method=6, exact=True)
    print(f"Wrote {OUTPUT} ({WIDTH}x{HEIGHT}, seed {SEED})")
