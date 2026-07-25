import { useEffect, useRef, useState } from "react";
import { loadImage, loadManifest, type Manifest, type EnemyDef } from "./manifest";

const TILE = 64;
const VIEW_TILES_X = 11; // odd so player is centered
const VIEW_TILES_Y = 15;
const WORLD = 80; // 80x80 tile world
const BIOME_SIZE = 16; // each biome block is 16x16 tiles

type Dir = "down" | "left" | "right" | "up";
type Enemy = { def: EnemyDef; x: number; y: number; hp: number; img: HTMLImageElement };
type Drop = { x: number; y: number; kind: "coin" | "item"; img: HTMLImageElement; value: number; name: string };
type FloatText = { x: number; y: number; text: string; color: string; life: number };

const BIOMES = ["grassland","desert","snow","swamp","lava","cave","beach","forest","ruins","crystal"] as const;

function pickBiome(bx: number, by: number): string {
  // deterministic pseudo-random per block
  const h = (bx * 928371 + by * 12831 + 7) >>> 0;
  return BIOMES[h % BIOMES.length];
}
function tileNoise(x: number, y: number): number {
  return ((x * 374761393 + y * 668265263) >>> 0) / 0xffffffff;
}

export default function Game() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"loading" | "playing" | "dead">("loading");
  const [hud, setHud] = useState({ hp: 100, maxHp: 100, gold: 0, xp: 0, level: 1, inv: [] as string[] });
  const stateRef = useRef<{
    manifest: Manifest | null;
    images: Map<string, HTMLImageElement>;
    playerImgs: Record<Dir, HTMLImageElement[]>;
    tileImgs: Record<string, HTMLImageElement[]>;
    px: number; py: number; dir: Dir; frame: number; moving: boolean;
    moveCooldown: number;
    enemies: Enemy[];
    drops: Drop[];
    floats: FloatText[];
    keys: Set<string>;
    touchDir: Dir | null;
    attackReq: boolean;
    hp: number; maxHp: number; gold: number; xp: number; level: number;
    inv: string[];
    lastSpawn: number;
  }>({
    manifest: null, images: new Map(),
    playerImgs: { down: [], left: [], right: [], up: [] },
    tileImgs: {},
    px: WORLD / 2, py: WORLD / 2, dir: "down", frame: 0, moving: false, moveCooldown: 0,
    enemies: [], drops: [], floats: [],
    keys: new Set(), touchDir: null, attackReq: false,
    hp: 100, maxHp: 100, gold: 0, xp: 0, level: 1, inv: [],
    lastSpawn: 0,
  });

  // Load everything
  useEffect(() => {
    (async () => {
      const m = await loadManifest();
      const s = stateRef.current;
      s.manifest = m;
      // preload player
      for (const d of ["down","left","right","up"] as Dir[]) {
        s.playerImgs[d] = await Promise.all(m.player[d].map(loadImage));
      }
      // preload tiles per biome
      for (const [biome, tiles] of Object.entries(m.biomes)) {
        s.tileImgs[biome] = await Promise.all(tiles.map(t => loadImage(t.sprite)));
      }
      // preload UI + coins + a handful of enemies + items
      const misc = [
        ...Object.values(m.ui),
        ...m.enemies.map(e => e.sprite),
        ...m.items.map(i => i.sprite),
      ];
      await Promise.all(misc.map(async src => {
        s.images.set(src, await loadImage(src));
      }));
      setStatus("playing");
    })().catch(err => { console.error(err); });
  }, []);

  // Input
  useEffect(() => {
    const s = stateRef.current;
    const kd = (e: KeyboardEvent) => {
      s.keys.add(e.key.toLowerCase());
      if (e.key === " " || e.key === "Enter") s.attackReq = true;
    };
    const ku = (e: KeyboardEvent) => s.keys.delete(e.key.toLowerCase());
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => { window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku); };
  }, []);

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

    const biomeAt = (tx: number, ty: number) => pickBiome(Math.floor(tx / BIOME_SIZE), Math.floor(ty / BIOME_SIZE));
    const tileIndexAt = (tx: number, ty: number) => {
      const n = tileNoise(tx, ty);
      // 70% ground, 15% ground_var, 8% path, 4% decoration, 2% obstacle, 1% feature
      if (n < 0.70) return 0;
      if (n < 0.85) return 1;
      if (n < 0.93) return 2;
      if (n < 0.97) return 3;
      if (n < 0.99) return 4;
      return 5;
    };
    const walkable = (tx: number, ty: number) => {
      if (tx < 0 || ty < 0 || tx >= WORLD || ty >= WORLD) return false;
      const idx = tileIndexAt(tx, ty);
      return idx <= 2; // ground/var/path
    };

    const spawnEnemy = () => {
      if (!s.manifest) return;
      if (s.enemies.length >= 12) return;
      const angle = Math.random() * Math.PI * 2;
      const dist = 6 + Math.random() * 4;
      const tx = Math.round(s.px + Math.cos(angle) * dist);
      const ty = Math.round(s.py + Math.sin(angle) * dist);
      if (!walkable(tx, ty)) return;
      // Biome-based enemy pick, scaled to player level
      const biome = biomeAt(tx, ty);
      const biomeIdx = BIOMES.indexOf(biome as typeof BIOMES[number]);
      const tier = Math.min(5, 1 + Math.floor(s.level / 3));
      const pool = s.manifest.enemies.filter(e => e.tier <= tier);
      const def = pool[(biomeIdx * 7 + Math.floor(Math.random() * pool.length)) % pool.length];
      const img = s.images.get(def.sprite)!;
      s.enemies.push({ def, x: tx, y: ty, hp: def.hp, img });
    };

    const doAttack = () => {
      // attack tile in front of player
      const dx = s.dir === "left" ? -1 : s.dir === "right" ? 1 : 0;
      const dy = s.dir === "up" ? -1 : s.dir === "down" ? 1 : 0;
      const tx = s.px + dx, ty = s.py + dy;
      const target = s.enemies.find(e => e.x === tx && e.y === ty);
      if (!target) return;
      const dmg = Math.max(1, 5 + s.level * 2 - target.def.def);
      target.hp -= dmg;
      s.floats.push({ x: target.x, y: target.y, text: `-${dmg}`, color: "#ffdd44", life: 40 });
      if (target.hp <= 0) {
        s.gold += Math.floor(target.def.gold[0] + Math.random() * (target.def.gold[1] - target.def.gold[0] + 1));
        s.xp += target.def.xp;
        // drop
        if (Math.random() < 0.7) {
          const kinds: (keyof Manifest["coins"])[] = ["copper","silver","gold","gem"];
          const k = kinds[Math.min(3, Math.floor(target.def.tier / 2))];
          const src = s.manifest!.coins[k];
          const img = s.images.get(src)!;
          s.drops.push({ x: target.x, y: target.y, kind: "coin", img, value: [1,3,10,50][kinds.indexOf(k)], name: k });
        } else {
          const it = s.manifest!.items[Math.floor(Math.random() * s.manifest!.items.length)];
          s.drops.push({ x: target.x, y: target.y, kind: "item", img: s.images.get(it.sprite)!, value: 0, name: it.name });
        }
        s.enemies = s.enemies.filter(e => e !== target);
        // level up
        const needed = s.level * 50;
        if (s.xp >= needed) { s.xp -= needed; s.level += 1; s.maxHp += 20; s.hp = s.maxHp; }
      }
    };

    const enemyTurn = () => {
      for (const e of s.enemies) {
        const dx = Math.sign(s.px - e.x), dy = Math.sign(s.py - e.y);
        // adjacent -> attack
        if (Math.abs(s.px - e.x) + Math.abs(s.py - e.y) === 1) {
          const dmg = Math.max(1, e.def.atk - s.level);
          s.hp -= dmg;
          s.floats.push({ x: s.px, y: s.py, text: `-${dmg}`, color: "#ff5555", life: 40 });
        } else {
          // move one step toward player (prefer axis with greater distance)
          const stepX = Math.abs(s.px - e.x) >= Math.abs(s.py - e.y);
          if (stepX && walkable(e.x + dx, e.y) && !s.enemies.some(o => o !== e && o.x === e.x + dx && o.y === e.y) && !(e.x + dx === s.px && e.y === s.py)) e.x += dx;
          else if (walkable(e.x, e.y + dy) && !s.enemies.some(o => o !== e && o.x === e.x && o.y === e.y + dy) && !(e.x === s.px && e.y + dy === s.py)) e.y += dy;
        }
      }
    };

    const step = (dt: number) => {
      s.moveCooldown -= dt;
      s.frame = (s.frame + dt * 6) % 4;

      // input -> move (grid-based, cooldown)
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
        if (blocker) {
          doAttack();
          acted = true;
        } else if (walkable(nx, ny)) {
          s.px = nx; s.py = ny;
          acted = true;
          // pick up drops
          s.drops = s.drops.filter(d => {
            if (d.x === s.px && d.y === s.py) {
              if (d.kind === "coin") { s.gold += d.value; s.floats.push({ x: s.px, y: s.py, text: `+${d.value}g`, color: "#ffe066", life: 40 }); }
              else { s.inv.push(d.name); s.floats.push({ x: s.px, y: s.py, text: d.name, color: "#88ffcc", life: 50 }); }
              return false;
            }
            return true;
          });
        }
        s.moveCooldown = 0.16;
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

      if (s.hp <= 0) {
        setStatus("dead");
      }

      // sync hud (throttled by React batching)
      setHud({ hp: Math.max(0, s.hp), maxHp: s.maxHp, gold: s.gold, xp: s.xp, level: s.level, inv: s.inv.slice(-8) });
    };

    const drawTile = (tx: number, ty: number, sx: number, sy: number) => {
      if (tx < 0 || ty < 0 || tx >= WORLD || ty >= WORLD) {
        ctx.fillStyle = "#000"; ctx.fillRect(sx, sy, TILE, TILE); return;
      }
      const biome = biomeAt(tx, ty);
      const idx = tileIndexAt(tx, ty);
      const img = s.tileImgs[biome]?.[idx];
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
      // drops
      for (const d of s.drops) {
        const sx = cx + (d.x - s.px) * TILE - TILE / 2;
        const sy = cy + (d.y - s.py) * TILE - TILE / 2;
        ctx.drawImage(d.img, sx + 8, sy + 8, TILE - 16, TILE - 16);
      }
      // enemies
      for (const e of s.enemies) {
        const sx = cx + (e.x - s.px) * TILE - TILE / 2;
        const sy = cy + (e.y - s.py) * TILE - TILE / 2;
        ctx.drawImage(e.img, sx, sy, TILE, TILE);
        // hp bar
        const pct = Math.max(0, e.hp / e.def.hp);
        ctx.fillStyle = "#000"; ctx.fillRect(sx + 6, sy - 6, TILE - 12, 4);
        ctx.fillStyle = pct > 0.5 ? "#4ade80" : pct > 0.25 ? "#facc15" : "#ef4444";
        ctx.fillRect(sx + 6, sy - 6, (TILE - 12) * pct, 4);
      }
      // player
      const pImg = s.playerImgs[s.dir][Math.floor(s.frame)];
      if (pImg) ctx.drawImage(pImg, cx - TILE / 2, cy - TILE / 2, TILE, TILE);
      // floating text
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
  }, [status]);

  const restart = () => {
    const s = stateRef.current;
    s.px = WORLD / 2; s.py = WORLD / 2; s.hp = 100; s.maxHp = 100; s.gold = 0; s.xp = 0; s.level = 1; s.inv = [];
    s.enemies = []; s.drops = []; s.floats = [];
    setStatus("playing");
  };

  const dpad = (d: Dir | null) => {
    stateRef.current.touchDir = d;
  };

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
          <div className="absolute top-0 left-0 right-0 flex items-center gap-3 p-3 pointer-events-none">
            <div className="flex items-center gap-1 rounded-lg bg-black/70 px-3 py-1.5 text-white">
              <img src="/game/ui/heart_full.png" width={20} height={20} alt="" style={{ imageRendering: "pixelated" }} />
              <span className="tabular-nums text-sm font-bold">{hud.hp}/{hud.maxHp}</span>
            </div>
            <div className="flex items-center gap-1 rounded-lg bg-black/70 px-3 py-1.5 text-white">
              <img src="/game/ui/coin_gold.png" width={20} height={20} alt="" style={{ imageRendering: "pixelated" }} />
              <span className="tabular-nums text-sm font-bold">{hud.gold}</span>
            </div>
            <div className="flex items-center gap-1 rounded-lg bg-black/70 px-3 py-1.5 text-white">
              <img src="/game/ui/star.png" width={20} height={20} alt="" style={{ imageRendering: "pixelated" }} />
              <span className="tabular-nums text-sm font-bold">Lv {hud.level}</span>
            </div>
          </div>

          {/* Inventory strip bottom center */}
          {hud.inv.length > 0 && (
            <div className="absolute bottom-28 left-1/2 -translate-x-1/2 flex gap-1 rounded-lg bg-black/60 p-1.5 pointer-events-none">
              {hud.inv.map((n, i) => (
                <div key={i} className="rounded bg-white/10 px-2 py-1 text-[10px] text-white/90">{n}</div>
              ))}
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
            style={{ imageRendering: "pixelated" }}
          >
            ATK
          </button>
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
