import unittest

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.guid

from wall_openings import ACROSS_MARGIN, add_missing_openings


class AddMissingOpeningsTests(unittest.TestCase):
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

    def opening_of(self, filler):
        rels = [r for r in self.f.by_type("IfcRelFillsElement") if r.RelatedBuildingElement == filler]
        return rels[0].RelatingOpeningElement if rels else None

    def test_a_door_in_one_wall_gets_an_opening_through_it(self):
        # A wall along X, 0.3 thick; a door box (with swing) straddling it
        wall = self.box("IfcWall", "Basic Wall:Generic:1", (0.0, 0.0), 10.0, 0.3, 3.0)
        door = self.box("IfcDoor", "Door-Single:36x84:2", (2.0, 0.4), 1.0, 1.1, 2.1)

        stats = add_missing_openings(self.f)

        self.assertEqual(stats, {"opening added": 1})
        opening = self.opening_of(door)
        self.assertIsNotNone(opening)
        self.assertEqual(opening.VoidsElements[0].RelatingBuildingElement, wall)
        profile = opening.Representation.Representations[0].Items[0].SweptArea
        # Same width along the wall, reaching a little further across it
        self.assertAlmostEqual(profile.XDim, 1.0)
        self.assertAlmostEqual(profile.YDim, 1.1 + 2 * ACROSS_MARGIN)
        # The door's own box is untouched
        self.assertAlmostEqual(door.Representation.Representations[0].Items[0].SweptArea.YDim, 1.1)

    def test_unclear_or_missing_hosts_get_no_opening(self):
        self.box("IfcWall", "Basic Wall:Generic:1", (0.0, 0.0), 10.0, 0.3, 3.0)
        self.box("IfcWall", "Basic Wall:Generic:2", (0.0, 2.0), 10.0, 0.3, 3.0)
        free = self.box("IfcDoor", "Door:Free:3", (0.0, 5.0), 1.0, 1.0, 2.1)
        # Exactly between two parallel walls it overlaps equally
        between = self.box("IfcDoor", "Door:Between:4", (3.0, 1.0), 1.0, 2.3, 2.1)
        below = self.box("IfcWindow", "Window:Below:5", (-3.0, 0.0), 1.0, 0.5, 1.0, bottom=-2.0)

        stats = add_missing_openings(self.f)

        self.assertEqual(stats, {"no host wall found": 2, "ambiguous host wall": 1})
        for filler in (free, between, below):
            self.assertIsNone(self.opening_of(filler))

    def test_doors_that_already_have_an_opening_are_left_alone(self):
        wall = self.box("IfcWall", "Basic Wall:Generic:1", (0.0, 0.0), 10.0, 0.3, 3.0)
        door = self.box("IfcDoor", "Door:Single:2", (2.0, 0.0), 1.0, 0.3, 2.1)
        existing = self.box("IfcOpeningElement", "rvt opening", (2.0, 0.0), 1.0, 0.3, 2.1)
        self.f.createIfcRelVoidsElement(ifcopenshell.guid.new(), None, None, None, wall, existing)
        self.f.createIfcRelFillsElement(ifcopenshell.guid.new(), None, None, None, existing, door)

        self.assertEqual(add_missing_openings(self.f), {})
        self.assertEqual(len(self.f.by_type("IfcOpeningElement")), 1)


if __name__ == "__main__":
    unittest.main()
