"""
One-off migration: move photo rows from the legacy id (sha256 of the S3 key, which carried the
upload date) to the current id (sha256 of "FILENAME|capturedAt"). Run from `ops →
migrate-photo-ids`; dry run unless --apply.

For every row whose photoId differs from the current scheme:
  1. copy previews/<old>.jpg and thumbs/<old>.jpg to the new id;
  2. write the row under the new id (or, if a row already exists there because the photo was
     re-sent after the Lambda changed, carry the review decision over to it);
  3. delete the old row and the old preview objects.
Raw objects are not touched. Safe to re-run: rows already on the current scheme are skipped.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from typing import Any

PREVIEW_PREFIX = "previews/"
THUMB_PREFIX = "thumbs/"
DECISION_FIELDS = ("status", "decidedAt", "lightroomStatus", "lightroom")


def derive_photo_id(file_name: str, captured_at: str) -> str:
    """Must stay identical to handler.derive_photo_id."""
    return hashlib.sha256(f"{file_name.upper()}|{captured_at}".encode("utf-8")).hexdigest()[:16]


def scan_all(table: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {}
    while True:
        page = table.scan(**kwargs)
        rows.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            return rows
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def plan(rows: list[dict[str, Any]]) -> list[tuple[dict[str, Any], str]]:
    """(row, new_id) for every row not yet on the current scheme."""
    moves = []
    for row in rows:
        file_name, captured_at = row.get("fileName"), row.get("capturedAt")
        if not file_name or not captured_at:
            print(f"skip {row.get('photoId')}: missing fileName/capturedAt", file=sys.stderr)
            continue
        new_id = derive_photo_id(file_name, captured_at)
        if new_id != row["photoId"]:
            moves.append((row, new_id))
    return moves


def _copy(s3: Any, bucket: str, src: str, dst: str) -> bool:
    try:
        s3.copy_object(Bucket=bucket, CopySource={"Bucket": bucket, "Key": src}, Key=dst)
        return True
    except Exception as e:  # noqa: BLE001  (missing source: nothing to copy)
        print(f"  copy {src} -> {dst} skipped: {e}", file=sys.stderr)
        return False


def migrate_one(table: Any, s3: Any, bucket: str, row: dict[str, Any], new_id: str) -> str:
    old_id = row["photoId"]
    for prefix in (PREVIEW_PREFIX, THUMB_PREFIX):
        _copy(s3, bucket, f"{prefix}{old_id}.jpg", f"{prefix}{new_id}.jpg")

    existing = table.get_item(Key={"photoId": new_id}).get("Item")
    if existing is None:
        new_row = dict(row, photoId=new_id, previewKey=f"{PREVIEW_PREFIX}{new_id}.jpg", thumbKey=f"{THUMB_PREFIX}{new_id}.jpg")
        table.put_item(Item=new_row, ConditionExpression="attribute_not_exists(photoId)")
        outcome = "moved"
    else:
        # The photo was re-sent after the Lambda switched schemes: keep that fresher row, but a
        # decision made on the old row wins over an untouched new one.
        if row.get("status", "unreviewed") != "unreviewed" and existing.get("status", "unreviewed") == "unreviewed":
            patch = {k: row[k] for k in DECISION_FIELDS if k in row}
            names = {f"#{i}": k for i, k in enumerate(patch)}
            values = {f":{i}": v for i, v in enumerate(patch.values())}
            table.update_item(
                Key={"photoId": new_id},
                UpdateExpression="SET " + ", ".join(f"#{i} = :{i}" for i in range(len(patch))),
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )
            outcome = "merged decision into existing row"
        else:
            outcome = "existing row kept"

    table.delete_item(Key={"photoId": old_id})
    for prefix in (PREVIEW_PREFIX, THUMB_PREFIX):
        try:
            s3.delete_object(Bucket=bucket, Key=f"{prefix}{old_id}.jpg")
        except Exception as e:  # noqa: BLE001
            print(f"  delete {prefix}{old_id}.jpg skipped: {e}", file=sys.stderr)
    return outcome


def run(table: Any, s3: Any, bucket: str, apply: bool) -> int:
    rows = scan_all(table)
    moves = plan(rows)
    print(f"{len(rows)} rows, {len(moves)} on the legacy id scheme, {len(rows) - len(moves)} already current")
    for row, new_id in moves[:15]:
        print(f"  {row['photoId']} -> {new_id}  {row.get('fileName')}  {row.get('capturedAt')}  status={row.get('status')}")
    if len(moves) > 15:
        print(f"  ... and {len(moves) - 15} more")
    if not apply:
        print("dry run; re-run with confirm=migrate to apply")
        return 0
    counts: dict[str, int] = {}
    for row, new_id in moves:
        outcome = migrate_one(table, s3, bucket, row, new_id)
        counts[outcome] = counts.get(outcome, 0) + 1
    print("applied:", ", ".join(f"{v} {k}" for k, v in counts.items()) or "nothing to do")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--table", required=True)
    p.add_argument("--bucket", required=True)
    p.add_argument("--apply", action="store_true", help="perform the moves (default: dry run)")
    a = p.parse_args(argv)
    import boto3  # imported here so the pure functions stay importable without it

    table = boto3.resource("dynamodb").Table(a.table)
    return run(table, boto3.client("s3"), a.bucket, a.apply)


if __name__ == "__main__":
    sys.exit(main())
