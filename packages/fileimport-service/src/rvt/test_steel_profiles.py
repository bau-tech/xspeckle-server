import math
import unittest

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.geom
import numpy as np

from steel_profiles import apply_real_sections, parse_designation


class ParseDesignationTests(unittest.TestCase):
    def parse(self, family, type_name):
        return parse_designation(family, type_name)

    def test_aisc_rolled_shapes_come_from_the_table(self):
        w = self.parse("W Shapes", "W18x55")
        self.assertEqual((w.kind, w.name), ("I", "W18X55"))
        self.assertAlmostEqual(w.depth, 18.1 * 0.0254, places=4)
        self.assertAlmostEqual(w.width, 7.53 * 0.0254, places=4)
        self.assertEqual(self.parse("C Channels", "C15X50").kind, "U")
        # A decimal weight, which the table keys as C8X11_5
        c = self.parse("C Shapes", "C8X11.5")
        self.assertEqual((c.kind, c.name), ("U", "C8X11.5"))
        self.assertAlmostEqual(c.depth, 8 * 0.0254, places=4)
        self.assertEqual(self.parse("Structural Tees", "WT22X204").kind, "T")
        self.assertEqual(self.parse("Pipe", "Pipe4STD").kind, "CHS")

    def test_european_names_including_german_spelling(self):
        heb = self.parse("HEB Träger", "HE 120 B Baustahl - S 355")
        self.assertEqual((heb.kind, heb.name), ("I", "HEB120"))
        self.assertAlmostEqual(heb.depth, 0.12)
        self.assertEqual(self.parse("", "HEB 200").name, "HEB200")
        self.assertEqual(self.parse("", "HE-A 300").name, "HEA300")
        self.assertEqual(self.parse("", "IPE300").name, "IPE300")
        self.assertEqual(self.parse("", "UPN 200").kind, "U")

    def test_hollow_sections_and_angles_from_their_names(self):
        hss = self.parse("HSS-Hollow Structural Section-Column", "HSS6x4x1/4")
        self.assertEqual(hss.kind, "RHS")
        self.assertAlmostEqual(hss.depth, 6 * 0.0254)
        self.assertAlmostEqual(hss.width, 4 * 0.0254)
        self.assertAlmostEqual(hss.web, 0.25 * 0.93 * 0.0254)
        round_hss = self.parse("", "HSS6.625x.280")
        self.assertEqual(round_hss.kind, "CHS")
        shs = self.parse("SHS-Stütze (EN 10210-2)", "SHS100x8")
        self.assertEqual((shs.kind, shs.width, shs.depth, shs.web), ("RHS", 0.1, 0.1, 0.008))
        rhs = self.parse("", "RHS 200x100x8")
        self.assertEqual((rhs.width, rhs.depth), (0.1, 0.2))
        chs = self.parse("", "CHS 114,3x5")
        self.assertAlmostEqual(chs.width, 0.1143)
        self.assertEqual(self.parse("", "L4x4x1/2").kind, "L")
        self.assertAlmostEqual(self.parse("", "L 100x100x10").web, 0.01)

    def test_bar_joists(self):
        self.assertEqual(self.parse("K-Series Bar Joist-Angle Web", "16K6").kind, "JOIST")
        self.assertEqual(self.parse("LH-Series Bar Joist", "18LH04").kind, "JOIST")

    def test_non_steel_names_are_left_alone(self):
        for family, type_name in [
            ("Concrete-Rectangular Beam", "CB24x24"),
            ("hsbcad Balken", "80x180"),
            ("FLACHEN10058 Träger", "Flach 30 x 6 EN10058 Baustahl - S 355"),
            ("Basic Wall", "Generic - 200mm"),
            ("W Shapes", "W99X999"),  # not a real shape
        ]:
            self.assertIsNone(self.parse(family, type_name), type_name)


