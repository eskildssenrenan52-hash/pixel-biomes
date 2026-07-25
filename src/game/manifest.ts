export type EnemyDef = {
  id: number; name: string; sprite: string;
  hp: number; atk: number; def: number; xp: number; gold: [number, number]; tier: number;
};
export type TileDef = { index: number; label: string; sprite: string; walkable: boolean };
export type ItemDef = { id: number; name: string; sprite: string };
export type Manifest = {
  cell: number;
  enemies: EnemyDef[];
  biomes: Record<string, TileDef[]>;
  items: ItemDef[];
  ui: Record<string, string>;
  coins: Record<string, string>;
  player: Record<"down" | "left" | "right" | "up", string[]>;
};

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch("/game/manifest.json");
  if (!res.ok) throw new Error("Failed to load manifest");
  return res.json();
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
