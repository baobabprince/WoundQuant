#!/usr/bin/env python3
"""Train WoundQuant's neural engine and export it for the web app.

Data: one or more folders (or .zip files) in the format written by the web app
("Export training set") and by tools/export-dataset.mjs:

    images/<id>.png   RGB  R = mean grey, G = texture, B = relative texture (all 0 outside the growth area)
    labels/<id>.png   grey 0 outside · 85 cells · 170 cell-free · 255 wound
    meta.jsonl        one JSON object per sample (id, series, source = auto | manual, …)

Example:

    python ml/train.py --data my_export.zip --out models --id my-lab-v1 --epochs 150

Writes models/<id>.onnx and prints the entry to add to models/manifest.json
(use --update-manifest to add it automatically).
"""

from __future__ import annotations

import argparse
import io
import json
import random
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

from model import TinyUNet

INPUT_SPEC = {
    "layout": "NCHW",
    "channels": ["mean", "texture", "texture_relative", "well"],
    "multiple": 32,
    "output": "logits_cell_free",
}


@dataclass
class Sample:
    id: str
    image: np.ndarray  # H × W × 3 uint8
    label: np.ndarray  # H × W uint8 (0, 85, 170, 255)
    series: str
    source: str        # 'auto' or 'manual'


def _read_dataset(root: str) -> list[Sample]:
    """Load a dataset folder or zip."""
    path = Path(root)
    if path.is_file() and path.suffix.lower() == ".zip":
        zf = zipfile.ZipFile(path)
        names = set(zf.namelist())
        # Tolerate a single top-level folder inside the archive.
        prefix = ""
        if "meta.jsonl" not in names:
            cands = [n for n in names if n.endswith("/meta.jsonl")]
            if not cands:
                raise SystemExit(f"{root}: meta.jsonl not found")
            prefix = cands[0][: -len("meta.jsonl")]
        read = lambda rel: zf.read(prefix + rel)  # noqa: E731
        exists = lambda rel: (prefix + rel) in names  # noqa: E731
    elif path.is_dir():
        read = lambda rel: (path / rel).read_bytes()  # noqa: E731
        exists = lambda rel: (path / rel).exists()  # noqa: E731
    else:
        raise SystemExit(f"{root}: not a folder or .zip")

    samples = []
    for line in read("meta.jsonl").decode("utf-8").splitlines():
        if not line.strip():
            continue
        meta = json.loads(line)
        sid = meta["id"]
        if not exists(f"images/{sid}.png") or not exists(f"labels/{sid}.png"):
            print(f"  ! {sid}: image or label missing, skipped")
            continue
        image = np.asarray(Image.open(io.BytesIO(read(f"images/{sid}.png"))).convert("RGB"))
        label = np.asarray(Image.open(io.BytesIO(read(f"labels/{sid}.png"))).convert("L"))
        if image.shape[:2] != label.shape:
            print(f"  ! {sid}: image/label size mismatch, skipped")
            continue
        samples.append(Sample(sid, image, label, f"{root}::{meta.get('series', sid)}", meta.get("source", "auto")))
    return samples


def split_by_series(samples: list[Sample], val_fraction: float, seed: int, val_match: str | None):
    """Hold out whole wells: time points of one well are too alike to split."""
    series = sorted({s.series for s in samples})
    if val_match:
        val_series = {k for k in series if val_match in k}
    else:
        rng = random.Random(seed)
        rng.shuffle(series)
        n_val = max(1, round(len(series) * val_fraction)) if len(series) > 1 and val_fraction > 0 else 0
        val_series = set(series[:n_val])
    train = [s for s in samples if s.series not in val_series]
    val = [s for s in samples if s.series in val_series]
    return train, val


def to_tensors(s: Sample):
    well = (s.image[..., 0] > 0).astype(np.float32)                              # growth area: R ≥ 1
    feats = s.image.astype(np.float32) / 255.0
    x = torch.from_numpy(np.concatenate([feats, well[..., None]], axis=2)).permute(2, 0, 1)  # 4 × H × W
    y = torch.from_numpy((s.label >= 128).astype(np.float32))[None]             # 1 × H × W  cell-free
    # Loss/metrics only where both the image and the label say "inside the well".
    m = torch.from_numpy(((s.label > 0) & (well > 0)).astype(np.float32))[None]
    return x, y, m


