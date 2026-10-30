import os
import sys
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

FIXTURES = Path(__file__).parent / "fixtures"
SAMPLE_URL = "https://raw.pixls.us/data/Sony/ILCE-7CM2/DSC02429.ARW"  # CC0, 70 MB


@pytest.fixture(scope="session")
def sample_arw() -> Path:
    """A real a7C II file. Downloaded once into tests/fixtures (gitignored)."""
    path = FIXTURES / "DSC02429.ARW"
    if not path.exists():
        if os.environ.get("PICKET_OFFLINE"):
            pytest.skip("sample ARW not present and PICKET_OFFLINE set")
        FIXTURES.mkdir(exist_ok=True)
        try:
            urllib.request.urlretrieve(SAMPLE_URL, path)
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"could not download sample ARW: {e}")
    return path
