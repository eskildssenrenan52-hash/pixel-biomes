import { useEffect, useMemo, useRef, useState } from "react";
import { loadImage, loadManifest, type Manifest, type EnemyDef } from "./manifest";

const TILE = 64;
const VIEW_TILES_X = 11;
const VIEW_TILES_Y = 15;
const WORLD = 400;                 // 5x bigger than before (was 80)
const BIOME_SEED_COUNT = 80;       // number of Voronoi biome regions

type Dir = "down" | "left" | "right" | "up";
type Enemy = { def: EnemyDef; x: number; y: number; hp: number; img: HTMLImageElement };
type Drop = { x: number; y: number; kind: "coin" | "item"; img: HTMLImageElement; value: number; name: string };
type FloatText = { x: number; y: number; text: string; color: string; life: number };
type Quest = { biome: string; goal: number; progress: number; rewardGold: number; rewardXp: number; rewardItem?: string; done: boolean };
type InvItem = { name: string; sprite: string; count: number };

// deterministic hashing
function hash2(x: number, y: number, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h >>> 0;
  return h / 0xffffffff;
}
// smooth value noise (bilinear over integer grid)
function noise2(x: number, y: number, scale = 12, seed = 0) {
  const xs = x / scale, ys = y / scale;
  const x0 = Math.floor(xs), y0 = Math.floor(ys);
  const fx = xs - x0, fy = ys - y0;
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  return a * (1 - sx) * (1 - sy) + b * sx * (1 - sy) + c * (1 - sx) * sy + d * sx * sy;
}

type Seed = { x: number; y: number; biome: string };
function buildSeeds(biomes: string[]): Seed[] {
  const seeds: Seed[] = [];
  for (let i = 0; i < BIOME_SEED_COUNT; i++) {
    const rx = hash2(i, 1, 42);
    const ry = hash2(i, 2, 42);
    seeds.push({
      x: Math.floor(rx * WORLD),
      y: Math.floor(ry * WORLD),
      biome: biomes[i % biomes.length],
    });
  }
  return seeds;
}

