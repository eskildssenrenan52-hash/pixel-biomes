## Visão geral

Jogo web 2D top-down estilo Rucoy Online: personagem se move num mapa de tiles, encontra inimigos, ataca em corpo-a-corpo, coleta moedas e itens. Todos os assets visuais (tiles, inimigos, itens, moedas, botões, molduras de modal, HUD) são gerados por IA a 64×64 px, montados em sprite sheets com grid, e recortados por script Python para a pasta pública do jogo.

## Escopo de assets (gerados por IA)

- **100 inimigos** — 2 sprite sheets 10×5 (10 colunas × 5 linhas), 64px por célula, fundo transparente removível. Cada sheet tem grid preto fino desenhado para conferência; o Python recorta pela grade fixa (não OCR do grid — coordenadas matemáticas).
- **10 biomas × 6 tiles cada** = 60 tiles — 1 sheet por bioma, 6×1 grid 64px. Biomas: grassland, desert, snow, swamp, lava, cave, beach, forest, ruins, crystal.
- **Itens** — 1 sheet 8×4 (32 itens: espadas, escudos, poções, chaves, pergaminhos, comidas, gemas, etc.) 64px.
- **Moedas/pickups** — 1 sheet 4×1 (cobre, prata, ouro, gema) 64px.
- **Player** — 1 sheet 4×4 (4 direções × 4 frames de andar) 64px.
- **UI** — 1 sheet com botões (idle/hover/pressed), moldura de modal (9-slice), coração de HP, ícone de moeda; grid 4×4 64px.

Total: ~15 chamadas de imagegen (premium para legibilidade da grade), depois 1 script Python recorta tudo.

## Pipeline de geração e recorte

1. Gerar cada sprite sheet com prompt que **exige grid preto 1px, células 64×64, fundo cinza neutro** (facilita remoção depois).
2. Salvar em `/mnt/documents/sheets/`.
3. Script Python `scripts/slice_sheets.py`:
   - Redimensiona cada sheet para múltiplos exatos de 64 (nearest neighbor, preserva pixel art).
   - Recorta por coordenadas: `cell = img.crop((c*64, r*64, (c+1)*64, (r+1)*64))`.
   - Remove fundo (chroma key do cinza dominante nas bordas) → PNG transparente.
   - Salva em `public/game/{enemies,tiles,items,coins,player,ui}/NNN.png`.
4. Gera `public/game/manifest.json` com lista de assets + metadados (nome, tipo, stats do inimigo).

## Jogo (TanStack Start + Canvas)

- Rota `/` = tela do jogo (substitui o placeholder).
- Componente `<GameCanvas>` com `<canvas>` 100vw×100vh, render loop `requestAnimationFrame`.
- Mundo: grid de tiles 20×20 por chunk, mapa procedural simples (Perlin/valor-noise) escolhendo bioma por região.
- Player: WASD/arrow keys + toque virtual (dpad na tela em mobile — viewport atual é 390×844).
- Combate: clicar/tocar em inimigo adjacente → dano; inimigos têm HP/ATK/DEF do manifest.
- Loot: inimigo morto dropa moeda/item aleatório do manifest.
- HUD: HP, ouro, slot de item equipado — usa sprites de UI gerados.
- Modais: inventário e "you died" — usa moldura 9-slice gerada.

Estado do jogo em memória (sem backend). Sem multiplayer nesta v1 (Rucoy é MMO mas o pedido é sobre a estética/estilo; multiplayer real precisaria de outro escopo).

## Estrutura de arquivos

```text
scripts/
  slice_sheets.py         # recorta + remove fundo + gera manifest
public/game/
  enemies/001.png ... 100.png
  tiles/grassland/0..5.png ... crystal/0..5.png
  items/001.png ... 032.png
  coins/{copper,silver,gold,gem}.png
  player/{down,left,right,up}_0..3.png
  ui/{btn_idle,btn_hover,btn_pressed,modal_frame,heart,coin_icon,...}.png
  manifest.json
src/
  routes/index.tsx        # tela do jogo (head próprio: título, description, og)
  game/
    engine.ts             # loop, input, câmera
    world.ts              # geração de mapa por biomas
    entities.ts           # player, enemies, drops
    combat.ts
    render.ts             # desenha tiles + sprites do manifest
    ui.tsx                # HUD, modais, dpad mobile
    manifest.ts           # tipo + loader do manifest.json
```

## Detalhes técnicos

- **Imagegen**: `premium` para as sheets (grid legível é crítico). Dimensões da sheet = colunas·64 × linhas·64 exatos (ex.: inimigos 10×5 = 640×320; upscalar a 1280×640 se o modelo exigir min 512, e depois o Python faz downscale nearest para 640×320 antes de recortar).
- **Remoção de fundo**: chroma key por cor dominante das bordas de cada célula, com tolerância; alpha limpo. PIL `getpixel` + flood fill nas bordas.
- **Manifest**: tipado (`Enemy { id, sprite, name, hp, atk, def, xp, loot[] }`, `Tile { biome, index, walkable }`, etc.). Stats gerados proceduralmente a partir do índice (inimigos 1–100 escalam dificuldade).
- **SEO/head**: `src/routes/index.tsx` recebe `head()` com título ("Pixel Realms — 2D pixel MMO"), description, og:title/description, og:type=website, twitter:card. Sitemap + robots.txt no fim.
- **Performance**: sprites pré-carregados num `Map<string, HTMLImageElement>` na inicialização; canvas com `imageSmoothingEnabled = false`.
- **Mobile-first** (viewport atual 390×844): dpad on-screen à esquerda, botão de ataque à direita.

## Notas honestas

- Gerar 15 sheets em `premium` leva alguns minutos e consome créditos consideráveis.
- Qualidade de "grid perfeito" pelo modelo não é 100% garantida — se uma sheet vier mal alinhada, regenero só aquela com prompt mais rígido; o script assume grid matemático fixo, não detecta linhas.
- Sem multiplayer, sem persistência, sem contas nesta v1. Adiciono depois se quiser.

Confirma que sigo com esse escopo (ou quer cortar, ex.: 30 inimigos em vez de 100, pular alguns biomas, etc.)?