"""
Processes the new character source art into game-ready sprites.

For each source image (idle PNGs and walking GIFs):
  1. Floodfill the gray background to transparent.
  2. Keep only the largest connected component of opaque pixels — drops the
     tiny sparkle/diamond decorations the floodfill leaves behind.
  3. Crop to the alpha bounding box. For each walk GIF the bbox is shared
     across all sampled frames (union bbox), so the character's gait stays
     stable within the bbox instead of jittering frame-to-frame.
  4. Scale by a per-group factor so every group's character ends up the
     same height in canvas pixels. (The idle PNGs are ~5x the resolution
     of the walk GIFs, so they need very different scale factors.)
  5. Paste each scaled crop into a single fixed-size canvas with the
     character horizontally centered and feet flush with the canvas bottom.
     Phaser anchors sprites at (0.5, 1.0), so this puts the character's
     feet exactly on the tile center.

Run from repo root:
    python3 assets/concept_art/process_new_sprites.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "sprites"
OUT_DIR.mkdir(exist_ok=True)

# Background gradient is ~218-243 light gray; tolerance of 35 catches it
# without bleeding into the character's pale skin.
BG_TOLERANCE = 35
SAMPLED_FRAMES = 24
# Target character height in canvas pixels. Phaser will further downscale to
# TILE_H * 3 = 96 px on screen, so this just needs to be high enough to retain
# detail when downsampled. 180 matches the walking GIF's native character
# height so those frames don't get upsampled (the idle PNGs get downsampled).
TARGET_CHAR_HEIGHT = 180
TOP_PAD = 4
SIDE_PAD = 4


def remove_bg(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    w, h = img.size
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(img, seed, (0, 0, 0, 0), thresh=BG_TOLERANCE)
    return img


def keep_largest_component(img: Image.Image) -> Image.Image:
    """Mark each connected component of opaque pixels with a unique value via
    floodfill, then keep only the one with the most pixels. The floodfill is
    C-optimized so this is fast even though the outer scan is pure Python."""
    img = img.convert("RGBA")
    alpha = img.split()[3]
    mask = alpha.copy()                       # 'L' mode: 0 transparent, 255 opaque
    pixels = mask.load()
    w, h = mask.size
    seeds: list[int] = []
    fill_value = 1
    for y in range(h):
        for x in range(w):
            if pixels[x, y] == 255:
                ImageDraw.floodfill(mask, (x, y), fill_value, thresh=0)
                seeds.append(fill_value)
                fill_value += 1
                if fill_value > 200:          # absurd number of components — bail
                    break
        if fill_value > 200:
            break
    if not seeds:
        return img
    hist = mask.histogram()
    best = max(seeds, key=lambda v: hist[v])
    new_alpha = mask.point(lambda v: 255 if v == best else 0)
    out = img.copy()
    out.putalpha(new_alpha)
    return out


def sample_gif(path: Path, n: int) -> list[Image.Image]:
    g = Image.open(path)
    total = getattr(g, "n_frames", 1)
    step = total / n
    out: list[Image.Image] = []
    for i in range(n):
        g.seek(int(i * step))
        out.append(g.convert("RGBA"))
    return out


def union_bbox(boxes):
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def clean(img: Image.Image) -> Image.Image:
    return keep_largest_component(remove_bg(img))


def main() -> None:
    print("loading & cleaning source images...")
    # Each source records:
    #   frames     — list of cleaned RGBA images (1 for idle, N for gifs)
    #   crop_bbox  — rect to crop every frame to (own bbox / union for gifs)
    #   char_h_src — source-pixel height we treat as "the character height".
    #                For idle this is the bbox height; for walks it's the
    #                MEDIAN per-frame bbox height — not the union, which is
    #                inflated by head-bob extremes and would make individual
    #                walk frames render shorter than the idle.
    sources: dict[str, dict] = {}

    for key, src_name in [("idle_back", "standing_idle_back_right.png"),
                          ("idle_front", "standing_idle_front_right.png")]:
        img = clean(Image.open(ROOT / src_name))
        bbox = img.getbbox()
        if bbox is None:
            raise RuntimeError(f"{src_name}: nothing opaque after cleaning")
        sources[key] = {
            "frames": [img],
            "crop_bbox": bbox,
            "char_h_src": bbox[3] - bbox[1],
        }

    for key, src_name in [("walk_back", "walking_back_right.gif"),
                          ("walk_front", "walking_front_right.gif")]:
        frames = [clean(f) for f in sample_gif(ROOT / src_name, SAMPLED_FRAMES)]
        per_frame_boxes = [f.getbbox() for f in frames if f.getbbox() is not None]
        if not per_frame_boxes:
            raise RuntimeError(f"{src_name}: nothing opaque after cleaning")
        # MEAN per-frame height (not median): per-frame heights tend to cluster
        # bimodally (head up vs head down poses), so median picks one cluster
        # and underrepresents the other. Using mean makes the *average*
        # walking-frame height match the idle exactly, with natural head-bob
        # symmetric around it.
        heights = [b[3] - b[1] for b in per_frame_boxes]
        mean_h = sum(heights) / len(heights)
        sources[key] = {
            "frames": frames,
            "crop_bbox": union_bbox(per_frame_boxes),
            "char_h_src": mean_h,
        }

    # Jab sprite sheets: two POVs, both right-handed strikes.
    #   - front-view sheet: 5 cells (1195x896). Stance = cell 2 (0-idx 1,
    #     wind-up / fist drawn back), jab = cell 4 (0-idx 3, arm extended).
    #     Other cells are unused source material.
    #   - back-view sheet: 2 cells (1195x896, 597 wide each). Stance = cell 1
    #     (0-idx 0), jab = cell 2 (0-idx 1).
    #
    # Cells are widened by CELL_OVERFLOW on each side because some poses
    # (notably the front jab) have an extended fist that crosses the nominal
    # cell boundary into the neighbour. keep_largest_component() inside
    # clean() filters out the neighbouring characters, so we end up with just
    # the target pose plus its overflow extremity. Without this padding the
    # front jab's fist gets sliced off at the knuckle.
    # Per-cell bbox + own char height so each pose lands consistently with
    # idle/walk (feet at canvas bottom, character ~TARGET_CHAR_HEIGHT tall).
    CELL_OVERFLOW = 80
    jab_specs = [
        ("jab_right_sprite_sheet.png",      5, [("punch_stance_front", 1), ("punch_jab_front", 3)]),
        ("jab_right_back_sprite_sheet.png", 2, [("punch_stance_back",  0), ("punch_jab_back",  1)]),
    ]
    for sheet_name, n_cells, cell_keys in jab_specs:
        sheet = Image.open(ROOT / sheet_name).convert("RGBA")
        cell_w = sheet.width // n_cells
        for key, cell_index in cell_keys:
            left  = max(0,            cell_index * cell_w       - CELL_OVERFLOW)
            right = min(sheet.width, (cell_index + 1) * cell_w  + CELL_OVERFLOW)
            cell = sheet.crop((left, 0, right, sheet.height))
            img = clean(cell)
            bbox = img.getbbox()
            if bbox is None:
                raise RuntimeError(f"{sheet_name} cell {cell_index}: nothing opaque after cleaning")
            sources[key] = {
                "frames": [img],
                "crop_bbox": bbox,
                "char_h_src": bbox[3] - bbox[1],
            }

    # Per-group scale: TARGET_CHAR_HEIGHT / char_h_src. Idle and median walk
    # frame both land at exactly TARGET_CHAR_HEIGHT in canvas; outlier walk
    # frames (head-bob peaks) extend a little past it.
    print("computing scales & canvas...")
    scales: dict[str, float] = {}
    max_w = max_h = 0
    for key, info in sources.items():
        s = TARGET_CHAR_HEIGHT / info["char_h_src"]
        scales[key] = s
        l, t, r, b = info["crop_bbox"]
        sw = round((r - l) * s)
        sh = round((b - t) * s)
        max_w = max(max_w, sw)
        max_h = max(max_h, sh)
        print(f"  {key:11s} crop={info['crop_bbox']}  char_h_src={info['char_h_src']:6.1f}  scale={s:.3f}  scaled_crop={sw}x{sh}")

    canvas_w = max_w + 2 * SIDE_PAD
    canvas_h = max_h + TOP_PAD
    if canvas_w % 2:
        canvas_w += 1
    print(f"canvas: {canvas_w}x{canvas_h}")

    def place(img: Image.Image, crop_bbox, scale: float, frame_bbox=None) -> Image.Image:
        """Paste a scaled, cropped frame into the unified canvas.

        Horizontal alignment uses the crop bbox center (union for walks) so the
        body stays horizontally locked as feet/arms swing.

        Vertical alignment puts the planted foot at canvas bottom. For idles
        the frame bbox == crop bbox so the crop bottom == foot Y. For walks,
        passing `frame_bbox` lets us shift the cropped image down so THIS
        frame's foot lands at canvas bottom even if other frames in the cycle
        had opaque pixels extending lower. Without this the feet wobble 0-5px
        above the tile during the gait."""
        cropped = img.crop(crop_bbox)
        scaled = cropped.resize(
            (round(cropped.width * scale), round(cropped.height * scale)),
            Image.LANCZOS,
        )
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
        x = (canvas_w - scaled.width) // 2
        # Pixels between this frame's foot and the bottom edge of the crop:
        # source-space gap = (crop bbox bottom) - (frame bbox bottom).
        # Multiply by scale to translate into canvas pixels.
        fb = frame_bbox if frame_bbox is not None else crop_bbox
        foot_above_crop_bottom = round((crop_bbox[3] - fb[3]) * scale)
        y = canvas_h - scaled.height + foot_above_crop_bottom
        canvas.paste(scaled, (x, y), scaled)
        return canvas

    def save_pair(img: Image.Image, right_name: str, left_name: str) -> None:
        img.save(OUT_DIR / right_name, "PNG")
        img.transpose(Image.FLIP_LEFT_RIGHT).save(OUT_DIR / left_name, "PNG")

    print("writing sprites...")
    for key, right_name, left_name in [
        ("idle_back",  "idle_back_right.png",  "idle_back_left.png"),
        ("idle_front", "idle_front_right.png", "idle_front_left.png"),
    ]:
        info = sources[key]
        save_pair(place(info["frames"][0], info["crop_bbox"], scales[key]),
                  right_name, left_name)

    for key, right_prefix, left_prefix in [
        ("walk_back",  "walk_back_right",  "walk_back_left"),
        ("walk_front", "walk_front_right", "walk_front_left"),
    ]:
        info = sources[key]
        for i, frame in enumerate(info["frames"], start=1):
            save_pair(place(frame, info["crop_bbox"], scales[key], frame_bbox=frame.getbbox()),
                      f"{right_prefix}_{i}.png",
                      f"{left_prefix}_{i}.png")

    # Punch sprites: one right-facing PNG per (move, view). The Phaser scene
    # flips horizontally for the screen-left directions and picks back/front
    # by direction (up/left → back, down/right → front).
    for key in ["punch_stance_front", "punch_jab_front",
                "punch_stance_back",  "punch_jab_back"]:
        info = sources[key]
        place(info["frames"][0], info["crop_bbox"], scales[key]).save(OUT_DIR / f"{key}.png", "PNG")
    print("done.")


if __name__ == "__main__":
    main()
