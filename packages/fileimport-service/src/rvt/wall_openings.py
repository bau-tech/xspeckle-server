"""
Openings for the doors and windows rvt couldn't tie to a wall.

rvt cuts an opening for a door or window only when its record names its host
wall outright; the rest sit in an uncut wall (100 of Snowdon Towers
Architectural's 247). This finds each one's wall geometrically and adds the
opening rvt would have: a copy of the door/window's own box (its plan box
includes the swing, so where it crosses the wall it's the door-width hole),
voiding the wall and filled by the door/window -- speckleifc then cuts it.

Only an unambiguous host gets an opening: the box has to overlap exactly one
wall clearly more than any other, fit that wall's height range, and line up
with the wall's direction (an axis-aligned box in a wall at an angle would
cut too wide a hole).
"""
import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import ifcopenshell
import ifcopenshell.guid
import ifcopenshell.util.element
import ifcopenshell.util.placement
import numpy as np

# Sampling grid across a door/window's plan box for the overlap test
GRID = 9
# Wall direction must be within this of one of the box's axes
ALIGN_TOLERANCE = math.cos(math.radians(2.0))
# The best wall must hold this share more of the samples than the runner-up
AMBIGUITY_MARGIN = 0.1
# How far an opening reaches past the door/window box on each side across
# the wall, so its faces never coincide with the wall's (a box exactly as
# deep as its wall may not cut through)
ACROSS_MARGIN = 0.05


@dataclass
class _Body:
    """A plan outline extruded straight up, in world coordinates."""

    outline: np.ndarray  # (n, 2) world plan polygon
    bottom: float
    top: float
    axes: Tuple[np.ndarray, np.ndarray]  # world plan directions of the profile's X and Y


def _profile_points(profile) -> Optional[np.ndarray]:
    if profile.is_a("IfcRectangleProfileDef") and not profile.is_a("IfcRectangleHollowProfileDef"):
        x, y = profile.XDim / 2, profile.YDim / 2
        return np.array([(-x, -y), (x, -y), (x, y), (-x, y)], dtype=float)
    if profile.is_a("IfcArbitraryClosedProfileDef") and not profile.is_a("IfcArbitraryProfileDefWithVoids"):
        curve = profile.OuterCurve
        if curve.is_a("IfcPolyline"):
            return np.array([p.Coordinates[:2] for p in curve.Points], dtype=float)
        if curve.is_a("IfcIndexedPolyCurve") and curve.Segments is None:
            return np.array([c[:2] for c in curve.Points.CoordList], dtype=float)
    return None


def _body(element) -> Optional[_Body]:
    """The element's single extruded body, if that's what it is."""
    rep = element.Representation
    if rep is None or element.ObjectPlacement is None:
        return None
    items = [i for r in rep.Representations if r.RepresentationIdentifier == "Body" for i in r.Items]
    if len(items) != 1 or not items[0].is_a("IfcExtrudedAreaSolid"):
        return None
    solid = items[0]
    direction = solid.ExtrudedDirection.DirectionRatios
    if abs(direction[0]) > 1e-9 or abs(direction[1]) > 1e-9:
        return None
    points = _profile_points(solid.SweptArea)
    if points is None or len(points) < 3:
        return None

    matrix = ifcopenshell.util.placement.get_local_placement(element.ObjectPlacement)
    if solid.Position is not None:
        matrix = matrix @ ifcopenshell.util.placement.get_axis2placement(solid.Position)
    # The body has to stay level: its local Z is world Z
    if not np.allclose(matrix[:3, 2], (0, 0, 1), atol=1e-6):
        return None
    # Parameterized profiles (rectangles) have a Position, arbitrary ones don't
    ppos = getattr(solid.SweptArea, "Position", None) if solid.SweptArea.is_a("IfcParameterizedProfileDef") else None
    if ppos is not None:
        loc = np.array(ppos.Location.Coordinates[:2], dtype=float)
        ref = np.array(ppos.RefDirection.DirectionRatios[:2] if ppos.RefDirection else (1.0, 0.0), dtype=float)
        ref /= np.linalg.norm(ref)
        rot = np.array([[ref[0], -ref[1]], [ref[1], ref[0]]])
        points = points @ rot.T + loc
        local_axes = (rot[:, 0], rot[:, 1])
    else:
        local_axes = (np.array([1.0, 0.0]), np.array([0.0, 1.0]))

    world_xy = points @ matrix[:2, :2].T + matrix[:2, 3]
    axes = tuple(matrix[:2, :2] @ a for a in local_axes)
    height = solid.Depth * (1 if direction[2] > 0 else -1)
    bottom = matrix[2, 3]
    return _Body(world_xy, min(bottom, bottom + height), max(bottom, bottom + height), axes)


