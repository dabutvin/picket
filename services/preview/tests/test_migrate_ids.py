"""migrate_ids against in-memory stand-ins for the DynamoDB table and S3 client."""

import migrate_ids


class FakeTable:
    def __init__(self, rows):
        self.rows = {r["photoId"]: dict(r) for r in rows}

    def scan(self, **kwargs):
        return {"Items": list(self.rows.values())}

    def get_item(self, Key):
        item = self.rows.get(Key["photoId"])
        return {"Item": dict(item)} if item else {}

    def put_item(self, Item, ConditionExpression=None):
        assert Item["photoId"] not in self.rows
        self.rows[Item["photoId"]] = dict(Item)

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        row = self.rows[Key["photoId"]]
        for placeholder, name in ExpressionAttributeNames.items():
            row[name] = ExpressionAttributeValues[placeholder.replace("#", ":")]

    def delete_item(self, Key):
        self.rows.pop(Key["photoId"], None)


class FakeS3:
    def __init__(self, keys):
        self.keys = set(keys)

    def copy_object(self, Bucket, CopySource, Key):
        if CopySource["Key"] not in self.keys:
            raise RuntimeError("NoSuchKey")
        self.keys.add(Key)

    def delete_object(self, Bucket, Key):
        self.keys.discard(Key)


def legacy_row(old_id, name, captured, **extra):
    return {
        "photoId": old_id,
        "fileName": name,
        "capturedAt": captured,
        "rawKey": f"raw/2026/10/31/{name}",
        "previewKey": f"previews/{old_id}.jpg",
        "thumbKey": f"thumbs/{old_id}.jpg",
        "status": "unreviewed",
        **extra,
    }


def test_dry_run_plans_only_legacy_rows(capsys):
    new = migrate_ids.derive_photo_id("DSC00002.ARW", "2026-10-31T10:00:00")
    table = FakeTable([legacy_row("legacy0000000001", "DSC00001.ARW", "2026-10-31T09:00:00"), legacy_row(new, "DSC00002.ARW", "2026-10-31T10:00:00")])
    s3 = FakeS3({"previews/legacy0000000001.jpg", "thumbs/legacy0000000001.jpg"})
    migrate_ids.run(table, s3, "b", apply=False)
    out = capsys.readouterr().out
    assert "2 rows, 1 on the legacy id scheme" in out
    assert set(table.rows) == {"legacy0000000001", new}  # nothing changed


def test_apply_moves_row_and_previews_and_keeps_decision():
    old = "legacy0000000001"
    pick = legacy_row(old, "DSC00001.ARW", "2026-10-31T09:00:00", status="pick", decidedAt="t", lightroomStatus="done", lightroom={"status": "done"})
    table = FakeTable([pick])
    s3 = FakeS3({f"previews/{old}.jpg", f"thumbs/{old}.jpg"})
    migrate_ids.run(table, s3, "b", apply=True)
    new = migrate_ids.derive_photo_id("DSC00001.ARW", "2026-10-31T09:00:00")
    assert set(table.rows) == {new}
    row = table.rows[new]
    assert row["status"] == "pick" and row["lightroomStatus"] == "done" and row["previewKey"] == f"previews/{new}.jpg"
    assert s3.keys == {f"previews/{new}.jpg", f"thumbs/{new}.jpg"}


def test_apply_merges_decision_into_row_already_on_new_scheme():
    new = migrate_ids.derive_photo_id("DSC00001.ARW", "2026-10-31T09:00:00")
    old_pick = legacy_row("legacy0000000001", "DSC00001.ARW", "2026-10-31T09:00:00", status="pick", decidedAt="t", lightroomStatus="queued", lightroom={"status": "queued"})
    fresh = legacy_row(new, "DSC00001.ARW", "2026-10-31T09:00:00")  # re-sent after the Lambda changed, unreviewed
    table = FakeTable([old_pick, fresh])
    s3 = FakeS3({"previews/legacy0000000001.jpg", "thumbs/legacy0000000001.jpg", f"previews/{new}.jpg", f"thumbs/{new}.jpg"})
    migrate_ids.run(table, s3, "b", apply=True)
    assert set(table.rows) == {new}
    assert table.rows[new]["status"] == "pick" and table.rows[new]["lightroomStatus"] == "queued"