def augment(x, y, m, crop: int, rng: random.Random):
    """Flips, 90° turns, brightness/texture jitter, random crop."""
    k = rng.randrange(4)
    if k:
        x, y, m = (torch.rot90(t, k, (1, 2)) for t in (x, y, m))
    if rng.random() < 0.5:
        x, y, m = (torch.flip(t, (2,)) for t in (x, y, m))
    x = x.clone()
    well = x[3]
    # Illumination: gain/offset on the mean-grey plane.
    x[0] = (x[0] * rng.uniform(0.85, 1.15) + rng.uniform(-0.05, 0.05)).clamp(1 / 255, 1) * well
    # Focus / contrast differences shift the log-texture planes as a whole.
    x[1] = (x[1] + rng.uniform(-0.05, 0.05)).clamp(0, 1) * well
    x[2] = (x[2] + rng.uniform(-0.03, 0.03)).clamp(0, 1) * well
    _, h, w = x.shape
    if crop and (h > crop or w > crop):
        ch, cw = min(crop, h), min(crop, w)
        top = rng.randrange(h - ch + 1)
        left = rng.randrange(w - cw + 1)
        x, y, m = (t[:, top:top + ch, left:left + cw] for t in (x, y, m))
    return x, y, m


def pad_to_multiple(t: torch.Tensor, multiple: int = 32) -> torch.Tensor:
    h, w = t.shape[-2:]
    return F.pad(t, (0, (-w) % multiple, 0, (-h) % multiple))


def masked_loss(logits, y, m):
    bce = F.binary_cross_entropy_with_logits(logits, y, reduction="none")
    bce = (bce * m).sum() / m.sum().clamp(min=1)
    p = torch.sigmoid(logits) * m
    inter = (p * y).sum()
    dice = 1 - (2 * inter + 1) / (p.sum() + (y * m).sum() + 1)
    return bce + dice


@torch.no_grad()
def evaluate(model, samples: list[Sample]):
    """Mean IoU / Dice of the cell-free class inside the growth area, and pixel accuracy."""
    model.eval()
    ious, dices, accs = [], [], []
    for s in samples:
        x, y, m = to_tensors(s)
        h, w = x.shape[-2:]
        logits = model(pad_to_multiple(x)[None])[0, :, :h, :w]
        pred = (logits > 0).float() * m
        y = y * m
        inter = (pred * y).sum().item()
        union = ((pred + y) > 0).float().sum().item()
        ious.append(inter / union if union else 1.0)
        denom = pred.sum().item() + y.sum().item()
        dices.append(2 * inter / denom if denom else 1.0)
        accs.append((((pred == y).float() * m).sum() / m.sum().clamp(min=1)).item())
    if not ious:
        return None
    return {"iou": float(np.mean(ious)), "dice": float(np.mean(dices)), "pixel_accuracy": float(np.mean(accs)), "n": len(ious)}


def export_onnx(model, path: Path):
    model.eval()
    dummy = torch.zeros(1, 4, 64, 64)
    kwargs = dict(
        input_names=["input"], output_names=["logits"], opset_version=17,
        dynamic_axes={"input": {0: "batch", 2: "height", 3: "width"}, "logits": {0: "batch", 2: "height", 3: "width"}},
    )
    try:
        # Recent PyTorch defaults to the "dynamo" exporter, which needs extra packages.
        torch.onnx.export(model, dummy, str(path), dynamo=False, **kwargs)
    except TypeError:
        torch.onnx.export(model, dummy, str(path), **kwargs)  # PyTorch < 2.5 has no `dynamo` argument


