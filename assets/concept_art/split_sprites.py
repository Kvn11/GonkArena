"""Split sprite sheets into individual sprites with transparent background.

Two sheet formats are supported:

* SPRITES — hand-picked bounding boxes inside `character_sprite_sheet.png`
  (the original mixed-pose sheet).
* GRIDS — uniform 3×2 grids of walking frames (one sheet per direction).

Background is removed by flood-filling from each cropped image's corners,
which preserves any gray pixels that happen to sit inside the sprite (e.g.,
shading on the shorts).
"""
from PIL import Image
from collections import deque

SHEET = "assets/concept_art/character_sprite_sheet.png"
OUT_DIR = "assets/concept_art/sprites"

# Hand-picked bboxes inside character_sprite_sheet.png: (name, x0, y0, x1, y1)
ROW1_Y = (142, 486)
ROW2_Y = (607, 945)
SPRITES = [
    ("01_idle_front",      79, *(ROW1_Y[:1]),  220, ROW1_Y[1]),
    ("02_idle_three_qtr", 309, ROW1_Y[0],      438, ROW1_Y[1]),
    ("07_fighting_stance",123, ROW2_Y[0],      316, ROW2_Y[1]),
    ("08_punch",          461, ROW2_Y[0],      717, ROW2_Y[1]),
    ("09_kick",           780, ROW2_Y[0],     1045, ROW2_Y[1]),
    ("10_hurt",          1127, ROW2_Y[0],     1324, ROW2_Y[1]),
]

# Uniform grid sheets: 3 columns × 2 rows = 6 frames each, row-major.
GRIDS = [
    ("walking_left",  "assets/concept_art/walking_left_sprite_sheet.png",  3, 2),
    ("walking_up",    "assets/concept_art/walking_up_sprite_sheet.png",    3, 2),
    ("walking_down",  "assets/concept_art/walking_down_sprite_sheet.png",  3, 2),
]

MARGIN = 6           # pixels of padding around each cropped sprite
BG_TOL = 18          # max per-channel diff from seed color to count as background
EDGE_TOL = 28        # softer threshold for feathering near edges

def remove_background(im):
    """Flood-fill background starting from the four corners. Returns RGBA."""
    rgba = im.convert("RGBA")
    w, h = rgba.size
    px = rgba.load()

    # Build set of seed colors from the four corners.
    seeds = [px[0, 0], px[w-1, 0], px[0, h-1], px[w-1, h-1]]

    def matches_bg(c, tol):
        for s in seeds:
            if (abs(c[0]-s[0]) <= tol and
                abs(c[1]-s[1]) <= tol and
                abs(c[2]-s[2]) <= tol):
                return True
        return False

    visited = [[False]*h for _ in range(w)]
    q = deque()
    for sx, sy in [(0,0), (w-1,0), (0,h-1), (w-1,h-1)]:
        q.append((sx, sy))

    while q:
        x, y = q.popleft()
        if x < 0 or x >= w or y < 0 or y >= h or visited[x][y]:
            continue
        c = px[x, y]
        if not matches_bg(c, BG_TOL):
            continue
        visited[x][y] = True
        px[x, y] = (0, 0, 0, 0)
        q.append((x+1, y)); q.append((x-1, y))
        q.append((x, y+1)); q.append((x, y-1))

    # Second pass: feather anti-aliased halo. Any still-opaque pixel that is
    # close to background AND adjacent to a transparent pixel gets partial alpha.
    for y in range(h):
        for x in range(w):
            if visited[x][y]:
                continue
            c = px[x, y]
            if not matches_bg(c, EDGE_TOL):
                continue
            adj_transparent = False
            for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                nx, ny = x+dx, y+dy
                if 0 <= nx < w and 0 <= ny < h and visited[nx][ny]:
                    adj_transparent = True
                    break
            if not adj_transparent:
                continue
            # distance from nearest seed determines alpha
            d = min(max(abs(c[i]-s[i]) for i in range(3)) for s in seeds)
            alpha = max(0, min(255, int(255 * d / EDGE_TOL)))
            px[x, y] = (c[0], c[1], c[2], alpha)

    return rgba


def split_named(sheet, sprites):
    W, H = sheet.size
    for name, x0, y0, x1, y1 in sprites:
        cx0 = max(0, x0 - MARGIN)
        cy0 = max(0, y0 - MARGIN)
        cx1 = min(W - 1, x1 + MARGIN)
        cy1 = min(H - 1, y1 + MARGIN)
        crop = sheet.crop((cx0, cy0, cx1 + 1, cy1 + 1))
        out = remove_background(crop)
        bbox = out.getbbox()
        if bbox:
            out = out.crop(bbox)
        path = f"{OUT_DIR}/{name}.png"
        out.save(path)
        print(f"  saved {path}  ({out.size[0]}x{out.size[1]})")


def split_grid(prefix, sheet_path, cols, rows):
    sheet = Image.open(sheet_path)
    W, H = sheet.size
    cw, ch = W // cols, H // rows
    i = 0
    for r in range(rows):
        for c in range(cols):
            i += 1
            x0 = c * cw
            y0 = r * ch
            x1 = (c + 1) * cw - 1 if c < cols - 1 else W - 1
            y1 = (r + 1) * ch - 1 if r < rows - 1 else H - 1
            crop = sheet.crop((x0, y0, x1 + 1, y1 + 1))
            out = remove_background(crop)
            bbox = out.getbbox()
            if bbox:
                out = out.crop(bbox)
            path = f"{OUT_DIR}/{prefix}_{i}.png"
            out.save(path)
            print(f"  saved {path}  ({out.size[0]}x{out.size[1]})")


def main():
    print(f"splitting {SHEET}")
    split_named(Image.open(SHEET), SPRITES)
    for prefix, sheet_path, cols, rows in GRIDS:
        print(f"splitting {sheet_path}")
        split_grid(prefix, sheet_path, cols, rows)


if __name__ == "__main__":
    main()