class ApplyRealSectionsTests(unittest.TestCase):
    def setUp(self):
        self.f = ifcopenshell.file(schema="IFC4")
        project = ifcopenshell.api.run("root.create_entity", self.f, ifc_class="IfcProject")
        # Metres, like the IFC rvt writes
        project.UnitsInContext = self.f.createIfcUnitAssignment(
            [self.f.createIfcSIUnit(None, "LENGTHUNIT", None, "METRE")]
        )
        self.context = ifcopenshell.api.run("context.add_context", self.f, context_type="Model")
        self.body = ifcopenshell.api.run(
            "context.add_context", self.f, context_type="Model",
            context_identifier="Body", target_view="MODEL_VIEW", parent=self.context,
        )
        self.project = project

    def member(self, ifc_class, name, x_dim, y_dim, height):
        """A box the way rvt writes one: a centred rectangle extruded up."""
        f = self.f
        element = ifcopenshell.api.run("root.create_entity", f, ifc_class=ifc_class, name=name)
        profile = f.createIfcRectangleProfileDef(
            "AREA", None, f.createIfcAxis2Placement2D(f.createIfcCartesianPoint([0.0, 0.0])), x_dim, y_dim
        )
        solid = f.createIfcExtrudedAreaSolid(
            profile, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint([0.0, 0.0, 0.0])),
            f.createIfcDirection([0.0, 0.0, 1.0]), height,
        )
        shape = f.createIfcShapeRepresentation(self.body, "Body", "SweptSolid", [solid])
        element.Representation = f.createIfcProductDefinitionShape(None, None, [shape])
        element.ObjectPlacement = f.createIfcLocalPlacement(
            None, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint([0.0, 0.0, 0.0]))
        )
        return element

    def extents(self, element):
        # Item by item: members here sit at the origin, unrotated, so item
        # coordinates are world coordinates
        settings = ifcopenshell.geom.settings()
        verts = np.concatenate([
            np.array(ifcopenshell.geom.create_shape(settings, item).verts).reshape(-1, 3)
            for item in element.Representation.Representations[0].Items
        ])
        return verts.min(0), verts.max(0)

    def test_boxes_become_real_sections_where_they_fit(self):
        beam = self.member("IfcBeam", "W Shapes:W18x55:1", 5.0, 0.191, 0.523)
        column = self.member("IfcColumn", "W Shapes-Column:W14x109:2", 0.371, 0.363, 3.0)
        wrong = self.member("IfcBeam", "W Shapes:W16X26:3", 5.0, 0.165, 0.310)
        joist = self.member("IfcBeam", "K-Series Bar Joist-Angle Web:16K6:4", 0.073, 6.0, 0.406)

        stats = apply_real_sections(self.f)

        self.assertEqual(stats, {
            "I beam": 1, "I section": 1, "joist": 1, "skipped: section doesn't fit box": 1,
        })
        solid = beam.Representation.Representations[0].Items[0]
        self.assertTrue(solid.SweptArea.is_a("IfcIShapeProfileDef"))
        self.assertAlmostEqual(solid.Depth, 5.0)
        lo, hi = self.extents(beam)
        # The real depth, hanging from the box top (the top of steel)
        self.assertAlmostEqual(hi[2] - lo[2], 0.45974, places=4)
        self.assertAlmostEqual(hi[2], 0.523, places=4)
        self.assertAlmostEqual(hi[0] - lo[0], 5.0, places=4)
        self.assertAlmostEqual(hi[1] - lo[1], 0.19126, places=4)

        self.assertTrue(column.Representation.Representations[0].Items[0].SweptArea.is_a("IfcIShapeProfileDef"))
        self.assertTrue(wrong.Representation.Representations[0].Items[0].SweptArea.is_a("IfcRectangleProfileDef"))

        joist_items = joist.Representation.Representations[0].Items
        self.assertGreater(len(joist_items), 2)  # two chords + a web
        lo, hi = self.extents(joist)
        self.assertAlmostEqual(hi[1] - lo[1], 6.0, places=3)
        self.assertAlmostEqual(hi[2], 0.406, places=3)


    def test_a_box_around_a_beam_at_an_angle_becomes_the_beam(self):
        # A W18x86 4.65 m long, turned 24.5 degrees: rvt boxes its plan extents
        width, length = 0.28194, 4.65
        c, s = math.cos(math.radians(24.5)), math.sin(math.radians(24.5))
        box = (length * c + width * s, length * s + width * c)
        beam = self.member("IfcBeam", "W Shapes:W18x86:5", box[0], box[1], 0.467)
        unknown = self.member("IfcBeam", "W Shapes:W18x86:6", box[0], box[1], 0.467)

        stats = apply_real_sections(self.f, {5: (c, -s)})

        self.assertEqual(stats, {"I skewed beam": 1, "skipped: section doesn't fit box": 1})
        solid = beam.Representation.Representations[0].Items[0]
        self.assertTrue(solid.SweptArea.is_a("IfcIShapeProfileDef"))
        self.assertAlmostEqual(solid.Depth, length, places=3)
        lo, hi = self.extents(beam)
        # Its plan extents are the box rvt drew, its top the box top
        self.assertAlmostEqual(hi[0] - lo[0], box[0], places=3)
        self.assertAlmostEqual(hi[1] - lo[1], box[1], places=3)
        self.assertAlmostEqual(hi[2], 0.467, places=4)
        self.assertTrue(unknown.Representation.Representations[0].Items[0].SweptArea.is_a("IfcRectangleProfileDef"))


if __name__ == "__main__":
    unittest.main()
