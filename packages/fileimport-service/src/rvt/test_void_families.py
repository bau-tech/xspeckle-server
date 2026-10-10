import unittest

import ifcopenshell
import ifcopenshell.api

from void_families import MARGIN, is_opening_family, is_round, openings_from_void_families


class OpeningFamilyNameTests(unittest.TestCase):
    def test_opening_and_void_families_are_recognised(self):
        for name in (
            "WS_OPG_VER_REC", "WS_VOI_WAL_REC", "WS_VOI_Lichtkugeln", "Rectangular Opening",
            "Wanddurchbruch rechteckig", "Deckenöffnung", "Kernbohrung", "M_Opening-Round",
            # rvt's name for a native Revit wall opening
            "WallOpening-2437470",
        ):
            self.assertTrue(is_opening_family(name), name)

    def test_other_families_are_not(self):
        for name in ("Basic Wall", "Door-Single", "WS_COL_REC", "Voigt Fassade", "Openwork Grille", "Steel Plate"):
            self.assertFalse(is_opening_family(name), name)

    def test_round_ones(self):
        self.assertTrue(is_round("WS_OPG_VER_CIR"))
        self.assertTrue(is_round("Kernbohrung"))
        self.assertFalse(is_round("WS_OPG_VER_REC"))


class OpeningsFromVoidFamiliesTests(unittest.TestCase):
    def setUp(self):
        self.f = ifcopenshell.file(schema="IFC4")
        project = ifcopenshell.api.run("root.create_entity", self.f, ifc_class="IfcProject")
        project.UnitsInContext = self.f.createIfcUnitAssignment(
            [self.f.createIfcSIUnit(None, "LENGTHUNIT", None, "METRE")]
        )
        model = ifcopenshell.api.run("context.add_context", self.f, context_type="Model")
        self.body = ifcopenshell.api.run(
            "context.add_context", self.f, context_type="Model",
            context_identifier="Body", target_view="MODEL_VIEW", parent=model,
        )

    def box(self, ifc_class, name, centre, x_dim, y_dim, height, bottom=0.0):
        """An element the way rvt writes one: a centred plan rectangle,
        extruded up from its placement."""
        f = self.f
        element = ifcopenshell.api.run("root.create_entity", f, ifc_class=ifc_class, name=name)
        profile = f.createIfcRectangleProfileDef(
            "AREA", None, f.createIfcAxis2Placement2D(f.createIfcCartesianPoint([0.0, 0.0])), x_dim, y_dim
        )
        solid = f.createIfcExtrudedAreaSolid(
            profile, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint([0.0, 0.0, 0.0])),
            f.createIfcDirection([0.0, 0.0, 1.0]), height,
        )
        element.Representation = f.createIfcProductDefinitionShape(
            None, None, [f.createIfcShapeRepresentation(self.body, "Body", "SweptSolid", [solid])]
        )
        element.ObjectPlacement = f.createIfcLocalPlacement(
            None, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint([centre[0], centre[1], bottom]))
        )
        return element

    def openings_of(self, host):
        return [r.RelatedOpeningElement for r in self.f.by_type("IfcRelVoidsElement") if r.RelatingBuildingElement == host]

    def solid_of(self, opening):
        return opening.Representation.Representations[0].Items[0]

    def test_a_wall_opening_family_becomes_an_opening_in_its_wall(self):
        wall = self.box("IfcWall", "Basic Wall:Generic:1", (0.0, 0.0), 10.0, 0.2, 3.0)
        family = self.box("IfcBuildingElementProxy", "WS_OPG_HOR_REC:WS_OPG_HOR_REC:7", (2.0, 0.0), 0.8, 0.3, 0.6, bottom=1.0)
        guid = family.GlobalId

        stats = openings_from_void_families(self.f)

        self.assertEqual(stats, {"opening added": 1, "openings": 1})
        [opening] = self.openings_of(wall)
        profile = self.solid_of(opening).SweptArea
        self.assertAlmostEqual(profile.XDim, 0.8 + 2 * MARGIN)
        self.assertAlmostEqual(profile.YDim, 0.3 + 2 * MARGIN)
        self.assertAlmostEqual(self.solid_of(opening).Depth, 0.6 + 2 * MARGIN)
        # The family keeps its id and data, but no longer draws a block
        self.assertEqual(family.GlobalId, guid)
        self.assertIsNone(family.Representation)

    def test_a_vertical_round_opening_cuts_every_slab_it_passes(self):
        lower = self.box("IfcSlab", "Floor:Generic:1", (0.0, 0.0), 10.0, 10.0, 0.3, bottom=0.0)
        upper = self.box("IfcSlab", "Floor:Generic:2", (0.0, 0.0), 10.0, 10.0, 0.3, bottom=3.0)
        self.box("IfcBuildingElementProxy", "WS_OPG_VER_CIR:WS_OPG_VER_CIR:8", (1.0, 1.0), 0.2, 0.2, 4.0, bottom=-0.5)

        stats = openings_from_void_families(self.f)

        self.assertEqual(stats, {"round opening added": 1, "openings": 2})
        for slab in (lower, upper):
            [opening] = self.openings_of(slab)
            solid = self.solid_of(opening)
            self.assertTrue(solid.SweptArea.is_a("IfcCircleProfileDef"))
            self.assertAlmostEqual(solid.SweptArea.Radius, 0.1 + MARGIN)
            self.assertAlmostEqual(solid.Depth, 4.0 + 2 * MARGIN)
        # Two openings of one family get different, repeatable ids
        a, b = self.openings_of(lower)[0], self.openings_of(upper)[0]
        self.assertNotEqual(a.GlobalId, b.GlobalId)

    def test_a_horizontal_round_opening_runs_through_the_wall(self):
        wall = self.box("IfcWall", "Basic Wall:Generic:1", (0.0, 0.0), 10.0, 0.25, 3.0)
        # As wide as it is high (0.3), longer across the wall (0.4)
        self.box("IfcBuildingElementProxy", "WS_OPG_HOR_CIR:WS_OPG_HOR_CIR:9", (2.0, 0.0), 0.3, 0.4, 0.3, bottom=1.0)

        openings_from_void_families(self.f)

        [opening] = self.openings_of(wall)
        solid = self.solid_of(opening)
        self.assertTrue(solid.SweptArea.is_a("IfcCircleProfileDef"))
        self.assertEqual(tuple(solid.Position.Axis.DirectionRatios), (0.0, 1.0, 0.0))
        self.assertAlmostEqual(solid.Depth, 0.4 + 2 * MARGIN)

    def test_a_box_in_a_wall_at_an_angle_is_left_alone(self):
        wall = self.box("IfcWall", "Basic Wall:Generic:1", (0.0, 0.0), 10.0, 0.2, 3.0)
        # Turn the wall 30 degrees in plan
        wall.ObjectPlacement.RelativePlacement.RefDirection = self.f.createIfcDirection([0.866, 0.5, 0.0])
        family = self.box("IfcBuildingElementProxy", "WallOpening-12", (0.0, 0.0), 1.0, 1.0, 1.0, bottom=1.0)

        stats = openings_from_void_families(self.f)

        self.assertEqual(stats, {"skipped: box not aligned with its wall": 1})
        self.assertEqual(self.openings_of(wall), [])
        self.assertIsNotNone(family.Representation)

    def test_a_family_that_crosses_nothing_and_other_families_are_left_alone(self):
        self.box("IfcWall", "Basic Wall:Generic:1", (0.0, 0.0), 10.0, 0.2, 3.0)
        loose = self.box("IfcBuildingElementProxy", "WS_VOI_REC:WS_VOI_REC:10", (0.0, 5.0), 1.0, 1.0, 1.0)
        other = self.box("IfcBuildingElementProxy", "Generic Box:Generic Box:11", (0.0, 0.0), 1.0, 1.0, 1.0)

        stats = openings_from_void_families(self.f)

        self.assertEqual(stats, {"no element crossed": 1})
        self.assertIsNotNone(loose.Representation)
        self.assertIsNotNone(other.Representation)
        self.assertEqual(self.f.by_type("IfcOpeningElement"), [])


if __name__ == "__main__":
    unittest.main()
