import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Game = lazy(() => import("../game/Game"));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Pixel Realms — 2D pixel MMO adventure" },
      { name: "description", content: "Explore 10 pixel-art biomes, battle 100 unique monsters, and loot treasure in this AI-crafted 2D adventure." },
      { property: "og:title", content: "Pixel Realms — 2D pixel MMO adventure" },
      { property: "og:description", content: "Explore 10 pixel-art biomes, battle 100 unique monsters, and loot treasure." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-black text-white">Loading…</div>}>
      <Game />
    </Suspense>
  );
}
