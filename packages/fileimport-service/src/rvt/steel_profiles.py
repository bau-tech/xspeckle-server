"""
Real cross-sections for the steel members in an IFC rvt wrote.

rvt reads no Revit family parameters yet, so it draws every beam and column
as a box: a column as its section's bounding rectangle extruded up, a level
beam as its plan rectangle extruded up by its height, a sloped beam as a
rectangle swept along its centreline. Their type names do carry the
standard designation though (W18x55, HE 120 B, HSS6x6x5/8, SHS100x8,
L4x4x1/2, 16K6), so this swaps each box for the real section:

  - I / H (W, HP, M, S, HEA/HEB/HEM, IPE, IPN), channels (C, MC, UPN),
    tees (WT, MT, ST) and pipes: dimensions from steel/sections.json.
  - Rectangular / square / round hollow sections and angles: from the name.
  - Bar joists (K, LH, DLH series): top and bottom chord with a zigzag web.

A section only replaces a box it fits: its outer size must match the box
across the member (and, for a column or a sloped beam, both ways), so an
unexpected name or a member rvt drew differently keeps its box.
"""
import json
import math
import re
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import ifcopenshell

INCH = 0.0254
MM = 0.001
# AISC: an HSS's design wall is 0.93 x its nominal wall
AISC_HSS_DESIGN_WALL = 0.93

SECTIONS_PATH = Path(__file__).resolve().parent / "steel" / "sections.json"
_catalog: Optional[Dict[str, dict]] = None


def _sections() -> Dict[str, dict]:
    global _catalog
    if _catalog is None:
        _catalog = json.loads(SECTIONS_PATH.read_text(encoding="utf-8"))["sections"]
    return _catalog


@dataclass
class Section:
    """A cross-section, in metres. `width` runs along the profile's X axis,
    `depth` along its Y axis (up, for a beam)."""

    kind: str  # I, U, T, L, RHS, CHS, JOIST
    name: str
    width: float = 0.0
    depth: float = 0.0
    web: float = 0.0  # web thickness; wall thickness for L / RHS / CHS
    flange: float = 0.0
    fillet: float = 0.0


# ── designation parsing ─────────────────────────────────────────────────────

_NUM = r"(\d+(?:\.\d+)?)"
_THICK = r"(\d+/\d+|\d+-\d+/\d+|\d*\.\d+|\d+)"


def _inches(text: str) -> float:
    # 5/8, 1-1/4, .375, 2
    if "-" in text:
        whole, frac = text.split("-", 1)
        return float(whole) + float(Fraction(frac))
    return float(Fraction(text)) if "/" in text else float(text)


def _normalized(text: str) -> str:
    text = text.upper().replace("×", "X").replace("*", "X")
    # German decimal comma (CHS 114,3x5) -> point
    return re.sub(r"(\d),(\d)", r"\1.\2", text)


def _catalog_section(key: str, name: str) -> Optional[Section]:
    row = _sections().get(key)
    if row is None:
        return None
    if row["kind"] == "CHS":
        return Section("CHS", name, row["od"], row["od"], row["t"])
    return Section(row["kind"], name, row["bf"], row["d"], row["tw"], row["tf"], row["r"])


def parse_designation(family: str, type_name: str) -> Optional[Section]:
    """The section a Revit family/type name designates, if it's one we know."""
    for text in (type_name, family):
        section = _parse(_normalized(text or ""), _normalized(family or ""))
        if section is not None:
            return section
    return None


