import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

import numpy as np
from openskp import SkpFile, create
from specklepy.objects.geometry import Mesh

MODULE_PATH = Path(__file__).resolve().with_name("import_file.py")
spec = importlib.util.spec_from_file_location("skp_import_file", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)

INCH = 0.0254


def _build_sample(path: str) -> None:
    """A 20" cube component placed twice (the second 100" along X, raised
    30") and a loose red 100" floor face."""
    builder = create()
    red = builder.add_material("Red", (255, 0, 0))
    with builder.add_component_definition("Cube") as cube:
        s = 20
        corners = [(0, 0, 0), (s, 0, 0), (s, s, 0), (0, s, 0)]
        top = [(x, y, s) for x, y, _ in corners]
        cube.add_face(corners[::-1])
        cube.add_face(top)
        for i in range(4):
            a, b = corners[i], corners[(i + 1) % 4]
            cube.add_face([a, b, (b[0], b[1], s), (a[0], a[1], s)])
    builder.add_instance(cube, translation=(0, 0, 0))
    builder.add_instance(cube, translation=(100, 0, 30))
    builder.add_face([(0, 0, 0), (100, 0, 0), (100, 100, 0), (0, 100, 0)], material=red)
    builder.save(path)


def _expand(root):
    """World-space points and triangle count, instances expanded the way the
    viewer does."""
    by_app = {}

    def index(obj):
        if getattr(obj, "applicationId", None):
            by_app[obj.applicationId] = obj
        for child in getattr(obj, "elements", None) or []:
            index(child)

    index(root)
    definitions = {d["applicationId"]: d for d in root["instanceDefinitionProxies"]}
    points, tris = [], [0]

    def expand(obj, matrix):
        if obj.speckle_type.endswith("InstanceProxy"):
            local = np.array(obj["transform"]).reshape(4, 4)
            for member in definitions[obj["definitionId"]]["objects"]:
                expand(by_app[member], matrix @ local)
        elif isinstance(obj, Mesh):
            v = np.array(obj.vertices).reshape(-1, 3)
            points.append((np.c_[v, np.ones(len(v))] @ matrix.T)[:, :3])
            tris[0] += len(obj.faces) // 4

    tags = [c for c in root.elements if getattr(c, "name", "") not in ("Component definitions",) and hasattr(c, "elements")]
    for tag in tags:
        for obj in tag.elements:
            expand(obj, np.eye(4))
    return np.concatenate(points), tris[0], definitions


class SkpImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.path = os.path.join(cls.tmp.name, "sample.skp")
        _build_sample(cls.path)
        cls.root = module.convert_skp(cls.path, "sample.skp")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_the_component_is_one_definition_placed_twice(self):
        _, _, definitions = _expand(self.root)
        self.assertEqual(len(definitions), 1)
        instances = [o for c in self.root.elements for o in getattr(c, "elements", None) or []
                     if o.speckle_type.endswith("InstanceProxy")]
        self.assertEqual(len(instances), 2)
        self.assertIn(instances[0].definitionId, definitions)
        self.assertEqual(instances[0].maxDepth, 0)

    def test_geometry_lands_where_openskp_puts_it_in_z_up_metres(self):
        points, tris, _ = _expand(self.root)
        reference = SkpFile.open(self.path)
        reference.parse()
        scene = reference.build_scene()
        ref = np.concatenate([np.array(p.positions).reshape(-1, 3) for p in scene.glb_primitives])
        ref = np.c_[ref[:, 0], -ref[:, 2], ref[:, 1]]
        self.assertEqual(tris, sum(len(p.indices) // 3 for p in scene.glb_primitives))
        np.testing.assert_allclose(points.min(0), ref.min(0), atol=1e-6)
        np.testing.assert_allclose(points.max(0), ref.max(0), atol=1e-6)
        # Z-up: the raised cube's top is 50" up, the model spans 120" along X
        self.assertAlmostEqual(points[:, 2].max(), 50 * INCH, places=4)
        self.assertAlmostEqual(points[:, 0].max() - points[:, 0].min(), 120 * INCH, places=4)

    def test_materials_and_file_info(self):
        diffuse = [p.value.diffuse & 0xFFFFFF for p in self.root["renderMaterialProxies"]]
        self.assertIn(0xFF0000, diffuse)
        info = next(e for e in self.root.elements if e.speckle_type.endswith("SketchUpFile"))
        self.assertEqual(info.properties["placedComponents"], 2)
        self.assertEqual(self.root["units"], "m")

    def test_an_upload_without_a_skp_extension_still_converts(self):
        # The daemon stores every upload as a temp file named just "file"
        plain = os.path.join(self.tmp.name, "file")
        with open(self.path, "rb") as src, open(plain, "wb") as dst:
            dst.write(src.read())
        root = module.convert_skp(plain, "sample.skp")
        self.assertEqual(len(root["instanceDefinitionProxies"]), 1)

    def test_display_name_comes_from_the_upload_message(self):
        self.assertEqual(module._display_name("File upload: Tower.skp", "/tmp/file"), "Tower.skp")
        self.assertEqual(module._display_name("", "/tmp/file"), "file")


if __name__ == "__main__":
    unittest.main()
