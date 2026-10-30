"""
Picket preview extractor.

Triggered by S3 ObjectCreated on raw/. For each Sony ARW it:
  1. pulls the camera's embedded full-size JPEG (no RAW decode),
  2. writes previews/<id>.jpg (long edge 2048) and thumbs/<id>.jpg (long edge 400),
  3. reads EXIF for capture time + exposure info,
  4. upserts the Photos item, leaving an existing decision untouched.
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import tempfile
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import boto3
import exifread
import rawpy
from PIL import Image, ImageOps

log = logging.getLogger()
log.setLevel(logging.INFO)

RAW_EXTENSIONS = (".arw",)
PREVIEW_PREFIX = os.environ.get("PREVIEW_PREFIX", "previews/")
THUMB_PREFIX = os.environ.get("THUMB_PREFIX", "thumbs/")
PREVIEW_LONG_EDGE = int(os.environ.get("PREVIEW_LONG_EDGE", "2048"))
THUMB_LONG_EDGE = int(os.environ.get("THUMB_LONG_EDGE", "400"))

_s3 = None
_table = None


def s3():
    global _s3
    if _s3 is None:
        _s3 = boto3.client("s3")
    return _s3


def table():
    global _table
    if _table is None:
        _table = boto3.resource("dynamodb").Table(os.environ["PHOTOS_TABLE"])
    return _table


# --------------------------------------------------------------------------- pure helpers


def derive_photo_id(raw_key: str) -> str:
    """Stable id for a raw object key, so reprocessing is idempotent."""
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()[:16]


def extract_embedded_jpeg(path: str) -> bytes:
    """Return the JPEG the camera embedded in the ARW (7008x4672 on the a7C II)."""
    with rawpy.imread(path) as raw:
        thumb = raw.extract_thumb()
    if thumb.format == rawpy.ThumbFormat.JPEG:
        return thumb.data
    # Some bodies embed a bitmap instead; encode it ourselves.
    buf = io.BytesIO()
    Image.fromarray(thumb.data).save(buf, "JPEG", quality=92)
    return buf.getvalue()


@dataclass
class Renditions:
    preview: bytes
    thumb: bytes
    width: int   # of the source JPEG after orientation is applied
    height: int


def build_renditions(jpeg: bytes, preview_edge: int = PREVIEW_LONG_EDGE, thumb_edge: int = THUMB_LONG_EDGE) -> Renditions:
    im = Image.open(io.BytesIO(jpeg))
    width, height = im.size
    orientation = im.getexif().get(0x0112, 1)
    if orientation in (5, 6, 7, 8):
        width, height = height, width
    # Decode at reduced scale when the source is much bigger than we need; big speed win.
    im.draft("RGB", (preview_edge * 2, preview_edge * 2))
    im = ImageOps.exif_transpose(im) or im
    im = im.convert("RGB")

    preview = im.copy()
    preview.thumbnail((preview_edge, preview_edge), Image.Resampling.LANCZOS)
    thumb = preview.copy()
    thumb.thumbnail((thumb_edge, thumb_edge), Image.Resampling.LANCZOS)

    return Renditions(
        preview=_encode(preview, quality=85),
        thumb=_encode(thumb, quality=80),
        width=width,
        height=height,
    )


def _encode(im: Image.Image, quality: int) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
    return buf.getvalue()


def read_exif(path: str) -> dict[str, Any]:
    """Best-effort EXIF. Never raises; missing fields are just absent."""
    out: dict[str, Any] = {}
    try:
        with open(path, "rb") as f:
            tags = exifread.process_file(f, details=False)
    except Exception as e:  # noqa: BLE001
        log.warning("exif read failed for %s: %s", path, e)
        return out

    def s(tag: str) -> str | None:
        v = tags.get(tag)
        return str(v).strip() if v is not None else None

    dto = s("EXIF DateTimeOriginal")
    if dto:
        try:
            out["capturedAt"] = datetime.strptime(dto, "%Y:%m:%d %H:%M:%S").replace(microsecond=0).isoformat()
        except ValueError:
            pass
    if s("Image Model"):
        out["camera"] = s("Image Model")
    if s("EXIF LensModel"):
        out["lens"] = s("EXIF LensModel")
    if s("EXIF ISOSpeedRatings"):
        out["iso"] = s("EXIF ISOSpeedRatings")
    if s("EXIF ExposureTime"):
        out["shutter"] = s("EXIF ExposureTime")
    fnum = tags.get("EXIF FNumber")
    if fnum is not None:
        try:
            out["aperture"] = f"f/{float(fnum.values[0]):.1f}".rstrip("0").rstrip(".")
        except Exception:  # noqa: BLE001
            out["aperture"] = str(fnum)
    return out


# --------------------------------------------------------------------------- pipeline


def process_object(bucket: str, key: str, uploaded_at: str, size: int | None) -> dict[str, Any]:
    photo_id = derive_photo_id(key)
    file_name = key.rsplit("/", 1)[-1]
    preview_key = f"{PREVIEW_PREFIX}{photo_id}.jpg"
    thumb_key = f"{THUMB_PREFIX}{photo_id}.jpg"

    with tempfile.NamedTemporaryFile(suffix=".arw", dir="/tmp", delete=True) as tmp:
        s3().download_fileobj(bucket, key, tmp)
        tmp.flush()
        embedded = extract_embedded_jpeg(tmp.name)
        exif = read_exif(tmp.name)

    r = build_renditions(embedded)
    for k, body in ((preview_key, r.preview), (thumb_key, r.thumb)):
        s3().put_object(
            Bucket=bucket, Key=k, Body=body, ContentType="image/jpeg",
            CacheControl="private, max-age=31536000, immutable",
        )

    item = {
        "rawKey": key,
        "fileName": file_name,
        "previewKey": preview_key,
        "thumbKey": thumb_key,
        "width": r.width,
        "height": r.height,
        "uploadedAt": uploaded_at,
        "capturedAt": exif.get("capturedAt") or uploaded_at,
        "processedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    }
    if size is not None:
        item["bytes"] = size
    for f in ("camera", "lens", "iso", "shutter", "aperture"):
        if exif.get(f):
            item[f] = exif[f]

    names = {f"#{i}": k for i, k in enumerate(item)}
    values = {f":{i}": v for i, v in enumerate(item.values())}
    sets = [f"#{i} = :{i}" for i in range(len(item))]
    # Keep a decision made before a re-upload/reprocess.
    sets.append("#st = if_not_exists(#st, :unreviewed)")
    names["#st"] = "status"
    values[":unreviewed"] = "unreviewed"

    table().update_item(
        Key={"photoId": photo_id},
        UpdateExpression="SET " + ", ".join(sets),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )
    log.info("processed %s -> %s (%dx%d)", key, photo_id, r.width, r.height)
    return {"photoId": photo_id, **item}


def main(event: dict[str, Any], context: Any) -> dict[str, Any]:
    done, skipped = [], []
    for rec in event.get("Records", []):
        bucket = rec["s3"]["bucket"]["name"]
        key = urllib.parse.unquote_plus(rec["s3"]["object"]["key"])
        if not key.lower().endswith(RAW_EXTENSIONS):
            log.info("skipping non-RAW key %s", key)
            skipped.append(key)
            continue
        size = rec["s3"]["object"].get("size")
        uploaded_at = rec.get("eventTime") or datetime.now(timezone.utc).isoformat()
        done.append(process_object(bucket, key, uploaded_at, size))
    return {"processed": [d["photoId"] for d in done], "skipped": skipped}


if __name__ == "__main__":  # local smoke test: python handler.py some.ARW
    import sys

    p = sys.argv[1]
    r = build_renditions(extract_embedded_jpeg(p))
    print(json.dumps({"exif": read_exif(p), "width": r.width, "height": r.height,
                      "previewBytes": len(r.preview), "thumbBytes": len(r.thumb)}, indent=2))
