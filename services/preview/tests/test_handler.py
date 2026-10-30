import io
from unittest import mock

from PIL import Image

import handler


def test_photo_id_is_stable_and_short():
    a = handler.derive_photo_id("raw/2026/10/30/DSC00001.ARW")
    assert a == handler.derive_photo_id("raw/2026/10/30/DSC00001.ARW")
    assert len(a) == 16
    assert a != handler.derive_photo_id("raw/2026/10/31/DSC00001.ARW")


def _jpeg(w, h, orientation=None):
    im = Image.new("RGB", (w, h), (200, 30, 30))
    buf = io.BytesIO()
    if orientation:
        exif = Image.Exif()
        exif[0x0112] = orientation
        im.save(buf, "JPEG", exif=exif.tobytes())
    else:
        im.save(buf, "JPEG")
    return buf.getvalue()


def test_renditions_respect_long_edge_and_orientation():
    r = handler.build_renditions(_jpeg(6000, 4000, orientation=6), preview_edge=2048, thumb_edge=400)
    # orientation 6 = rotate 90, so the source becomes portrait
    assert (r.width, r.height) == (4000, 6000)
    p = Image.open(io.BytesIO(r.preview))
    t = Image.open(io.BytesIO(r.thumb))
    assert max(p.size) == 2048 and p.size[1] > p.size[0]
    assert max(t.size) == 400


def test_small_source_is_not_upscaled():
    r = handler.build_renditions(_jpeg(800, 600))
    assert Image.open(io.BytesIO(r.preview)).size == (800, 600)


def test_main_skips_non_raw_and_processes_raw():
    event = {
        "Records": [
            {"eventTime": "2026-10-30T00:00:00Z", "s3": {"bucket": {"name": "b"}, "object": {"key": "raw/x.MP4", "size": 1}}},
            {"eventTime": "2026-10-30T00:00:00Z", "s3": {"bucket": {"name": "b"}, "object": {"key": "raw/2026/10/30/DSC00001.ARW", "size": 2}}},
        ]
    }
    with mock.patch.object(handler, "process_object", return_value={"photoId": "abc"}) as po:
        out = handler.main(event, None)
    assert out == {"processed": ["abc"], "skipped": ["raw/x.MP4"]}
    po.assert_called_once_with("b", "raw/2026/10/30/DSC00001.ARW", "2026-10-30T00:00:00Z", 2)


def test_real_a7cii_file(sample_arw):
    jpeg = handler.extract_embedded_jpeg(str(sample_arw))
    assert jpeg[:2] == b"\xff\xd8"
    assert Image.open(io.BytesIO(jpeg)).size == (7008, 4672)

    exif = handler.read_exif(str(sample_arw))
    assert exif["camera"] == "ILCE-7CM2"
    assert exif["capturedAt"] == "2023-10-02T18:18:37"
    assert exif["aperture"] == "f/7.1"
    assert exif["shutter"] == "1/100"

    r = handler.build_renditions(jpeg)
    assert (r.width, r.height) == (7008, 4672)
    assert max(Image.open(io.BytesIO(r.preview)).size) == 2048
    assert len(r.preview) < 1_500_000  # swipe-friendly


def test_process_object_upserts_without_clobbering_status(sample_arw):
    fake_s3 = mock.Mock()

    def download(bucket, key, fileobj):
        fileobj.write(sample_arw.read_bytes())

    fake_s3.download_fileobj.side_effect = download
    fake_table = mock.Mock()
    with mock.patch.object(handler, "s3", return_value=fake_s3), mock.patch.object(handler, "table", return_value=fake_table):
        item = handler.process_object("bucket", "raw/2023/10/02/DSC02429.ARW", "2023-10-02T20:00:00Z", 73400320)

    assert item["capturedAt"] == "2023-10-02T18:18:37"
    assert item["previewKey"] == f"previews/{item['photoId']}.jpg"
    puts = {c.kwargs["Key"]: c.kwargs for c in fake_s3.put_object.call_args_list}
    assert set(puts) == {item["previewKey"], item["thumbKey"]}
    assert all(p["ContentType"] == "image/jpeg" for p in puts.values())

    upd = fake_table.update_item.call_args.kwargs
    assert upd["Key"] == {"photoId": item["photoId"]}
    assert "if_not_exists(#st, :unreviewed)" in upd["UpdateExpression"]
    assert upd["ExpressionAttributeValues"][":unreviewed"] == "unreviewed"