def _parse(text: str, family: str) -> Optional[Section]:
    name = text.strip()
    if not name:
        return None

    # Bar joists: 16K6, 18LH04, 44DLH17
    if "JOIST" in family or re.fullmatch(r"\d+(K|KCS|LH|DLH)\d+", name.replace(" ", "")):
        return Section("JOIST", name)

    # AISC rolled shapes: W18X55, HP14X73, C15X50, MC12X10.6, WT9X20
    m = re.search(rf"\b(W|HP|M|S|C|MC|WT|MT|ST)\s*{_NUM}\s*X\s*{_NUM}\b", name)
    if m:
        key = f"{m[1]}{_trim(m[2])}X{_trim(m[3])}"
        section = _catalog_section(key, key)
        if section:
            return section

    # AISC pipe: Pipe4STD, PIPE 4 XS
    m = re.search(rf"\bPIPE\s*{_NUM}\s*(STD|XS|XXS)\b", name)
    if m:
        key = f"PIPE{_trim(m[1])}{m[2]}"
        section = _catalog_section(key, key)
        if section:
            return section

    # European: HE 120 B, HEB 120, HE120B, HE-B 200, IPE 300, IPN200, UPN 100
    m = re.search(rf"\bHE\s*-?\s*([ABM])\s*-?\s*(\d+)\b", name) or re.search(
        r"\bHE\s*-?\s*(\d+)\s*-?\s*([ABM])\b", name
    )
    if m:
        letter, size = (m[1], m[2]) if m[1].isalpha() else (m[2], m[1])
        key = f"HE{letter}{size}"
        section = _catalog_section(key, key)
        if section:
            return section
    m = re.search(r"\b(IPE|IPN|UPN)\s*-?\s*(\d+)\b", name)
    if m:
        key = f"{m[1]}{m[2]}"
        section = _catalog_section(key, key)
        if section:
            return section

    # AISC HSS: rectangular HSS6X4X1/4, round HSS6.625X.280
    m = re.search(rf"\bHSS\s*{_NUM}\s*X\s*{_NUM}\s*X\s*{_THICK}", name)
    if m:
        wall = _inches(m[3]) * AISC_HSS_DESIGN_WALL * INCH
        # HSS h x b x t: h (the first) is the depth
        return Section("RHS", name, float(m[2]) * INCH, float(m[1]) * INCH, wall)
    m = re.search(rf"\bHSS\s*{_NUM}\s*X\s*{_THICK}\b", name)
    if m:
        od = float(m[1]) * INCH
        return Section("CHS", name, od, od, _inches(m[2]) * AISC_HSS_DESIGN_WALL * INCH)

    # European hollow sections, mm: SHS100X8, SHS 100X100X8, RHS200X100X8,
    # QRO / RRO (German names), CHS 114.3X5, RO / ROR
    m = re.search(rf"\b(SHS|RHS|QRO|RRO|MSH|QHP|RHP)\s*{_NUM}\s*X\s*{_NUM}(?:\s*X\s*{_NUM})?", name)
    if m:
        if m[4]:
            height, width, wall = float(m[2]), float(m[3]), float(m[4])
        else:
            height = width = float(m[2])
            wall = float(m[3])
        return Section("RHS", name, width * MM, height * MM, wall * MM)
    m = re.search(rf"\b(CHS|RO|ROR)\s*{_NUM}\s*X\s*{_NUM}", name)
    if m:
        od = float(m[2]) * MM
        return Section("CHS", name, od, od, float(m[3]) * MM)

    # Angles: L4X4X1/2 (inches), L 100X100X10, L100X10 (mm)
    m = re.search(rf"\bL\s*{_NUM}\s*X\s*{_NUM}\s*X\s*{_THICK}", name)
    if m:
        a, b = float(m[1]), float(m[2])
        imperial = "/" in m[3] or max(a, b) <= 12
        unit = INCH if imperial else MM
        wall = _inches(m[3]) if imperial else float(m[3])
        return Section("L", name, b * unit, a * unit, wall * unit)
    m = re.search(rf"\bL\s*{_NUM}\s*X\s*{_NUM}\b", name)
    if m and float(m[1]) > 12:
        leg = float(m[1]) * MM
        return Section("L", name, leg, leg, float(m[2]) * MM)

    return None


def _trim(number: str) -> str:
    return number[:-2] if number.endswith(".0") else number


# ── fitting a section into rvt's box ────────────────────────────────────────


def _close(actual: float, expected: float) -> bool:
    return abs(actual - expected) <= max(0.012, 0.12 * expected)


def _fit_both(section: Section, x: float, y: float) -> Optional[bool]:
    """Whether the section fits an x-by-y rectangle as is (False) or turned
    90 degrees (True); None if neither."""
    if _close(section.width, x) and _close(section.depth, y):
        return False
    if _close(section.width, y) and _close(section.depth, x):
        return True
    return None


def _fits_across(section: Section, width: float, height: float) -> Optional[bool]:
    """For a level beam: which way up the section fits its plan width, and a
    height rvt measured anywhere from a floor-cut top (shorter) to the line's
    top-of-steel box (taller). None if it doesn't fit."""
    options: List[Tuple[bool, float, float]] = [(False, section.width, section.depth)]
    if section.kind in ("RHS", "L"):
        options.append((True, section.depth, section.width))
    for turned, across, up in options:
        if _close(across, width) and 0.6 * height <= up <= 1.6 * height:
            return turned
    return None


# ── IFC construction ────────────────────────────────────────────────────────


