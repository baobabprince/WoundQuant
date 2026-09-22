# WoundQuant

Browser-based wound quantification for healing assays (scratch / burn assays).

**Live demo:** https://baobabprince.github.io/WoundQuant/

## Features
- Automatic segmentation (watershed, morphological Chan-Vese, largest connected component, proximity)
- Manual annotation: brush, eraser, polygon — with **localStorage persistence** and **undo (Ctrl+Z)**
- Smart **high-confluency safeguard** + **temporal prior** (uses previous timepoint to constrain jumps)
- CSV export with Closure %, Rate (%/h), and Source (auto/manual)
- Keyboard shortcuts: **B** brush, **E** eraser, **P** polygon, **Enter** close polygon, **Ctrl+Z** undo
- Hebrew / English UI
- High-quality zoom (up to 5×, pixelated when zoomed)

## Usage
1. Open the live site or open `index.html` locally.
2. Upload a series of images (same well over time).
3. Run automatic analysis, then refine with manual tools if needed.
4. Export CSV / charts.

## Structure
- `index.html` — full single-file application (no build step)

## License
MIT
