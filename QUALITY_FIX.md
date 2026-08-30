# Quality fix: late-stage false large burn

## Problem
When the wound is almost closed, Otsu / k-means / adaptive thresholding sees a nearly unimodal histogram inside the well and **marks most of the well as burn**. Everything after that (close, Chan-Vese, Watershed, Convex Hull) only preserves or inflates the error.

## Fixes (in `processImageFile`)

### 1. Search region from temporal prior
If a previous timepoint mask exists, thresholding runs only inside:

`searchRegion = dilate(prev_mask, 14) \u2229 wellMask`

Otherwise `searchRegion = wellMask`.

### 2. Low-contrast gate (before threshold)
Inside `searchRegion`, compute mean/std/range of the processed gray map.

If `std < 12` **and** `range < 28` \u2192 **empty mask** (no threshold, no post-process).

### 3. Restrict threshold to search region
Otsu / k-means / adaptive / manual only label pixels inside `searchRegion`. Outside \u2192 healthy.

### 4. Raw fraction gates (right after threshold)
- If marked fraction of the well `< 2%` \u2192 empty mask.
- If marked fraction of the well `> 55%` while previous burn fraction `< 25%` \u2192 empty mask (blocks the \u201cexploded threshold\u201d case).

### 5. Soft monotonicity (after post-process)
If new burn fraction jumps sharply vs previous (`new > prev * 1.35 + 0.08` and `new > 35%`):
- If prior was already small (`prev < 20%`) \u2192 empty mask.
- Else \u2192 clamp to slightly dilated prior.

### 6. Convex Hull
**Still enabled** when requested, but only if a non-empty seed exists (`preHullCount > 0`).

### 7. Manual annotation scale
`scaleFactor` uses `originalWidth/originalHeight` vs processing size (fixes wrong % after manual edit).

## How to apply the full file
Because of GitHub MCP upload size limits, the full fixed `index.html` (~135KB) is attached in the PR conversation / downloadable from Grok artifacts.

1. Download the fixed `index.html` from the PR discussion.
2. Replace `index.html` on this branch.
3. Merge after visual QA on example series (especially late timepoints).

Base logic restored from commit `1c657ff` plus the gates above inside `processImageFile`.

## Suggested manual test
1. Load example series B1 / B8 / C6.
2. Run batch with default settings (Chan-Vese + Hull ON).
3. Check late timepoints (e.g. 9d12h): burn % should stay low / near 0, not jump to a huge area.
4. Confirm early timepoints still detect a contiguous burn region.
