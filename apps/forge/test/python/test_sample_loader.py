"""B3-07 (ADR 0100): the sample dataset's five-line Python loader, run as a reader would run it.

The zip is the test fixture the Worker test builds with the real builder (apps/forge/test/dataset-sample.test.ts
checks it has the current format). CI runs this with `python3 -m unittest discover -s apps/forge/test/python`.
"""

import base64
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
import zipfile

FIXTURE = pathlib.Path(__file__).resolve().parent.parent / "fixtures" / "dataset-sample" / "forge-trap-sample-fixture.zip.b64"
ZIP_NAME = "forge-trap-sample-v1.zip"


class SampleLoaderTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.zip = pathlib.Path(self.dir.name) / ZIP_NAME
        self.zip.write_bytes(base64.b64decode(FIXTURE.read_text().strip()))

    def tearDown(self):
        self.dir.cleanup()

    def test_checksums_verify(self):
        with zipfile.ZipFile(self.zip) as z:
            lines = z.read("SHA256SUMS").decode("utf-8").strip().splitlines()
            self.assertEqual(len(lines), len(z.namelist()) - 1)
            for line in lines:
                digest, name = line.split("  ", 1)
                self.assertEqual(hashlib.sha256(z.read(name)).hexdigest(), digest, name)

    def test_readme_loader_runs(self):
        with zipfile.ZipFile(self.zip) as z:
            readme = z.read("README.md").decode("utf-8")
            rows = [json.loads(l) for l in z.read("sample.jsonl").decode("utf-8").splitlines() if l]
        code = re.search(r"```python\n(.*?)\n```", readme, re.S).group(1)
        self.assertEqual(len(code.splitlines()), 5)
        out = subprocess.run([sys.executable, "-I", "-c", code], cwd=self.dir.name, capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        falls = sum(1 for r in rows if r["verdict"] == "fail")
        self.assertEqual(out.stdout.strip(), f"{len(rows)} records, {falls} falls")
        self.assertGreaterEqual(len(rows), 20)


if __name__ == "__main__":
    unittest.main()
