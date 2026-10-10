"""
.ifczip importer: unpacks the IFC inside the archive and hands it to the .ifc
importer, exactly as the plain .ifc branch in daemon.ts would.
"""
import json
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


def pick_ifc_member(archive: zipfile.ZipFile) -> zipfile.ZipInfo:
    candidates = [
        info
        for info in archive.infolist()
        if not info.is_dir()
        and info.filename.lower().endswith(".ifc")
        and not PurePosixPath(info.filename).parts[0] == "__MACOSX"
    ]
    if not candidates:
        raise ValueError("The .ifczip archive does not contain an .ifc file")
    # An ifczip normally holds exactly one model; if not, the biggest is the model
    return max(candidates, key=lambda info: info.file_size)


def extract_ifc(zip_path: str, destination: str) -> str:
    try:
        with zipfile.ZipFile(zip_path) as archive:
            member = pick_ifc_member(archive)
            target = Path(destination) / PurePosixPath(member.filename).name
            with archive.open(member) as src, open(target, "wb") as dst:
                while chunk := src.read(1024 * 1024):
                    dst.write(chunk)
            print(f"Extracted {member.filename} ({member.file_size} bytes) from ifczip")
            return str(target)
    except zipfile.BadZipFile as ex:
        raise ValueError("The uploaded .ifczip is not a valid zip archive") from ex


IFC_IMPORTER = Path(__file__).resolve().parent.parent / "ifc-python" / "import_file.py"


def main() -> None:
    zip_path, results_path, project_id, commit_message, model_id = sys.argv[1:6]
    try:
        with tempfile.TemporaryDirectory() as tmp_dir:
            ifc_path = extract_ifc(zip_path, tmp_dir)
            # the .ifc importer writes results_path itself, same contract as the .ifc branch
            subprocess.run(
                [
                    sys.executable,
                    "-u",
                    str(IFC_IMPORTER),
                    ifc_path,
                    results_path,
                    project_id,
                    commit_message,
                    model_id,
                ],
                env=os.environ.copy(),
                check=True,
            )
    except Exception as ex:
        print(f"ifczip import failed: {ex}", file=sys.stderr)
        Path(results_path).write_text(json.dumps({"success": False, "error": str(ex)}))


if __name__ == "__main__":
    main()
