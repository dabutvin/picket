# services/preview

Python 3.12 Lambda (arm64). S3 `raw/` ObjectCreated → embedded-JPEG previews + DynamoDB upsert.
See `docs/ARCHITECTURE.md` §2 and ADR-004.

```bash
uv venv && . .venv/bin/activate
uv pip install -r requirements-dev.txt
pytest                      # downloads one 70 MB sample ARW into tests/fixtures on first run
python handler.py some.ARW  # local smoke test
./build.sh                  # Lambda bundle -> dist/ (what CDK packages)
```
