"""
Openings from opening/void families.

Offices model wall and slab penetrations as Generic Model families -- an
opening family (WS_OPG_VER_REC, "Wanddurchbruch", "Rectangular Opening") or a
void family (WS_VOI_WAL_REC) -- that cut their host in Revit. rvt reads them as
plain elements: an IfcBuildingElementProxy with the family's record box as
its body, so the viewer shows a solid block inside an uncut wall or slab.

This turns each such family whose name says it is an opening or void into
real openings: one IfcOpeningElement per wall, slab, roof, beam or column
its box passes through, voiding that element -- speckleifc then cuts it. A
round one (CIR, RUND, KERNBOHRUNG, ...) cuts a cylinder along the box's long
axis instead of the box. The family stays in the model with its data but no
body, so it no longer shows as a block. A family that crosses no element is
left as it is.
"""
import re
import uuid
from typing import Dict, List, Optional, Tuple

import ifcopenshell
import ifcopenshell.guid
import ifcopenshell.util.element
import numpy as np

from wall_openings import ALIGN_TOLERANCE, _Body, _body, _inside, _wall_direction

# Name tokens (family name, split at anything but letters and digits) that
# make a family an opening or void
OPENING_TOKENS = {
    "OPG", "OPN", "OPENING", "OPENINGS", "VOI", "VOID", "VOIDS",
    "AUSSPARUNG", "DURCHBRUCH", "OEFFNUNG", "ÖFFNUNG", "KERNBOHRUNG", "SCHLITZ",
}
# German compounds that end in one of those ("Wanddurchbruch", "Deckenöffnung")
OPENING_SUFFIXES = ("durchbruch", "aussparung", "öffnung", "oeffnung", "kernbohrung", "schlitz")
# Tokens that make an opening round
ROUND_TOKENS = {"CIR", "CIRC", "CIRCLE", "CIRCULAR", "ROUND", "RUND", "KREIS", "KERNBOHRUNG"}
# Classes an opening family can cut
HOST_CLASSES = ("IfcWall", "IfcSlab", "IfcRoof", "IfcBeam", "IfcColumn", "IfcFooting", "IfcCovering")
# Sampling grid across the family's plan box for the overlap test
GRID = 7
# How far each opening reaches past the family's box on every side, so its
# faces never coincide with the host's (a box exactly as deep as its wall
# may not cut through)
MARGIN = 0.01


def _family_name(element) -> str:
    """The family part of rvt's "Family:Type:ElementId" name."""
    return (element.Name or "").split(":")[0]


def _tokens(name: str) -> set:
    # Words split at anything but letters and digits, and at camelCase
    # ("WallOpening", rvt's name for a native Revit wall opening)
    words = re.split(r"[^0-9A-Za-zÄÖÜäöüß]+", name)
    parts = [p for w in words for p in re.split(r"(?<=[a-zäöüß])(?=[A-ZÄÖÜ])", w)]
    return {t.upper() for t in words + parts if t}


def is_opening_family(name: str) -> bool:
    lowered = name.lower()
    return bool(_tokens(name) & OPENING_TOKENS) or any(
        word.endswith(OPENING_SUFFIXES) for word in re.split(r"[^a-zäöüß]+", lowered) if word
    )


def is_round(name: str) -> bool:
    return bool(_tokens(name) & ROUND_TOKENS)


def _crosses(void: _Body, host: _Body) -> bool:
    """Whether the void's box passes through the host's body."""
    if void.top <= host.bottom + 1e-6 or void.bottom >= host.top - 1e-6:
        return False
    a, b, _, d = void.outline[:4]
    u = np.linspace(0.02, 0.98, GRID)
    uu, vv = np.meshgrid(u, u)
    samples = a + np.outer(uu.ravel(), b - a) + np.outer(vv.ravel(), d - a)
    return bool(_inside(samples, host.outline).any())


def _plain_box(solid) -> bool:
    """A centred rectangle extruded straight up from an unrotated position --
    the shape rvt gives a family it only knows the box of."""
    if not solid.is_a("IfcExtrudedAreaSolid") or not solid.SweptArea.is_a("IfcRectangleProfileDef"):
        return False
    if solid.SweptArea.is_a("IfcRectangleHollowProfileDef"):
        return False
    if tuple(solid.ExtrudedDirection.DirectionRatios) != (0.0, 0.0, 1.0):
        return False
    position = solid.Position
    if position is not None and (
        (position.Axis is not None and tuple(position.Axis.DirectionRatios) != (0.0, 0.0, 1.0))
        or (position.RefDirection is not None and tuple(position.RefDirection.DirectionRatios) != (1.0, 0.0, 0.0))
    ):
        return False
    profile_position = solid.SweptArea.Position
    return profile_position is None or profile_position.RefDirection is None or tuple(
        profile_position.RefDirection.DirectionRatios
    ) == (1.0, 0.0)


