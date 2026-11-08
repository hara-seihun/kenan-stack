---
name: image
description: Make cartoon / sketch / flat-illustration images for free on this host (SD-Turbo on the CPU), cut them out, trace them to SVG and stack SVG layers. For dress-up game clothes, jewellery and ring sketches, game assets, comics, memes, icons. Not for photorealism.
---

# kenan-image

`kenan-image` draws on the server's CPU: about 10–15 s per 512×512 image plus ~4 s to load, $0. Built-in limits:
one image job at a time on the whole host (others wait up to 4 min, then get `busy`), 2 CPU cores at idle
priority (`chrt --idle`, `nice 19`) directly, at most 4 images per
call, CPU only (the iGPU belongs to dictation). Nothing stays running between calls. Every command prints one
JSON line; failures are `{"error": CODE, "detail": ...}` with exit code 2.

Run it in the foreground with a Bash timeout of ~60 s + 25 s per image (4 images: 180). Show results to the
person by attaching the PNGs.

## Commands

- `kenan-image gen "PROMPT" --out DIR [--name NAME] [--n 1-4] [--seed S] [--size 512|WxH] [--trace [--transparent]]`
  text → PNG (`DIR/NAME-SEED.png`). A flat-illustration style suffix is added; `--raw` turns it off.
  `--size 448x704` suits a standing figure (sides are multiples of 64, 256–768). Same seed + prompt = same image.
- `kenan-image gen "PROMPT" --init IMAGE --strength 0.3-0.8 ...` image+text → PNG that keeps IMAGE's layout.
  Low strength keeps more, high changes more. This is how you control shape: draw a rough sketch first.
- `kenan-image trace IN.png [--out OUT.svg] [--transparent [--png-out CUT.png]] [--colors 1-8]` PNG → SVG;
  `--transparent` removes the background connected to the border (also gives a cut-out PNG).
- `kenan-image layer DRESSED.png --base BASE.png --out LAYER.png [--hue LO-HI] [--trace]` cuts what differs
  from BASE into a transparent layer; `--hue 110-175` keeps only greens (red 340-20, blue 190-250, ...), which is
  the reliable choice after `--init` because img2img also redraws the rest of the picture slightly.
- `kenan-image stack NAME=FILE.svg ... --out OUT.svg` one SVG with one named layer per input, bottom first
  (Inkscape shows them as layers).

## Recipes

Prompting: SD-Turbo is a small fast model; describe one subject, its pose and colours plainly; generate 4
(`--n 4`) and pick by looking at them. It is weak at hands, text and exact counts; fix those in the SVG.

Dress-up doll + clothes that fit:
1. Base: `kenan-image gen "paper doll, full body from head to toes, one young woman standing straight facing the viewer, symmetrical neutral pose, arms relaxed slightly away from the body, plain white sports bra and white shorts, barefoot, small figure centered, pure white background" --size 448x704 --n 4 --out DIR --name doll`;
   pick one, then `kenan-image trace DIR/doll-N.png --transparent --png-out DIR/doll.png --out DIR/doll.svg`.
2. Garment: paint its rough silhouette in the garment colour onto the base so it fits by construction, e.g.
   `convert DIR/doll-N.png -fill '#0a6e48' -draw "polygon 182,205 264,205 258,292 304,555 140,555 186,292" DIR/sketch.png`
   (read the base image first to find shoulders, waist and knees), then
   `kenan-image gen "young woman wearing an emerald green satin midi dress, fitted bodice, thin straps, A-line skirt" --init DIR/sketch.png --strength 0.7 --size 448x704 --n 4 --out DIR --name dress`.
3. Cut the garment out: `kenan-image layer DIR/dress-N.png --base DIR/doll-N.png --hue 110-175 --out DIR/dress.png --trace`.
4. Stack: `kenan-image stack doll=DIR/doll.svg dress=DIR/dress.svg --out DIR/doll-dressed.svg`; render a preview
   with `rsvg-convert DIR/doll-dressed.svg -b white -o DIR/preview.png` and look at it.
A person's own design (a photo or drawing they send) works the same way: use it as `--init` with strength
0.3–0.5 to clean it up into the house style, or trace it directly.

Logos, rings, icons: generate on white, `--trace --transparent --colors 2-4`, then edit the SVG text (colours,
remove stray paths) yourself.
