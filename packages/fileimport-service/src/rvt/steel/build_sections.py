"""
Builds sections.json, the rolled steel section table steel_profiles.py uses
to draw Revit steel members with their real cross-sections.

Only the dimensions a profile needs are kept, in metres:
  I (W, HP, M, S, HEA, HEB, HEM, IPE, IPN): d, bf, tw, tf, r
  U (C, MC, UPN):                            d, bf, tw, tf, r
  T (WT, MT, ST):                            d, bf, tw, tf, r
  CHS (AISC Pipe):                           od, t
Hollow sections and angles aren't listed: their names carry their size
(HSS6x6x5/8, SHS100x8, L4x4x1/2), see steel_profiles.parse_designation.

Sources (see THIRD_PARTY_NOTICES.md):
  - AISC shapes, in inches: the shape files of the `steelpy` package
    (Apache-2.0), https://pypi.org/project/steelpy/ 1.1.1
  - European shapes, in mm: github.com/timskovjacobsen/steelprofiles_api
    (MIT) assets/*.csv at ceb131bd6c653cbd9e06279f61e69a2d0739ef25

Usage: python build_sections.py <steelpy "shape files" dir> <steelprofiles_api assets dir>
"""
import csv
import json
import sys
from pathlib import Path

INCH = 0.0254
MM = 0.001


def _key(name: str) -> str:
    return name.upper().replace(" ", "").replace("-", "")


def _num(row: dict, col: str) -> float:
    return float(row[col])


def _round(values: dict) -> dict:
    return {k: (round(v, 5) if isinstance(v, float) else v) for k, v in values.items()}


def _aisc(shape_dir: Path, sections: dict) -> None:
    flanged = {"W": "I", "HP": "I", "M": "I", "S": "I", "C": "U", "MC": "U",
               "WT": "T", "MT": "T", "ST": "T"}
    for prefix, kind in flanged.items():
        with open(shape_dir / f"{prefix}_shapes.csv", newline="") as f:
            for row in csv.DictReader(f):
                tf = _num(row, "tf")
                # AISC's k is flange face to web toe of fillet, so the fillet
                # radius is what it adds past the flange
                fillet = max(_num(row, "k") - tf, 0.0)
                sections[_key(row["shape"])] = _round({
                    "kind": kind,
                    "d": _num(row, "d") * INCH,
                    "bf": _num(row, "bf") * INCH,
                    "tw": _num(row, "tw") * INCH,
                    "tf": tf * INCH,
                    "r": fillet * INCH,
                })
    with open(shape_dir / "PIPE_shapes.csv", newline="") as f:
        for row in csv.DictReader(f):
            sections[_key(row["shape"])] = _round({
                "kind": "CHS",
                "od": _num(row, "OD") * INCH,
                "t": _num(row, "tdes") * INCH,
            })


def _european(assets_dir: Path, sections: dict) -> None:
    for series, kind in {"HEA": "I", "HEB": "I", "HEM": "I", "IPE": "I",
                         "IPN": "I", "UPN": "U"}.items():
        with open(assets_dir / f"{series}.csv", newline="") as f:
            for row in csv.DictReader(f):
                fillet = row.get("r") or row.get("r1") or "0"
                sections[_key(row["name"])] = _round({
                    "kind": kind,
                    "d": _num(row, "h") * MM,
                    "bf": _num(row, "b") * MM,
                    "tw": _num(row, "tw") * MM,
                    "tf": _num(row, "tf") * MM,
                    "r": float(fillet) * MM,
                })


def main() -> None:
    shape_dir, assets_dir = Path(sys.argv[1]), Path(sys.argv[2])
    sections: dict = {}
    _aisc(shape_dir, sections)
    _european(assets_dir, sections)
    out = Path(__file__).with_name("sections.json")
    out.write_text(
        json.dumps({"units": "m", "sections": dict(sorted(sections.items()))},
                   separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"{len(sections)} sections -> {out}")


if __name__ == "__main__":
    main()
