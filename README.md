# WoundQuant

Quantifies how a burn / scratch wound closes in whole-well microscopy time
series. Runs entirely in the browser — images never leave the computer.

**Live:** https://baobabprince.github.io/WoundQuant/

<div dir="rtl">

**בקצרה:** טוענים תיקייה של תמונות באריות לאורך זמן (גם אלפי קבצים). המערכת מזהה בכל תמונה את
אזור הגידול בבארית, בתוכו את אזור הכוויה, ומחשבת את הסגירה לאורך זמן לכל בארית. אפשר לתקן
ידנית, לייצא CSV, ולאמן רשת נוירונים על התיקונים. הממשק בעברית ובאנגלית.

</div>

## What it does

1. **Growth area** — finds the part of the image where cells can grow: the lit
   circular field, minus a rim margin, minus the crescent outside the well wall
   when the wall is visible. Rectangular fields that fill the frame work too.
2. **Wound** — inside the growth area, separates cell-covered from cell-free
   surface and takes the main cell-free region as the wound.
3. **Over time** — groups images into wells by file name, orders them by time,
   and reports per image: wound area (px, mm²), wound share of the well, cell
   coverage, **wound area at time 0 and how far it has dropped since** (absolute
   and as % of the time-0 area), cumulative closure %, closure inside the initial
   wound region, and closure rate; per well: time-0 and final area, total area
   drop, final / maximum closure, mean rate, T50.

   Two related percentages, on purpose: *area drop* = (A₀ − Aₜ)/A₀ on the measured
   areas as they are; *cumulative closure* does the same on the wound's share of
   the growth area, which cancels small frame-to-frame changes in the detected
   growth area. They normally differ by a few points. "Time 0" is the first
   analysed image of the series.
4. **Quality flags** — no growth area, no wound, wound > 60 % of the well, wound
   at the rim, low contrast, wound grew since the previous time point. A well
   whose cell-free area grows over time is marked as unreliable instead of
   being reported as a plain negative closure.

### Two detection engines

| Engine | How | When |
|---|---|---|
| **Classical** (default) | Local texture (gradient energy) with an automatic per-image threshold and morphological clean-up | Works out of the box; fast |
| **Neural network** | Small U-Net (ONNX, ~2 MB) run in the browser with ONNX Runtime Web | After training on your own corrected masks |

> **About the bundled model.** `woundquant-bootstrap-v0` was trained on the
> classical engine's own output for 11 of the example images, with **no
> hand-corrected masks**. It shows that the whole path works (training → ONNX →
> in-browser inference) and is a starting point for fine-tuning; it is **not**
> expected to be more accurate than the classical engine. Held-out-well
> agreement with the classical masks (IoU): B1 0.81, B8 0.90, C6 0.73. Accuracy
> against a human has not been measured — there is no hand-labelled ground truth
> in this repository yet.

### Large batches

* Drop a folder (sub-folders included) or pick thousands of files.
* Analysis runs in a pool of Web Workers (up to 6); the page stays responsive,
  with progress, rate, time remaining, pause and cancel.
* Only a compact run-length mask is kept per image, not pixels.
* Results are cached in the browser (IndexedDB) per file + settings: running
  again, or reloading the page and loading the same folder, is instant.
* One failed file does not stop the batch; failures are listed at the end.

Measured in this repository's test environment (2 CPU cores → 1 worker,
headless Chrome): 384 images of 2400 × 2400 px in 120 s (≈ 3.2 images/s,
classical engine); the neural engine took ≈ 0.85 s per image. A desktop with
more cores uses more workers.

### Review and correction

Series list with filter and "warnings only", zoomable viewer with overlay, time
slider, charts (optionally all wells), brush / eraser / polygon with undo.
A hand-corrected mask is stored separately, marked `manual` in the exports, and
always wins over a later automatic run until you reset it.

### Exports

* **CSV – all images** (long format, one row per image; columns in `js/core/csv.js`)
* **CSV – per-well summary**
* **Training set (ZIP)** — network inputs + label masks, for `ml/train.py`
* Overlay PNG of the current image