def _opening_solid(f: ifcopenshell.file, box, round_: bool):
    """The family's box grown by MARGIN on every side, or the cylinder a round
    one cuts: along the box's odd one out of its three sizes (a round wall
    penetration's box is as wide as it is high; a core drill's as long as it
    is wide), as wide as the other two."""
    profile = box.SweptArea
    centre = (0.0, 0.0)
    if profile.Position is not None:
        centre = tuple(profile.Position.Location.Coordinates[:2])
    origin = (0.0, 0.0, 0.0)
    if box.Position is not None:
        origin = tuple(box.Position.Location.Coordinates)
    sizes = (profile.XDim, profile.YDim, box.Depth)

    def point(x, y, z):
        return f.createIfcCartesianPoint([origin[0] + x, origin[1] + y, origin[2] + z])

    if not round_:
        grown = f.createIfcRectangleProfileDef(
            "AREA", None, f.createIfcAxis2Placement2D(f.createIfcCartesianPoint(list(centre))),
            sizes[0] + 2 * MARGIN, sizes[1] + 2 * MARGIN,
        )
        return f.createIfcExtrudedAreaSolid(
            grown, f.createIfcAxis2Placement3D(point(0.0, 0.0, -MARGIN)),
            f.createIfcDirection([0.0, 0.0, 1.0]), sizes[2] + 2 * MARGIN,
        )

    # The axis is the size furthest from the other two
    pairs = [(abs(sizes[1] - sizes[2]), 0), (abs(sizes[0] - sizes[2]), 1), (abs(sizes[0] - sizes[1]), 2)]
    axis = min(pairs)[1]
    across = [s for i, s in enumerate(sizes) if i != axis]
    radius = min(across) / 2 + MARGIN
    circle = f.createIfcCircleProfileDef("AREA", None, None, radius)
    cx, cy = centre
    if axis == 2:
        position = f.createIfcAxis2Placement3D(point(cx, cy, -MARGIN))
    elif axis == 0:
        position = f.createIfcAxis2Placement3D(
            point(cx - sizes[0] / 2 - MARGIN, cy, sizes[2] / 2),
            f.createIfcDirection([1.0, 0.0, 0.0]), f.createIfcDirection([0.0, 1.0, 0.0]),
        )
    else:
        position = f.createIfcAxis2Placement3D(
            point(cx, cy - sizes[1] / 2 - MARGIN, sizes[2] / 2),
            f.createIfcDirection([0.0, 1.0, 0.0]), f.createIfcDirection([1.0, 0.0, 0.0]),
        )
    return f.createIfcExtrudedAreaSolid(
        circle, position, f.createIfcDirection([0.0, 0.0, 1.0]), sizes[axis] + 2 * MARGIN
    )


def openings_from_void_families(f: ifcopenshell.file) -> Dict[str, int]:
    """Turns opening/void families into openings in the elements they cross;
    returns how many families got which outcome."""
    stats: Dict[str, int] = {}

    def count(outcome: str) -> None:
        stats[outcome] = stats.get(outcome, 0) + 1

    families = [p for p in f.by_type("IfcBuildingElementProxy") if is_opening_family(_family_name(p))]
    if not families:
        return stats
    hosts: List[Tuple[object, _Body]] = []
    for ifc_class in HOST_CLASSES:
        for host in f.by_type(ifc_class):
            body = _body(host)
            if body is not None:
                hosts.append((host, body))

    for family in families:
        body = _body(family)
        shape = None
        if family.Representation is not None:
            shape = next(
                (r for r in family.Representation.Representations if r.RepresentationIdentifier == "Body"), None
            )
        if body is None or len(body.outline) != 4 or shape is None or len(shape.Items) != 1 or not _plain_box(
            shape.Items[0]
        ):
            count("skipped: not a box")
            continue
        crossed = [(host, host_body) for host, host_body in hosts if _crosses(body, host_body)]
        if not crossed:
            count("no element crossed")
            continue
        # rvt's boxes are axis-aligned: in a wall at an angle one would cut
        # far too wide a hole, so such a wall keeps its family's block
        if any(
            host.is_a("IfcWall") and not any(
                abs(float(_wall_direction(host_body.outline) @ axis)) >= ALIGN_TOLERANCE for axis in body.axes
            )
            for host, host_body in crossed
        ):
            count("skipped: box not aligned with its wall")
            continue
        crossed = [host for host, _ in crossed]
        round_ = is_round(_family_name(family))
        for host in crossed:
            opening = f.createIfcOpeningElement(
                # Derived from the family and host, so a re-import gives the
                # same ids
                ifcopenshell.guid.compress(
                    uuid.uuid5(uuid.NAMESPACE_OID, f"{family.GlobalId}/{host.GlobalId}").hex
                ),
                None, f"Opening:{family.Name}", None, family.ObjectType,
                f.createIfcLocalPlacement(
                    family.ObjectPlacement,
                    f.createIfcAxis2Placement3D(f.createIfcCartesianPoint([0.0, 0.0, 0.0])),
                ),
                f.createIfcProductDefinitionShape(None, None, [
                    f.createIfcShapeRepresentation(
                        shape.ContextOfItems, "Body", "SweptSolid",
                        [_opening_solid(f, shape.Items[0], round_)],
                    )
                ]),
                None, "OPENING",
            )
            f.createIfcRelVoidsElement(ifcopenshell.guid.new(), None, None, None, host, opening)
        # The family keeps its id and data, not its block
        family.Representation = None
        count("round opening added" if round_ else "opening added")
        stats["openings"] = stats.get("openings", 0) + len(crossed)

    return stats
