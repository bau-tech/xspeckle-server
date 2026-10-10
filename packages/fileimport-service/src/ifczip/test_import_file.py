import importlib.util
import os
import tempfile
import unittest
import zipfile
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().with_name("import_file.py")
spec = importlib.util.spec_from_file_location("ifczip_import_file", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)

IFC = b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"


class ExtractIfcTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def _zip(self, entries):
        path = os.path.join(self.dir, "file")
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in entries.items():
                archive.writestr(name, data)
        return path

    def test_extracts_nested_ifc_by_basename(self):
        path = self._zip({"project/Model.IFC": IFC, "readme.txt": b"x"})
        out = module.extract_ifc(path, self.dir)
        self.assertEqual(os.path.basename(out), "Model.IFC")
        self.assertEqual(Path(out).read_bytes(), IFC)

    def test_prefers_largest_ifc_and_ignores_macos_metadata(self):
        path = self._zip(
            {
                "__MACOSX/._big.ifc": IFC * 100,
                "small.ifc": IFC,
                "big.ifc": IFC * 10,
            }
        )
        self.assertEqual(os.path.basename(module.extract_ifc(path, self.dir)), "big.ifc")

    def test_archive_without_ifc_fails(self):
        path = self._zip({"readme.txt": b"x"})
        with self.assertRaisesRegex(ValueError, "does not contain an .ifc"):
            module.extract_ifc(path, self.dir)

    def test_non_zip_fails(self):
        path = os.path.join(self.dir, "file")
        Path(path).write_bytes(IFC)
        with self.assertRaisesRegex(ValueError, "not a valid zip"):
            module.extract_ifc(path, self.dir)


if __name__ == "__main__":
    unittest.main()