def check_onnx(model, path: Path) -> float:
    """Largest difference between PyTorch and ONNX Runtime on a non-square input."""
    import onnxruntime as ort

    x = torch.rand(1, 4, 96, 160)
    with torch.no_grad():
        ref = model(x).numpy()
    out = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"]).run(None, {"input": x.numpy()})[0]
    return float(np.abs(ref - out).max())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", nargs="+", required=True, help="dataset folders and/or .zip exports")
    ap.add_argument("--out", default="models", help="output folder (default: models)")
    ap.add_argument("--id", default="custom-v1", help="model id = file name without .onnx")
    ap.add_argument("--name", default=None, help="display name in the app")
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--crop", type=int, default=384, help="training crop size, 0 = full image")
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--width", type=int, default=16, help="channels of the first stage")
    ap.add_argument("--val-fraction", type=float, default=0.2, help="share of wells held out for validation (0 = none)")
    ap.add_argument("--val-match", default=None, help="hold out every series whose key contains this text")
    ap.add_argument("--exclude", nargs="*", default=[], help="skip samples whose id contains any of these")
    ap.add_argument("--manual-only", action="store_true", help="use hand-corrected samples only")
    ap.add_argument("--manual-weight", type=float, default=3.0, help="loss weight of hand-corrected samples")
    ap.add_argument("--init", default=None, help="start from an earlier checkpoint (.pt) to fine-tune")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--update-manifest", action="store_true", help="add/replace the model in <out>/manifest.json")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    rng = random.Random(args.seed)
    if args.threads:
        torch.set_num_threads(args.threads)
    device = "cuda" if torch.cuda.is_available() else "cpu"

    samples: list[Sample] = []
    for root in args.data:
        loaded = _read_dataset(root)
        print(f"{root}: {len(loaded)} samples")
        samples += loaded
    samples = [s for s in samples if not any(e in s.id for e in args.exclude)]
    if args.manual_only:
        samples = [s for s in samples if s.source == "manual"]
    if not samples:
        raise SystemExit("no samples to train on")
    n_manual = sum(s.source == "manual" for s in samples)
    train, val = split_by_series(samples, args.val_fraction, args.seed, args.val_match)
    if not train:
        raise SystemExit("validation split took every sample; lower --val-fraction or change --val-match")
    print(f"{len(samples)} samples ({n_manual} hand-corrected) · train {len(train)} · validation {len(val)} · device {device}")

    model = TinyUNet(width=args.width).to(device)
    if args.init:
        model.load_state_dict(torch.load(args.init, map_location=device)["state_dict"])
        print(f"initialised from {args.init}")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    # Small sets still get a useful number of updates per epoch.
    steps_per_epoch = max(10, -(-len(train) // args.batch))
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.epochs * steps_per_epoch)
    tensors = [to_tensors(s) for s in train]
    weights = [args.manual_weight if s.source == "manual" else 1.0 for s in train]

    t0 = time.time()
    best = None
    for epoch in range(1, args.epochs + 1):
        model.train()
        total = 0.0
        for _ in range(steps_per_epoch):
            picks = rng.choices(range(len(train)), weights=weights, k=args.batch)
            batch = [augment(*tensors[i], args.crop, rng) for i in picks]
            # Crops of differently sized images are padded to a common size (mask = 0 there).
            hh = max(b[0].shape[1] for b in batch)
            ww = max(b[0].shape[2] for b in batch)
            hh += (-hh) % 32
            ww += (-ww) % 32
            fit = lambda t: F.pad(t, (0, ww - t.shape[2], 0, hh - t.shape[1]))  # noqa: E731
            x = torch.stack([fit(b[0]) for b in batch]).to(device)
            y = torch.stack([fit(b[1]) for b in batch]).to(device)
            m = torch.stack([fit(b[2]) for b in batch]).to(device)
            loss = masked_loss(model(x), y, m)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
            total += loss.item()
        if epoch % 10 == 0 or epoch == args.epochs:
            model_cpu = model.to("cpu")
            ev = evaluate(model_cpu, val)
            model.to(device)
            msg = f"epoch {epoch:4d}  loss {total / steps_per_epoch:.4f}"
            if ev:
                msg += f"  val IoU {ev['iou']:.3f}  Dice {ev['dice']:.3f}"
                best = ev
            print(msg + f"  ({time.time() - t0:.0f}s)", flush=True)

    model = model.to("cpu").eval()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    onnx_path = out / f"{args.id}.onnx"
    export_onnx(model, onnx_path)
    diff = check_onnx(model, onnx_path)
    torch.save({"state_dict": model.state_dict(), "width": args.width}, out / f"{args.id}.pt")
    print(f"exported {onnx_path} ({onnx_path.stat().st_size / 1e6:.2f} MB), max |torch − onnx| = {diff:.2e}")

    entry = {
        "id": args.id,
        "name": args.name or args.id,
        "file": onnx_path.name,
        "input": INPUT_SPEC,
        "trained": time.strftime("%Y-%m-%d"),
        "training": {
            "samples": len(train),
            "hand_corrected": sum(s.source == "manual" for s in train),
            "validation_samples": len(val),
            "validation": best,
            "epochs": args.epochs,
        },
    }
    print(json.dumps(entry, indent=2))
    if args.update_manifest:
        mpath = out / "manifest.json"
        manifest = json.loads(mpath.read_text()) if mpath.exists() else {"models": []}
        manifest["models"] = [m for m in manifest.get("models", []) if m.get("id") != args.id] + [entry]
        mpath.write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"updated {mpath}")


if __name__ == "__main__":
    main()