def _profile(f: ifcopenshell.file, section: Section, turned: bool, location=(0.0, 0.0), ref=(1.0, 0.0)):
    if turned:
        ref = (-ref[1], ref[0])
    position = f.createIfcAxis2Placement2D(
        f.createIfcCartesianPoint([float(location[0]), float(location[1])]),
        f.createIfcDirection([float(ref[0]), float(ref[1])]),
    )
    s = section
    fillet = s.fillet or None
    if s.kind == "I":
        return f.createIfcIShapeProfileDef("AREA", s.name, position, s.width, s.depth, s.web, s.flange, fillet)
    if s.kind == "U":
        return f.createIfcUShapeProfileDef("AREA", s.name, position, s.depth, s.width, s.web, s.flange, fillet)
    if s.kind == "T":
        return f.createIfcTShapeProfileDef("AREA", s.name, position, s.depth, s.width, s.web, s.flange, fillet)
    if s.kind == "L":
        return f.createIfcLShapeProfileDef("AREA", s.name, position, s.depth, s.width, s.web)
    if s.kind == "RHS":
        return f.createIfcRectangleHollowProfileDef("AREA", s.name, position, s.width, s.depth, s.web)
    if s.kind == "CHS":
        return f.createIfcCircleHollowProfileDef("AREA", s.name, position, s.width / 2, s.web)
    raise ValueError(f"no profile for {s.kind}")


def _placement3d(f: ifcopenshell.file, origin, axis, ref):
    return f.createIfcAxis2Placement3D(
        f.createIfcCartesianPoint([float(c) for c in origin]),
        f.createIfcDirection([float(c) for c in axis]),
        f.createIfcDirection([float(c) for c in ref]),
    )


def _is_default(direction, default) -> bool:
    if direction is None:
        return True
    return all(abs(a - b) < 1e-9 for a, b in zip(direction.DirectionRatios, default))


@dataclass
class _PlanBox:
    """A level member's box, in its representation's frame."""

    centre: Tuple[float, float, float]  # plan centre, at the box bottom
    axis: Tuple[float, float]  # plan direction along the member
    length: float
    width: float
    height: float


def _plan_box(item) -> Optional[_PlanBox]:
    """rvt's level-member box: a plan rectangle extruded straight up."""
    profile = item.SweptArea
    if not profile.is_a("IfcRectangleProfileDef") or profile.is_a("IfcRectangleHollowProfileDef"):
        return None
    if not _is_default(item.ExtrudedDirection, (0, 0, 1)):
        return None
    pos = item.Position
    if pos is not None and not (_is_default(pos.Axis, (0, 0, 1)) and _is_default(pos.RefDirection, (1, 0, 0))):
        return None
    base = pos.Location.Coordinates if pos is not None else (0.0, 0.0, 0.0)
    ppos = profile.Position
    loc = ppos.Location.Coordinates if ppos is not None else (0.0, 0.0)
    ref = ppos.RefDirection.DirectionRatios if ppos is not None and ppos.RefDirection else (1.0, 0.0)
    norm = math.hypot(ref[0], ref[1])
    ref = (ref[0] / norm, ref[1] / norm)
    if profile.XDim >= profile.YDim:
        axis, length, width = ref, profile.XDim, profile.YDim
    else:
        axis, length, width = (-ref[1], ref[0]), profile.YDim, profile.XDim
    centre = (base[0] + loc[0], base[1] + loc[1], base[2])
    return _PlanBox(centre, axis, length, width, item.Depth)


def _beam_solid(f: ifcopenshell.file, section: Section, turned: bool, box: _PlanBox):
    """The section extruded along the beam, top of steel at the box top (the
    beam's location line is its top of steel)."""
    ax, ay = box.axis
    up = section.width if turned else section.depth
    origin = (
        box.centre[0] - ax * box.length / 2,
        box.centre[1] - ay * box.length / 2,
        box.centre[2] + box.height - up / 2,
    )
    # Profile X across the beam, profile Y up: RefDirection = up x axis
    placement = _placement3d(f, origin, (ax, ay, 0.0), (-ay, ax, 0.0))
    return f.createIfcExtrudedAreaSolid(
        _profile(f, section, turned), placement, f.createIfcDirection([0.0, 0.0, 1.0]), box.length
    )