export default function Game() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"loading" | "playing" | "dead">("loading");
  const [hud, setHud] = useState({ hp: 100, maxHp: 100, gold: 0, xp: 0, xpNext: 50, level: 1 });
  const [modal, setModal] = useState<null | "inv" | "map" | "quests">(null);
  const [invView, setInvView] = useState<InvItem[]>([]);
  const [questView, setQuestView] = useState<Quest[]>([]);
  const [currentBiome, setCurrentBiome] = useState("grassland");

  const stateRef = useRef<{
    manifest: Manifest | null;
    images: Map<string, HTMLImageElement>;
    playerImgs: Record<Dir, HTMLImageElement[]>;
    tileImgs: Record<string, HTMLImageElement[]>;
    waterImgs: HTMLImageElement[];
    seeds: Seed[];
    biomeList: string[];
    px: number; py: number; dir: Dir; frame: number; moveCooldown: number;
    enemies: Enemy[];
    drops: Drop[];
    floats: FloatText[];
    keys: Set<string>;
    touchDir: Dir | null;
    attackReq: boolean;
    hp: number; maxHp: number; gold: number; xp: number; level: number;
    inv: Map<string, InvItem>;
    quests: Record<string, Quest>;
    lastSpawn: number;
  }>({
    manifest: null, images: new Map(),
    playerImgs: { down: [], left: [], right: [], up: [] },
    tileImgs: {}, waterImgs: [],
    seeds: [], biomeList: [],
    px: Math.floor(WORLD / 2), py: Math.floor(WORLD / 2),
    dir: "down", frame: 0, moveCooldown: 0,
    enemies: [], drops: [], floats: [],
    keys: new Set(), touchDir: null, attackReq: false,
    hp: 100, maxHp: 100, gold: 0, xp: 0, level: 1,
    inv: new Map(), quests: {}, lastSpawn: 0,
  });

  // Load assets
  useEffect(() => {
    (async () => {
      const m = await loadManifest();
      const s = stateRef.current;
      s.manifest = m;
      s.biomeList = Object.keys(m.biomes);
      s.seeds = buildSeeds(s.biomeList);

      for (const d of ["down","left","right","up"] as Dir[]) {
        s.playerImgs[d] = await Promise.all(m.player[d].map(loadImage));
      }
      const entries = Object.entries(m.biomes);
      await Promise.all(entries.map(async ([b, tiles]) => {
        s.tileImgs[b] = await Promise.all(tiles.map(t => loadImage(t.sprite)));
      }));
      s.waterImgs = await Promise.all((m.water ?? []).map(w => loadImage(w.sprite)));
      const misc = [
        ...Object.values(m.ui),
        ...m.enemies.map(e => e.sprite),
        ...m.items.map(i => i.sprite),
      ];
      await Promise.all(misc.map(async src => { s.images.set(src, await loadImage(src)); }));

      // seed quests per biome
      s.quests = {};
      for (const b of s.biomeList) {
        s.quests[b] = {
          biome: b,
          goal: 5,
          progress: 0,
          rewardGold: 30 + s.biomeList.indexOf(b) * 5,
          rewardXp: 25 + s.biomeList.indexOf(b) * 3,
          rewardItem: m.items[s.biomeList.indexOf(b) % m.items.length]?.name,
          done: false,
        };
      }

      // ensure spawn is on land: search outward for walkable
      let found = false;
      for (let r = 0; r < 30 && !found; r++) {
        for (let dy = -r; dy <= r && !found; dy++) {
          for (let dx = -r; dx <= r && !found; dx++) {
            const tx = s.px + dx, ty = s.py + dy;
            if (isWalkable(tx, ty)) { s.px = tx; s.py = ty; found = true; }
          }
        }
      }
      setStatus("playing");
    })().catch(err => console.error(err));
  }, []);

  // Voronoi biome lookup (nearest seed)
  const biomeAt = (tx: number, ty: number): string => {
    const s = stateRef.current;
    if (!s.seeds.length) return "grassland";
    let best = Infinity, biome = s.seeds[0].biome;
    for (const seed of s.seeds) {
      const dx = seed.x - tx, dy = seed.y - ty;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; biome = seed.biome; }
    }
    return biome;
  };

  // Water map: two-scale noise threshold
  function isWater(tx: number, ty: number): boolean {
    const large = noise2(tx, ty, 30, 7);
    const small = noise2(tx, ty, 8, 11);
    return large * 0.7 + small * 0.3 < 0.32;
  }

  function tileIndexAt(tx: number, ty: number): number {
    const n = hash2(tx, ty, 3);
    if (n < 0.68) return 0;
    if (n < 0.85) return 1;
    if (n < 0.93) return 2;
    if (n < 0.97) return 3;
    if (n < 0.99) return 4;
    return 5;
  }
  function isWalkable(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= WORLD || ty >= WORLD) return false;
    if (isWater(tx, ty)) return false;
    return tileIndexAt(tx, ty) <= 2;
  }

  // Precompute a mini world map for the map modal
  useEffect(() => {
    if (status !== "playing" || modal !== "map") return;
    const s = stateRef.current;
    const cvs = mapCanvasRef.current;
    if (!cvs) return;
    if (cvs.dataset.rendered === "1") return;
    const scale = 2; // 2px per tile -> 800px map
    cvs.width = WORLD * scale;
    cvs.height = WORLD * scale;
    const ctx = cvs.getContext("2d")!;
    // color per biome from hash
    const colorFor = (b: string) => {
      let h = 0; for (let i = 0; i < b.length; i++) h = (h * 31 + b.charCodeAt(i)) >>> 0;
      const hue = h % 360;
      return `hsl(${hue} 55% 45%)`;
    };
    // sample coarser: every tile
    for (let ty = 0; ty < WORLD; ty++) {
      for (let tx = 0; tx < WORLD; tx++) {
        if (isWater(tx, ty)) ctx.fillStyle = "#1e40af";
        else ctx.fillStyle = colorFor(biomeAt(tx, ty));
        ctx.fillRect(tx * scale, ty * scale, scale, scale);
      }
    }
    cvs.dataset.rendered = "1";
  }, [status, modal]);

  // Input
  useEffect(() => {
    const s = stateRef.current;
    const kd = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "i") { setModal(m => m === "inv" ? null : "inv"); refreshInvView(); return; }
      if (k === "m") { setModal(m => m === "map" ? null : "map"); return; }
      if (k === "q") { setModal(m => m === "quests" ? null : "quests"); refreshQuestView(); return; }
      if (k === "escape") { setModal(null); return; }
      s.keys.add(k);
      if (k === " " || k === "enter") s.attackReq = true;
    };
    const ku = (e: KeyboardEvent) => s.keys.delete(e.key.toLowerCase());
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => { window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku); };
  }, []);

  const refreshInvView = () => setInvView(Array.from(stateRef.current.inv.values()));
  const refreshQuestView = () => setQuestView(Object.values(stateRef.current.quests));

  // Main loop
  useEffect(() => {
    if (status !== "playing") return;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    let raf = 0;
    let last = performance.now();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
    };
    resize();
    window.addEventListener("resize", resize);

    const s = stateRef.current;

    const grantQuestRewardIfDone = (biome: string) => {
      const q = s.quests[biome];
      if (!q || q.done) return;
      q.progress += 1;
      if (q.progress >= q.goal) {
        q.done = true;
        s.gold += q.rewardGold;
        s.xp += q.rewardXp;
        s.floats.push({ x: s.px, y: s.py, text: `Quest! +${q.rewardGold}g +${q.rewardXp}xp`, color: "#ffd700", life: 90 });
        if (q.rewardItem && s.manifest) {
          const item = s.manifest.items.find(i => i.name === q.rewardItem);
          if (item) addInv(item.name, item.sprite);
        }
      }
    };

    const addInv = (name: string, sprite: string) => {
      const cur = s.inv.get(name);
      if (cur) cur.count += 1;
      else s.inv.set(name, { name, sprite, count: 1 });
    };

    const spawnEnemy = () => {
      if (!s.manifest) return;
      if (s.enemies.length >= 10) return;
      const angle = Math.random() * Math.PI * 2;
      const dist = 6 + Math.random() * 4;
      const tx = Math.round(s.px + Math.cos(angle) * dist);
      const ty = Math.round(s.py + Math.sin(angle) * dist);
      if (!isWalkable(tx, ty)) return;
      // Tier scales with level
      const tier = Math.min(5, 1 + Math.floor(s.level / 3));
      const pool = s.manifest.enemies.filter(e => e.tier <= tier);
      const def = pool[Math.floor(Math.random() * pool.length)];
      const img = s.images.get(def.sprite)!;
      s.enemies.push({ def, x: tx, y: ty, hp: def.hp, img });
    };

    const doAttack = () => {
      const dx = s.dir === "left" ? -1 : s.dir === "right" ? 1 : 0;
      const dy = s.dir === "up" ? -1 : s.dir === "down" ? 1 : 0;
      const tx = s.px + dx, ty = s.py + dy;
      const target = s.enemies.find(e => e.x === tx && e.y === ty);
      if (!target) return;
      const dmg = Math.max(1, 6 + s.level * 2 - target.def.def);
      target.hp -= dmg;
      s.floats.push({ x: target.x, y: target.y, text: `-${dmg}`, color: "#ffdd44", life: 40 });
      if (target.hp <= 0) {
        s.gold += Math.floor(target.def.gold[0] + Math.random() * (target.def.gold[1] - target.def.gold[0] + 1));
        s.xp += target.def.xp;
        if (Math.random() < 0.75) {
          const kinds: (keyof Manifest["coins"])[] = ["copper","silver","gold","gem"];
          const k = kinds[Math.min(3, Math.floor(target.def.tier / 2))];
          const src = s.manifest!.coins[k];
          const img = s.images.get(src)!;
          s.drops.push({ x: target.x, y: target.y, kind: "coin", img, value: [1,3,10,50][kinds.indexOf(k)], name: k });
        } else {
          const it = s.manifest!.items[Math.floor(Math.random() * s.manifest!.items.length)];
          s.drops.push({ x: target.x, y: target.y, kind: "item", img: s.images.get(it.sprite)!, value: 0, name: it.name });
        }
        // quest progress based on where the enemy died
        grantQuestRewardIfDone(biomeAt(target.x, target.y));
        s.enemies = s.enemies.filter(e => e !== target);
        const needed = s.level * 50;
        if (s.xp >= needed) { s.xp -= needed; s.level += 1; s.maxHp += 20; s.hp = s.maxHp;
          s.floats.push({ x: s.px, y: s.py, text: `LEVEL ${s.level}!`, color: "#00e5ff", life: 60 });
        }
      }
    };

    const enemyTurn = () => {
      for (const e of s.enemies) {
        const dx = Math.sign(s.px - e.x), dy = Math.sign(s.py - e.y);
        if (Math.abs(s.px - e.x) + Math.abs(s.py - e.y) === 1) {
          const dmg = Math.max(1, e.def.atk - s.level);
          s.hp -= dmg;
          s.floats.push({ x: s.px, y: s.py, text: `-${dmg}`, color: "#ff5555", life: 40 });
        } else {
          const stepX = Math.abs(s.px - e.x) >= Math.abs(s.py - e.y);
          if (stepX && isWalkable(e.x + dx, e.y) && !s.enemies.some(o => o !== e && o.x === e.x + dx && o.y === e.y) && !(e.x + dx === s.px && e.y === s.py)) e.x += dx;
          else if (isWalkable(e.x, e.y + dy) && !s.enemies.some(o => o !== e && o.x === e.x && o.y === e.y + dy) && !(e.x === s.px && e.y + dy === s.py)) e.y += dy;
        }
      }
    };

    const pickupDrops = () => {
      s.drops = s.drops.filter(d => {
        if (d.x === s.px && d.y === s.py) {
          if (d.kind === "coin") {
            s.gold += d.value;
            s.floats.push({ x: s.px, y: s.py, text: `+${d.value}g`, color: "#ffe066", life: 40 });
          } else {
            const it = s.manifest!.items.find(i => i.name === d.name);
            if (it) addInv(it.name, it.sprite);
            s.floats.push({ x: s.px, y: s.py, text: d.name, color: "#88ffcc", life: 50 });
          }
          return false;
        }
        return true;
      });
    };

    const step = (dt: number) => {
      if (modal) return; // pause world while modal open
      s.moveCooldown -= dt;
      s.frame = (s.frame + dt * 6) % 4;

      let mx = 0, my = 0, ndir: Dir | null = null;
      if (s.keys.has("arrowup") || s.keys.has("w") || s.touchDir === "up") { my = -1; ndir = "up"; }
      else if (s.keys.has("arrowdown") || s.keys.has("s") || s.touchDir === "down") { my = 1; ndir = "down"; }
      else if (s.keys.has("arrowleft") || s.keys.has("a") || s.touchDir === "left") { mx = -1; ndir = "left"; }
      else if (s.keys.has("arrowright") || s.keys.has("d") || s.touchDir === "right") { mx = 1; ndir = "right"; }

      let acted = false;
      if (ndir && s.moveCooldown <= 0) {
        s.dir = ndir;
        const nx = s.px + mx, ny = s.py + my;
        const blocker = s.enemies.find(e => e.x === nx && e.y === ny);
        if (blocker) { doAttack(); acted = true; }
        else if (isWalkable(nx, ny)) { s.px = nx; s.py = ny; acted = true; pickupDrops(); }
        s.moveCooldown = 0.14;
      }
      if (s.attackReq && s.moveCooldown <= 0) {
        s.attackReq = false;
        doAttack();
        acted = true;
        s.moveCooldown = 0.2;
      }
      if (acted) enemyTurn();

      s.lastSpawn += dt;
      if (s.lastSpawn > 1.2) { s.lastSpawn = 0; spawnEnemy(); }
      s.floats.forEach(f => { f.life -= 1; f.y -= 0.02; });
      s.floats = s.floats.filter(f => f.life > 0);
      if (s.hp <= 0) setStatus("dead");

      setHud({ hp: Math.max(0, s.hp), maxHp: s.maxHp, gold: s.gold, xp: s.xp, xpNext: s.level * 50, level: s.level });
      setCurrentBiome(biomeAt(s.px, s.py));
    };

    const drawTile = (tx: number, ty: number, sx: number, sy: number) => {
      if (tx < 0 || ty < 0 || tx >= WORLD || ty >= WORLD) {
        ctx.fillStyle = "#000"; ctx.fillRect(sx, sy, TILE, TILE); return;
      }
      if (isWater(tx, ty)) {
        const wIdx = Math.floor(hash2(tx, ty, 91) * s.waterImgs.length);
        const img = s.waterImgs[wIdx];
        if (img) ctx.drawImage(img, sx, sy, TILE, TILE);
        else { ctx.fillStyle = "#1e40af"; ctx.fillRect(sx, sy, TILE, TILE); }
        return;
      }
      const biome = biomeAt(tx, ty);
      const idx = tileIndexAt(tx, ty);
      const set = s.tileImgs[biome];
      if (!set) return;
      // For decoration/obstacle/feature (transparent sprites), paint ground beneath first
      if (idx >= 3) {
        const base = set[0];
        if (base) ctx.drawImage(base, sx, sy, TILE, TILE);
      }
      const img = set[idx];
      if (img) ctx.drawImage(img, sx, sy, TILE, TILE);
    };

    const draw = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      const startTx = Math.floor(s.px - VIEW_TILES_X);
      const endTx = Math.ceil(s.px + VIEW_TILES_X);
      const startTy = Math.floor(s.py - VIEW_TILES_Y);
      const endTy = Math.ceil(s.py + VIEW_TILES_Y);
      for (let ty = startTy; ty <= endTy; ty++) {
        for (let tx = startTx; tx <= endTx; tx++) {
          const sx = cx + (tx - s.px) * TILE - TILE / 2;
          const sy = cy + (ty - s.py) * TILE - TILE / 2;
          drawTile(tx, ty, sx, sy);
        }
      }
      for (const d of s.drops) {
        const sx = cx + (d.x - s.px) * TILE - TILE / 2;
        const sy = cy + (d.y - s.py) * TILE - TILE / 2;
        ctx.drawImage(d.img, sx + 8, sy + 8, TILE - 16, TILE - 16);
      }
      for (const e of s.enemies) {
        const sx = cx + (e.x - s.px) * TILE - TILE / 2;
        const sy = cy + (e.y - s.py) * TILE - TILE / 2;
        ctx.drawImage(e.img, sx, sy, TILE, TILE);
        const pct = Math.max(0, e.hp / e.def.hp);
        ctx.fillStyle = "#000"; ctx.fillRect(sx + 6, sy - 6, TILE - 12, 4);
        ctx.fillStyle = pct > 0.5 ? "#4ade80" : pct > 0.25 ? "#facc15" : "#ef4444";
        ctx.fillRect(sx + 6, sy - 6, (TILE - 12) * pct, 4);
      }
      const pImg = s.playerImgs[s.dir][Math.floor(s.frame)];
      if (pImg) ctx.drawImage(pImg, cx - TILE / 2, cy - TILE / 2, TILE, TILE);

      ctx.font = "bold 14px system-ui";
      ctx.textAlign = "center";
      for (const f of s.floats) {
        const sx = cx + (f.x - s.px) * TILE;
        const sy = cy + (f.y - s.py) * TILE - 10;
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillText(f.text, sx + 1, sy + 1);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, sx, sy);
      }
    };

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      step(dt);
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, [status, modal]);

  const restart = () => {
    const s = stateRef.current;
    s.px = Math.floor(WORLD / 2); s.py = Math.floor(WORLD / 2);
    // move to walkable
    for (let r = 0; r < 30; r++) {
      let found = false;
      for (let dy = -r; dy <= r && !found; dy++)
        for (let dx = -r; dx <= r && !found; dx++) {
          const tx = s.px + dx, ty = s.py + dy;
          if (isWalkable(tx, ty)) { s.px = tx; s.py = ty; found = true; }
        }
      if (found) break;
    }
    s.hp = 100; s.maxHp = 100; s.gold = 0; s.xp = 0; s.level = 1;
    s.inv.clear();
    for (const q of Object.values(s.quests)) { q.progress = 0; q.done = false; }
    s.enemies = []; s.drops = []; s.floats = [];
    setStatus("playing");
  };

  const dpad = (d: Dir | null) => { stateRef.current.touchDir = d; };

  const doneCount = useMemo(() => questView.filter(q => q.done).length, [questView]);
  const s = stateRef.current;
  const activeQuest = s.quests[currentBiome];

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black select-none">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ imageRendering: "pixelated" }} />

      {status === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center text-white text-xl">
          Loading assets…
        </div>
      )}

      {status === "playing" && (
        <>
          {/* HUD top */}
          <div className="absolute top-0 left-0 right-0 flex flex-wrap items-center gap-2 p-2 pointer-events-none">
            <div className="flex items-center gap-1 rounded-lg bg-black/70 px-2 py-1 text-white">
              <img src="/game/ui/heart_full.png" width={18} height={18} alt="" style={{ imageRendering: "pixelated" }} />
              <span className="tabular-nums text-xs font-bold">{hud.hp}/{hud.maxHp}</span>
            </div>
            <div className="flex items-center gap-1 rounded-lg bg-black/70 px-2 py-1 text-white">
              <img src="/game/ui/coin_gold.png" width={18} height={18} alt="" style={{ imageRendering: "pixelated" }} />
              <span className="tabular-nums text-xs font-bold">{hud.gold}</span>
            </div>
            <div className="flex items-center gap-1 rounded-lg bg-black/70 px-2 py-1 text-white">
              <img src="/game/ui/star.png" width={18} height={18} alt="" style={{ imageRendering: "pixelated" }} />
              <span className="tabular-nums text-xs font-bold">Lv {hud.level}</span>
              <span className="text-[10px] opacity-70">{hud.xp}/{hud.xpNext}</span>
            </div>
            <div className="rounded-lg bg-black/70 px-2 py-1 text-white text-xs font-bold capitalize">
              {currentBiome.replace(/_/g, " ")}
            </div>
          </div>

          {/* Right side action buttons */}
          <div className="absolute top-14 right-2 flex flex-col gap-2 pointer-events-auto">
            <IconBtn label="MAP" onClick={() => setModal(modal === "map" ? null : "map")} />
            <IconBtn label="QST" onClick={() => { setModal(modal === "quests" ? null : "quests"); refreshQuestView(); }} />
            <IconBtn label="INV" onClick={() => { setModal(modal === "inv" ? null : "inv"); refreshInvView(); }} />
          </div>

          {/* Active quest banner */}
          {activeQuest && !activeQuest.done && (
            <div className="absolute top-24 left-1/2 -translate-x-1/2 rounded-lg bg-black/70 px-3 py-1 text-white text-[11px] pointer-events-none">
              <span className="text-yellow-300 font-bold">Quest:</span>{" "}
              Defeat {activeQuest.goal} in {currentBiome.replace(/_/g, " ")} — {activeQuest.progress}/{activeQuest.goal}
            </div>
          )}

          {/* Dpad */}
          <div className="absolute bottom-6 left-6 grid grid-cols-3 grid-rows-3 gap-1 w-40 h-40 select-none">
            <div />
            <DPadBtn label="▲" onDown={() => dpad("up")} onUp={() => dpad(null)} />
            <div />
            <DPadBtn label="◀" onDown={() => dpad("left")} onUp={() => dpad(null)} />
            <div />
            <DPadBtn label="▶" onDown={() => dpad("right")} onUp={() => dpad(null)} />
            <div />
            <DPadBtn label="▼" onDown={() => dpad("down")} onUp={() => dpad(null)} />
            <div />
          </div>

          {/* Attack button */}
          <button
            onPointerDown={e => { e.preventDefault(); stateRef.current.attackReq = true; }}
            className="absolute bottom-10 right-6 h-24 w-24 rounded-full border-4 border-yellow-300 bg-red-600/90 text-white font-black text-lg shadow-lg active:scale-95"
          >
            ATK
          </button>

          {/* Modals */}
          {modal === "map" && (
            <Modal title="World Map" onClose={() => setModal(null)}>
              <div className="relative bg-black/60 rounded-lg overflow-auto max-h-[70vh]">
                <div className="relative">
                  <canvas ref={mapCanvasRef} className="block" style={{ imageRendering: "pixelated", width: "min(80vw, 800px)", height: "auto" }} />
                  {/* player marker */}
                  <PlayerMarker px={s.px} py={s.py} />
                </div>
                <div className="text-[10px] text-white/70 p-2">
                  Blue = water · Each color = a distinct biome region · Red dot = you
                </div>
              </div>
            </Modal>
          )}

          {modal === "quests" && (
            <Modal title={`Quests — ${doneCount}/${questView.length} done`} onClose={() => setModal(null)}>
              <div className="max-h-[70vh] overflow-auto space-y-2 pr-1">
                {questView.map(q => (
                  <div key={q.biome} className={`rounded-lg p-2 border ${q.done ? "bg-emerald-900/40 border-emerald-500/40" : "bg-black/40 border-white/10"}`}>
                    <div className="flex items-center justify-between">
                      <div className="font-bold text-sm capitalize">{q.biome.replace(/_/g, " ")}</div>
                      <div className="text-xs">{q.done ? "✓ Completed" : `${q.progress}/${q.goal}`}</div>
                    </div>
                    <div className="text-[11px] opacity-80">
                      Defeat {q.goal} enemies. Reward: {q.rewardGold}g + {q.rewardXp}xp{q.rewardItem ? ` + ${q.rewardItem}` : ""}
                    </div>
                    <div className="h-1.5 bg-white/10 rounded mt-1 overflow-hidden">
                      <div className="h-full bg-yellow-400" style={{ width: `${Math.min(100, (q.progress / q.goal) * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </Modal>
          )}

          {modal === "inv" && (
            <Modal title={`Inventory — ${hud.gold} gold`} onClose={() => setModal(null)}>
              <div className="grid grid-cols-6 gap-2 max-h-[70vh] overflow-auto">
                {invView.length === 0 && (
                  <div className="col-span-6 text-center text-white/60 text-sm py-8">
                    Empty. Defeat enemies to collect loot.
                  </div>
                )}
                {invView.map(it => (
                  <div key={it.name} className="relative aspect-square rounded bg-white/10 border border-white/10 flex items-center justify-center">
                    <img src={it.sprite} alt={it.name} className="w-10 h-10" style={{ imageRendering: "pixelated" }} />
                    {it.count > 1 && (
                      <span className="absolute bottom-0 right-0 text-[10px] font-bold bg-black/80 px-1 rounded">
                        ×{it.count}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </Modal>
          )}
        </>
      )}

      {status === "dead" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 text-white gap-4">
          <h2 className="text-4xl font-black tracking-widest text-red-500">YOU DIED</h2>
          <p className="text-white/80">Level {hud.level} · {hud.gold} gold</p>
          <button onClick={restart} className="rounded-lg bg-yellow-500 px-6 py-3 font-bold text-black hover:bg-yellow-400">
            Respawn
          </button>
        </div>
      )}
    </div>
  );
}

function DPadBtn({ label, onDown, onUp }: { label: string; onDown: () => void; onUp: () => void }) {
  return (
    <button
      onPointerDown={e => { e.preventDefault(); onDown(); }}
      onPointerUp={e => { e.preventDefault(); onUp(); }}
      onPointerLeave={onUp}
      onPointerCancel={onUp}
      className="rounded-lg bg-black/70 border border-white/20 text-white text-xl font-bold active:bg-white/20"
    >
      {label}
    </button>
  );
}

function IconBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg bg-black/70 border border-white/20 text-white text-[11px] font-black px-3 py-2 hover:bg-black/90 active:scale-95"
    >
      {label}
    </button>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-white/20 bg-neutral-900 text-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 p-3">
          <h3 className="font-black tracking-wide">{title}</h3>
          <button onClick={onClose} className="rounded bg-white/10 hover:bg-white/20 px-3 py-1 text-sm">
            Close ✕
          </button>
        </div>
        <div className="p-3">{children}</div>
      </div>
    </div>
  );
}

function PlayerMarker({ px, py }: { px: number; py: number }) {
  const left = (px / WORLD) * 100;
  const top = (py / WORLD) * 100;
  return (
    <div
      className="absolute w-3 h-3 rounded-full bg-red-500 border-2 border-white -translate-x-1/2 -translate-y-1/2 shadow"
      style={{ left: `${left}%`, top: `${top}%` }}
    />
  );
}