## File names

Time and well are read from the file name. Recognised out of the box:

```
EXP3 plate1 after burn_B1_1_00d00h00m.jpg     IncuCyte:  <plate>_<well>_<site>_<DD>d<HH>h<MM>m
plateA_C06_t012.tif  ·  B3_24h.png  ·  ..._day2...
```

Files without a recognisable time are ordered by name and plotted against the
image number. The same well in two folders stays two separate series.
Formats: JPEG, PNG, TIFF (8-bit and 16-bit greyscale; 16-bit is range-stretched).

## Run locally

The page uses ES modules and Web Workers, so it must be served over HTTP —
opening `index.html` as a file does not work.

```bash
npm start                # http://localhost:8080   (Node ≥ 20, no dependencies needed)
# or: python -m http.server 8080
```

There is no build step: GitHub Pages serves the repository as it is.

## Train your own model

The point of the neural engine is to learn from *your* corrections:

1. Analyse a batch, fix wrong masks with the brush / eraser / polygon.
2. **Training set (ZIP)** → "hand-corrected only" (or all images).
3. Train (CPU is enough for a few hundred images):

   ```bash
   pip install -r ml/requirements.txt
   python ml/train.py --data woundquant_training_*.zip --id my-lab-v1 --name "My lab v1" \
       --init models/woundquant-bootstrap-v0.pt --out models --update-manifest
   ```

   `--data` takes several ZIPs / folders; hand-corrected samples get 3× weight;
   20 % of the wells are held out for validation (IoU / Dice are printed).
4. Either commit `models/my-lab-v1.onnx` + `models/manifest.json` (the model then
   appears in the engine list for everyone), or keep the `.onnx` and load it in
   the app with **My own model (ONNX file)**.

Without a browser, the same data can be produced from a folder of images:
`node tools/export-dataset.mjs <images> <out>` (classical masks as labels).

Model contract: input `float32 [1, 4, H, W]`, H and W multiples of 32, planes =
mean grey, texture, texture relative to the well's 95th percentile, growth-area
mask; output = logits of "cell-free" at the same size. See `js/core/pipeline.js`.

## Usage analytics (Umami)

Optional, anonymous, cookieless — and **off until a website ID is set** in
`config.js`. Events cover batch sizes, engine and settings, corrections, exports
and errors; never images or file names. Visitors can switch it off in the
footer; Do Not Track is honoured. Set-up and the full event list:
[docs/analytics.md](docs/analytics.md).

## Command line

```bash
npm install
node tools/analyze.mjs <folder> --csv out.csv --overlays overlays/ --pixel-size 2.825
```

Same analysis code as the browser (classical engine).

## Tests

```bash
npm install
npm test                                   # unit tests (Node)
CHROME_PATH=/path/to/chrome npm run test:e2e   # full run in headless Chrome
```

## Layout

```
index.html, css/, config.js     page shell, styles, site configuration
js/core/                        analysis (no DOM): features, well, segmentation, metrics, CSV, naming
js/                             UI, worker pool, cache, viewer, charts, exports, analytics, i18n
js/ml/engine.js                 ONNX Runtime Web wrapper (runs inside the workers)
models/                         manifest.json + bundled ONNX models (+ .pt checkpoints for fine-tuning)
ml/                             PyTorch model and training script
tools/                          local server, CLI analysis, dataset export, vendoring
vendor/                         Chart.js, UTIF, pako, ONNX Runtime Web (pinned, see VERSIONS.json)
tests/                          unit and end-to-end tests
examples/                       12 example images (3 wells × 4 time points)
```

## Known limits

* Tuned and tested on one kind of data: IncuCyte whole-well relief-contrast
  images (the examples). Other modalities may need the advanced settings or a
  trained model.
* Wells where the monolayer detaches (example well B8) are flagged, not solved.
* The well wall is only used when a clear arc of it is visible.
* Everything is per browser: the cache and hand corrections live in that
  browser's storage and are not shared between computers.

## License

MIT