def _joist_items(f: ifcopenshell.file, box: _PlanBox) -> list:
    """A bar joist: top and bottom chord plus a zigzag round-bar web."""
    ax, ay = box.axis
    across = (-ay, ax)
    chord = min(max(box.height * 0.08, 0.02), 0.06)
    items = []
    for z in (0.0, box.height - chord):
        start = (box.centre[0] - ax * box.length / 2, box.centre[1] - ay * box.length / 2, box.centre[2] + z)
        items.append(
            f.createIfcExtrudedAreaSolid(
                f.createIfcRectangleProfileDef(
                    "AREA", None,
                    f.createIfcAxis2Placement2D(f.createIfcCartesianPoint([0.0, chord / 2])),
                    box.width, chord,
                ),
                _placement3d(f, start, (ax, ay, 0.0), (across[0], across[1], 0.0)),
                f.createIfcDirection([0.0, 0.0, 1.0]),
                box.length,
            )
        )
    radius = min(0.011, box.width / 4)
    bar = f.createIfcCircleProfileDef("AREA", None, None, radius)
    low, high = chord / 2, box.height - chord / 2
    rise = high - low
    # Inset by the bar's radius so the web stays within the joist's ends
    span = box.length - 4 * radius
    if rise <= 0 or span <= 0:
        return items
    step = max(rise, 0.25)  # ~45 degree web
    count = max(1, round(span / step))
    step = span / count
    for i in range(count):
        z0, z1 = (low, high) if i % 2 == 0 else (high, low)
        s = -span / 2 + i * step
        p0 = (box.centre[0] + ax * s, box.centre[1] + ay * s, box.centre[2] + z0)
        p1 = (box.centre[0] + ax * (s + step), box.centre[1] + ay * (s + step), box.centre[2] + z1)
        d = (p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
        length = math.sqrt(sum(c * c for c in d))
        direction = tuple(c / length for c in d)
        items.append(
            f.createIfcExtrudedAreaSolid(
                bar, _placement3d(f, p0, direction, (across[0], across[1], 0.0)),
                f.createIfcDirection([0.0, 0.0, 1.0]), length,
            )
        )
    return items


# ── entry point ─────────────────────────────────────────────────────────────


def _family_and_type(element) -> Tuple[str, str]:
    # rvt names elements Family:Type:ElementId
    parts = (element.Name or "").split(":")
    if len(parts) >= 3:
        return parts[0], ":".join(parts[1:-1])
    if len(parts) == 2:
        return parts[0], parts[1]
    return "", parts[0]


def _body_item(element):
    rep = element.Representation
    if rep is None:
        return None, None
    for shape in rep.Representations:
        if shape.RepresentationIdentifier == "Body" and len(shape.Items) == 1:
            return shape, shape.Items[0]
    return None, None


def apply_real_sections(f: ifcopenshell.file) -> Dict[str, int]:
    """Replaces rvt's boxes with real steel sections in place; returns how
    many members got which outcome."""
    stats: Dict[str, int] = {}

    def count(outcome: str) -> None:
        stats[outcome] = stats.get(outcome, 0) + 1

    for element in f.by_type("IfcBeam") + f.by_type("IfcColumn") + f.by_type("IfcMember"):
        family, type_name = _family_and_type(element)
        section = parse_designation(family, type_name)
        if section is None:
            continue
        shape, item = _body_item(element)
        if item is None:
            count("skipped: no single body item")
            continue

        if section.kind == "JOIST":
            box = _plan_box(item) if item.is_a("IfcExtrudedAreaSolid") else None
            if box is None or box.length <= box.width:
                count("skipped: joist not a level box")
                continue
            shape.Items = _joist_items(f, box)
            count("joist")
            continue

        # A body rvt already drew as a mesh or as a real section is not a box
        profile = getattr(item, "SweptArea", None)
        if profile is None:
            count("skipped: not a swept solid")
            continue
        if not profile.is_a("IfcRectangleProfileDef") or profile.is_a("IfcRectangleHollowProfileDef"):
            count("skipped: not a rectangle")
            continue

        # The rectangle is the section itself: a sloped beam swept along its
        # centreline, or a column extruded up
        is_section = item.is_a("IfcFixedReferenceSweptAreaSolid") or (
            item.is_a("IfcExtrudedAreaSolid") and item.Depth > max(profile.XDim, profile.YDim)
        )
        if is_section:
            turned = _fit_both(section, profile.XDim, profile.YDim)
            if section.kind == "CHS" and turned is None:
                turned = False if _close(section.width, max(profile.XDim, profile.YDim)) else None
            if turned is None:
                count("skipped: section doesn't fit box")
                continue
            ppos = profile.Position
            loc = ppos.Location.Coordinates if ppos is not None else (0.0, 0.0)
            ref = ppos.RefDirection.DirectionRatios if ppos is not None and ppos.RefDirection else (1.0, 0.0)
            item.SweptArea = _profile(f, section, turned, loc, ref)
            count(f"{section.kind} section")
            continue

        box = _plan_box(item) if item.is_a("IfcExtrudedAreaSolid") else None
        if box is None:
            count("skipped: unexpected beam body")
            continue
        turned = _fits_across(section, box.width, box.height)
        if turned is None:
            count("skipped: section doesn't fit box")
            continue
        shape.Items = [_beam_solid(f, section, turned, box)]
        count(f"{section.kind} beam")

    return stats
