import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

import numpy as np
import rhino3dm as rh

MODULE_PATH = Path(__file__).resolve().with_name("import_file.py")
spec = importlib.util.spec_from_file_location("rhino_import_file", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)


def _quad_mesh(x0: float, size: float) -> rh.Mesh:
    mesh = rh.Mesh()
    for x, y in [(x0, 0), (x0 + size, 0), (x0 + size, size), (x0, size)]:
        mesh.Vertices.Add(x, y, 0)
    mesh.Faces.AddFace(0, 1, 2, 3)
    return mesh


def _build_sample(path: str) -> None:
    """Centimetres; a nested layer Parent::Child; an orange mesh with a user
    string; a line; a circle; a point cloud; a box Brep (no render mesh); a
    block holding a 5 cm square, placed twice."""
    f = rh.File3dm()
    f.Settings.ModelUnitSystem = rh.UnitSystem.Centimeters
    parent_index = f.Layers.AddLayer("Parent", (0, 0, 0, 255))
    child = rh.Layer()
    child.Name = "Child"
    child.Color = (0, 0, 255, 255)
    child.ParentLayerId = f.Layers.FindIndex(parent_index).Id
    child_index = f.Layers.Add(child)

    attributes = rh.ObjectAttributes()
    attributes.LayerIndex = child_index
    attributes.ColorSource = rh.ObjectColorSource.ColorFromObject
    attributes.ObjectColor = (255, 128, 0, 255)
    attributes.Name = "Slab"
    attributes.SetUserString("Fire rating", "REI 60")
    f.Objects.AddMesh(_quad_mesh(0, 10), attributes)

    on_parent = rh.ObjectAttributes()
    on_parent.LayerIndex = parent_index
    f.Objects.AddLine(rh.Point3d(0, 0, 0), rh.Point3d(10, 0, 0), on_parent)
    f.Objects.AddCircle(rh.Circle(rh.Point3d(0, 0, 0), 5), on_parent)
    f.Objects.AddPointCloud(rh.PointCloud([rh.Point3d(1, 2, 3), rh.Point3d(4, 5, 6)]), on_parent)
    box = rh.BoundingBox(rh.Point3d(0, 0, 0), rh.Point3d(1, 1, 1))
    f.Objects.AddBrep(rh.Brep.CreateFromBoundingBox(box), on_parent)

    member = rh.ObjectAttributes()
    member.LayerIndex = parent_index
    definition = f.InstanceDefinitions.Add(
        "Square", "", "", "", rh.Point3d(0, 0, 0), (_quad_mesh(0, 5),), (member,)
    )
    definition_id = f.InstanceDefinitions.FindIndex(definition).Id
    for dx in (100, 200):
        placement = rh.InstanceReference(definition_id, rh.Transform.Translation(rh.Vector3d(dx, 0, 0)))
        f.Objects.AddInstanceObject(placement, on_parent)
    f.Write(path, 8)


def _index(root):
    by_app = {}

    def walk(obj):
        if getattr(obj, "applicationId", None):
            by_app[obj.applicationId] = obj
        for child in getattr(obj, "elements", None) or []:
            walk(child)

    walk(root)
    return by_app


class RhinoImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.path = os.path.join(cls.tmp.name, "sample.3dm")
        _build_sample(cls.path)
        cls.root = module.convert_3dm(cls.path, "sample.3dm")
        cls.by_app = _index(cls.root)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def objects(self, speckle_type_suffix):
        return [o for o in self.by_app.values() if o.speckle_type.endswith(speckle_type_suffix)]

    def test_layers_become_nested_collections_in_file_units(self):
        self.assertEqual(self.root["units"], "cm")
        parent = next(c for c in self.root.elements if c.name == "Parent")
        child = next(c for c in parent.elements if getattr(c, "name", None) == "Child")
        slab = child.elements[0]
        self.assertEqual(slab.name, "Slab")
        self.assertEqual(slab.properties["Layer"], "Parent::Child")
        self.assertEqual(slab.properties["User strings"], {"Fire rating": "REI 60"})
        self.assertEqual(slab.displayValue[0].faces, [4, 0, 1, 2, 3])
        self.assertEqual(slab.displayValue[0].units, "cm")

    def test_object_colour_becomes_its_render_material(self):
        slab = next(o for o in self.objects("DataObject") if o.name == "Slab")
        mesh_id = slab.displayValue[0].applicationId
        proxy = next(p for p in self.root["renderMaterialProxies"] if mesh_id in p.objects)
        self.assertEqual(proxy.value.diffuse & 0xFFFFFF, 0xFF8000)

    def test_curves_points_and_clouds(self):
        by_type = {o.properties["Type"]: o for o in self.objects("DataObject") if "Type" in (o.properties or {})}
        line = by_type["LineCurve"].displayValue[0].value
        self.assertEqual(line, [0.0, 0.0, 0.0, 10.0, 0.0, 0.0])
        # rhino3dm writes the circle as a rational NurbsCurve: sampled points
        # must still lie on it
        circle = np.array(by_type["NurbsCurve"].displayValue[0].value).reshape(-1, 3)
        np.testing.assert_allclose(np.linalg.norm(circle[:, :2], axis=1), 5.0, atol=1e-9)
        cloud = by_type["PointCloud"].displayValue[0]
        self.assertEqual(cloud.speckle_type, "Objects.Geometry.Pointcloud")
        self.assertEqual(cloud["points"], [1.0, 2.0, 3.0, 4.0, 5.0, 6.0])

    def test_a_brep_without_render_mesh_is_kept_and_counted(self):
        brep = next(o for o in self.objects("DataObject") if (o.properties or {}).get("Type") == "Brep")
        self.assertEqual(brep.displayValue, [])
        info = next(o for o in self.root.elements if o.speckle_type.endswith("RhinoFile"))
        self.assertEqual(info.properties["brepsWithoutRenderMeshes"], 1)

    def test_blocks_are_one_definition_placed_twice(self):
        definitions = self.root["instanceDefinitionProxies"]
        self.assertEqual(len(definitions), 1)
        instances = self.objects("InstanceProxy")
        self.assertEqual(len(instances), 2)
        for instance in instances:
            # Both spellings: specklepy's own, and the one Speckle reads
            self.assertEqual(instance["definitionId"], definitions[0].applicationId)
        offsets = sorted(i["transform"][3] for i in instances)
        self.assertEqual(offsets, [100.0, 200.0])
        member = self.by_app[definitions[0]["objects"][0]]
        self.assertEqual(len(member.displayValue[0].faces), 5)

    def test_display_name_comes_from_the_upload_message(self):
        self.assertEqual(module._display_name("File upload: Chair.3dm", "/tmp/file"), "Chair.3dm")


if __name__ == "__main__":
    unittest.main()
