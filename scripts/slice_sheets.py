"""Slice AI sprite sheets into per-cell 64x64 PNGs and build manifest.json."""
from __future__ import annotations
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SHEETS = Path("/mnt/documents/sheets")
OUT = ROOT / "public" / "game"
CELL = 64
INSET = 0.06


def slice_sheet(path, cols, rows, chroma_key):
    img = Image.open(path).convert("RGBA")
    w, h = img.size
    cw, ch = w / cols, h / rows
    ix, iy = cw * INSET, ch * INSET
    cells = []
    for r in range(rows):
        for c in range(cols):
            box = (int(c*cw+ix), int(r*ch+iy), int((c+1)*cw-ix), int((r+1)*ch-iy))
            cell = img.crop(box).resize((CELL, CELL), Image.NEAREST)
            if chroma_key:
                cell = remove_magenta(cell)
            cells.append(cell)
    return cells


def remove_magenta(img):
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r > 200 and g < 90 and b > 200:
                px[x, y] = (0, 0, 0, 0)
    return img


# ---- Enemies: 5 hand-crafted, one image each, scaled to 64x64 ----
enemy_files = [
    ("slime",       "enemy_slime.png",       1, dict(hp=25,  atk=3,  df=0, xp=10,  gold=[1,4],   color="#7cff7c")),
    ("goblin",      "enemy_goblin.png",      2, dict(hp=55,  atk=6,  df=1, xp=25,  gold=[3,10],  color="#89e05a")),
    ("skeleton",    "enemy_skeleton.png",    3, dict(hp=95,  atk=10, df=2, xp=55,  gold=[8,20],  color="#dcdcdc")),
    ("necromancer", "enemy_necromancer.png", 4, dict(hp=160, atk=16, df=3, xp=110, gold=[20,45], color="#b48cff")),
    ("dragon",      "enemy_dragon.png",      5, dict(hp=260, atk=24, df=5, xp=220, gold=[50,120],color="#ff7a3d")),
]
(OUT / "enemies").mkdir(parents=True, exist_ok=True)
enemy_manifest = []
for i, (name, fname, tier, s) in enumerate(enemy_files, start=1):
    img = Image.open(SHEETS / fname).convert("RGBA")
    img = remove_magenta(img)
    img = img.resize((CELL, CELL), Image.LANCZOS)
    out = f"{i:02d}_{name}.png"
    img.save(OUT / "enemies" / out)
    enemy_manifest.append({
        "id": i, "name": name.replace("_"," ").title(),
        "sprite": f"/game/enemies/{out}",
        "hp": s["hp"], "atk": s["atk"], "def": s["df"],
        "xp": s["xp"], "gold": s["gold"], "tier": tier,
        "color": s["color"],
    })

# ---- Biomes: 10 original + 30 new = 40 total ----
tile_labels = ["ground","ground_var","path","decoration","obstacle","feature"]

biome_groups = [
    ("tiles_all.png",  ["grassland","desert","snow","swamp","lava","cave","beach","forest","ruins","crystal"]),
    ("tiles_new1.png", ["tundra","jungle","mushroom","volcano","coral_reef","wasteland","mesa","savanna","taiga","oasis"]),
    ("tiles_new2.png", ["glacier","badlands","meadow","bamboo","obsidian","sky_islands","void","corrupted","holy","underworld"]),
    ("tiles_new3.png", ["mangrove","canyon","plains","highlands","marsh","ashland","moonstone","sunken_city","fairy_grove","dragon_peak"]),
]

tiles_manifest = {}
for sheet, names in biome_groups:
    cells = slice_sheet(SHEETS / sheet, 6, 10, False)
    for row, biome in enumerate(names):
        (OUT / "tiles" / biome).mkdir(parents=True, exist_ok=True)
        tiles_manifest[biome] = []
        for col, label in enumerate(tile_labels):
            cell = cells[row * 6 + col]
            f = f"{col}_{label}.png"
            cell.save(OUT / "tiles" / biome / f)
            tiles_manifest[biome].append({
                "index": col, "label": label,
                "sprite": f"/game/tiles/{biome}/{f}",
                "walkable": col in (0, 1, 2),
            })

# ---- Water tiles ----
water_labels = ["deep","shallow","waves","lily","shore","river","lagoon","frozen"]
water_cells = slice_sheet(SHEETS / "water.png", 4, 2, False)
(OUT / "tiles" / "water").mkdir(parents=True, exist_ok=True)
water_manifest = []
for i, label in enumerate(water_labels):
    f = f"{i}_{label}.png"
    water_cells[i].save(OUT / "tiles" / "water" / f)
    water_manifest.append({"index": i, "label": label, "sprite": f"/game/tiles/water/{f}"})

item_names = [
    "wooden_sword","iron_sword","steel_sword","magic_sword","battle_axe","war_hammer","bow","staff",
    "leather_cap","iron_helmet","wooden_shield","iron_shield","magic_shield","leather_chest","iron_chest","magic_robe",
    "health_potion","mana_potion","antidote","strength_potion","bread","apple","cooked_meat","fish",
    "brass_key","silver_key","chest_closed","chest_open","scroll","spellbook","ruby","sapphire",
]
cells_items = slice_sheet(SHEETS / "items.png", 8, 4, True)
items_manifest = []
for i, (cell, name) in enumerate(zip(cells_items, item_names)):
    fname = f"{i:02d}_{name}.png"
    cell.save(OUT / "items" / fname)
    items_manifest.append({"id": i, "name": name.replace("_", " ").title(), "sprite": f"/game/items/{fname}"})

ui_names = [
    "coin_copper","coin_silver","coin_gold","coin_gem",
    "btn_idle","btn_hover","btn_pressed","panel",
    "heart_full","heart_empty","mana_orb","star",
    "corner_tl","corner_tr","corner_bl","corner_br",
]
cells_ui = slice_sheet(SHEETS / "ui.png", 4, 4, True)
ui_manifest = {}
(OUT / "ui").mkdir(parents=True, exist_ok=True)
for cell, name in zip(cells_ui, ui_names):
    cell.save(OUT / "ui" / f"{name}.png")
    ui_manifest[name] = f"/game/ui/{name}.png"
coins_manifest = {
    "copper": ui_manifest["coin_copper"], "silver": ui_manifest["coin_silver"],
    "gold": ui_manifest["coin_gold"], "gem": ui_manifest["coin_gem"],
}

cells_player = slice_sheet(SHEETS / "player.png", 4, 4, True)
(OUT / "player").mkdir(parents=True, exist_ok=True)
player_manifest = {}
for row, d in enumerate(["down","left","right","up"]):
    player_manifest[d] = []
    for f in range(4):
        cell = cells_player[row * 4 + f]
        fname = f"{d}_{f}.png"
        cell.save(OUT / "player" / fname)
        player_manifest[d].append(f"/game/player/{fname}")

manifest = {
    "cell": CELL, "enemies": enemy_manifest, "biomes": tiles_manifest,
    "items": items_manifest, "ui": ui_manifest, "coins": coins_manifest, "player": player_manifest,
}
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(f"OK: {len(enemy_manifest)} enemies, {sum(len(v) for v in tiles_manifest.values())} tiles, {len(items_manifest)} items, {len(ui_names)} ui, player 16 frames")