def _inside(points: np.ndarray, polygon: np.ndarray) -> np.ndarray:
    """Even-odd point-in-polygon, for many points."""
    x, y = points[:, 0], points[:, 1]
    inside = np.zeros(len(points), dtype=bool)
    n = len(polygon)
    for i in range(n):
        (x1, y1), (x2, y2) = polygon[i], polygon[(i + 1) % n]
        crosses = (y1 > y) != (y2 > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            at_x = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
        inside ^= crosses & (x < at_x)
    return inside


def _wall_direction(outline: np.ndarray) -> np.ndarray:
    """The direction of a wall's longest outline edge."""
    edges = np.roll(outline, -1, axis=0) - outline
    longest = edges[np.argmax(np.linalg.norm(edges, axis=1))]
    return longest / np.linalg.norm(longest)


def _samples(body: _Body) -> np.ndarray:
    """A grid of points across a box's plan outline (its 4 corners)."""
    a, b, _, d = body.outline[:4]
    u = np.linspace(0.02, 0.98, GRID)
    uu, vv = np.meshgrid(u, u)
    return a + np.outer(uu.ravel(), b - a) + np.outer(vv.ravel(), d - a)


def _host(
    filler: _Body, walls: List[Tuple[object, _Body]]
) -> Tuple[Optional[object], Optional[np.ndarray], str]:
    samples = _samples(filler)
    scores = []
    for wall, body in walls:
        # The door/window has to stand within the wall's height
        if filler.bottom < body.bottom - 0.05 or filler.bottom >= body.top:
            continue
        share = _inside(samples, body.outline).mean()
        if share > 0:
            scores.append((share, wall, body))
    if not scores:
        return None, None, "no host wall found"
    scores.sort(key=lambda s: s[0], reverse=True)
    if len(scores) > 1 and scores[0][0] - scores[1][0] < AMBIGUITY_MARGIN:
        return None, None, "ambiguous host wall"
    _, wall, body = scores[0]
    direction = _wall_direction(body.outline)
    if not any(abs(float(direction @ axis)) >= ALIGN_TOLERANCE for axis in filler.axes):
        return None, None, "box not aligned with its wall"
    return wall, direction, "opening added"


def _opening_solid(f: ifcopenshell.file, box_solid, body: _Body, wall_direction: np.ndarray):
    """The door/window's box, reaching ACROSS_MARGIN further out of the wall
    on both sides (its width along the wall unchanged)."""
    solid = ifcopenshell.util.element.copy_deep(f, box_solid)
    profile = solid.SweptArea
    if abs(float(wall_direction @ body.axes[0])) >= ALIGN_TOLERANCE:
        profile.YDim = profile.YDim + 2 * ACROSS_MARGIN
    else:
        profile.XDim = profile.XDim + 2 * ACROSS_MARGIN
    return solid


def add_missing_openings(f: ifcopenshell.file) -> Dict[str, int]:
    """Adds openings for doors/windows rvt left without one; returns how many
    got which outcome."""
    stats: Dict[str, int] = {}

    def count(outcome: str) -> None:
        stats[outcome] = stats.get(outcome, 0) + 1

    filled = {rel.RelatedBuildingElement.id() for rel in f.by_type("IfcRelFillsElement")}
    walls = []
    for wall in f.by_type("IfcWall"):
        body = _body(wall)
        if body is not None:
            walls.append((wall, body))

    for filler in f.by_type("IfcDoor") + f.by_type("IfcWindow"):
        if filler.id() in filled:
            continue
        body = _body(filler)
        if body is None or len(body.outline) != 4:
            count("skipped: not a box")
            continue
        wall, direction, outcome = _host(body, walls)
        count(outcome)
        if wall is None:
            continue

        shape = next(r for r in filler.Representation.Representations if r.RepresentationIdentifier == "Body")
        opening = f.createIfcOpeningElement(
            ifcopenshell.guid.new(), None, f"Opening:{filler.Name}", None, None,
            # Same place as the door/window: relative to it, unmoved
            f.createIfcLocalPlacement(
                filler.ObjectPlacement,
                f.createIfcAxis2Placement3D(f.createIfcCartesianPoint([0.0, 0.0, 0.0])),
            ),
            f.createIfcProductDefinitionShape(None, None, [
                f.createIfcShapeRepresentation(
                    shape.ContextOfItems, "Body", "SweptSolid",
                    [_opening_solid(f, shape.Items[0], body, direction)],
                )
            ]),
            None, "OPENING",
        )
        f.createIfcRelVoidsElement(ifcopenshell.guid.new(), None, None, None, wall, opening)
        f.createIfcRelFillsElement(ifcopenshell.guid.new(), None, None, None, opening, filler)

    return stats
