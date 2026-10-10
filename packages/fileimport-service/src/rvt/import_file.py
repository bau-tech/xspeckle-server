import json
import os
import sys
import tempfile
from pathlib import Path, PureWindowsPath
from typing import Any, Dict, List, Optional

import rvt
import structlog
from logging import INFO, WARNING, basicConfig, getLogger
from specklepy.api import operations
from specklepy.api.client import SpeckleClient
from specklepy.core.api.inputs import CreateModelInput, CreateVersionInput
from specklepy.core.api.models import Version
from specklepy.objects.base import Base
from specklepy.objects.data_objects import DataObject
from specklepy.objects.models.collections.collection import Collection
from specklepy.transports.server import ServerTransport

basicConfig(format="%(message)s", stream=sys.stdout, level=INFO)
# specklepy 3.0.1 logs every uploaded batch at INFO with a malformed call
# (message and args don't match), so logging dumps a "--- Logging error ---"
# traceback to stderr per batch. Fixed upstream later; until the pin moves,
# keep that logger to warnings.
getLogger("specklepy.transports.server.batch_sender").setLevel(WARNING)
# gql (specklepy's GraphQL client) logs every request and response body at INFO
getLogger("gql.transport.requests").setLevel(WARNING)

structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.UnicodeDecoder(),
        structlog.processors.CallsiteParameterAdder(
            {
                structlog.processors.CallsiteParameter.FILENAME,
                structlog.processors.CallsiteParameter.FUNC_NAME,
                structlog.processors.CallsiteParameter.LINENO,
            }
        ),
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(INFO),
    logger_factory=structlog.stdlib.LoggerFactory(),
    cache_logger_on_first_use=True,
)
LOG = structlog.get_logger()
# steel_profiles.py and wall_openings.py sit next to this script
sys.path.insert(0, str(Path(__file__).resolve().parent))
DEFAULT_BRANCH = "uploads"
MAX_ELEMENT_FIELD_COUNT = 100


def _json_or_none(raw: Optional[str]) -> Optional[Any]:
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return raw


def _safe_call(description: str, fn: Any) -> Any:
    try:
        return fn()
    except Exception as ex:
        LOG.warning("RVT %s failed: %s", description, ex)
        return {"error": str(ex)}


def _safe_method(target: Any, method_name: str) -> Any:
    method = getattr(target, method_name, None)
    if method is None:
        return {"unavailable": f"rvt.{method_name} is not exposed by this rvt package"}
    return _safe_call(method_name, method)


def _safe_attr(target: Any, attr_name: str) -> Any:
    return _safe_call(attr_name, lambda: getattr(target, attr_name))


def _truncate_fields(fields: Any) -> Any:
    if not isinstance(fields, list):
        return fields
    if len(fields) <= MAX_ELEMENT_FIELD_COUNT:
        return fields
    return fields[:MAX_ELEMENT_FIELD_COUNT] + [
        {"truncated": len(fields) - MAX_ELEMENT_FIELD_COUNT}
    ]


def _strip_nul(text: str) -> str:
    # Postgres jsonb can't store U+0000 ("\u0000 cannot be converted to text"),
    # and rvt hands some streams back as raw binary strings full of them
    return text.replace("\x00", "")


def _strip_nul_in_tree(value: Any) -> Any:
    """Removes U+0000 from every string in a Speckle object tree, in place."""
    if isinstance(value, str):
        return _strip_nul(value)
    if isinstance(value, Base):
        for name in value.get_member_names():
            member = getattr(value, name, None)
            if isinstance(member, (str, Base, dict, list)):
                cleaned = _strip_nul_in_tree(member)
                if cleaned is not member:
                    setattr(value, name, cleaned)
        return value
    if isinstance(value, dict):
        for key in list(value.keys()):
            cleaned = _strip_nul_in_tree(value[key])
            if isinstance(key, str) and "\x00" in key:
                del value[key]
                value[_strip_nul(key)] = cleaned
            elif cleaned is not value[key]:
                value[key] = cleaned
        return value
    if isinstance(value, list):
        for i, item in enumerate(value):
            cleaned = _strip_nul_in_tree(item)
            if cleaned is not item:
                value[i] = cleaned
        return value
    return value


def _json_safe_value(value: Any) -> Any:
    if isinstance(value, str):
        return _strip_nul(value)
    if isinstance(value, dict):
        return {_strip_nul(str(k)): _json_safe_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe_value(item) for item in value]
    if isinstance(value, tuple):
        return [_json_safe_value(item) for item in value]
    if isinstance(value, set):
        return [_json_safe_value(item) for item in sorted(value)]
    if isinstance(value, bytes):
        return _strip_nul(value.decode("utf-8", errors="replace"))
    return value


def _maybe_json_loads(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def _content_type(value: Any) -> str:
    if value is None:
        return "none"
    if isinstance(value, (dict, list, tuple, set)):
        return "structured"
    if isinstance(value, bytes):
        return "bytes"
    if isinstance(value, str):
        return "text"
    if isinstance(value, (int, float, bool)):
        return "primitive"
    return type(value).__name__


def _basic_file_info_collection(revit_file: rvt.RevitFile) -> Collection:
    basic_file_info = _safe_call(
        "basic_file_info_json", lambda: _json_or_none(revit_file.basic_file_info_json())
    )
    if isinstance(basic_file_info, dict) and basic_file_info.get("error"):
        return Collection(
            name="Basic File Info",
            elements=[
                DataObject(
                    name="Basic file info read failed",
                    displayValue=[],
                    properties=basic_file_info,
                )
            ],
        )

    payload = _json_safe_value(basic_file_info)
    if not isinstance(payload, dict):
        payload = {"value": payload, "contentType": _content_type(basic_file_info)}

    return Collection(
        name="Basic File Info",
        elements=[
            DataObject.of_type(
                "Objects.Data.RevitBasicFileInfo",
                name="BasicFileInfo",
                properties=payload,
                displayValue=[],
            )
        ],
    )


def _part_atom_collection(revit_file: rvt.RevitFile) -> Collection:
    part_atom = _safe_call(
        "part_atom_json", lambda: _json_or_none(revit_file.part_atom_json())
    )
    if isinstance(part_atom, dict) and part_atom.get("error"):
        return Collection(
            name="Part Atom",
            elements=[
                DataObject(
                    name="Part atom read failed",
                    displayValue=[],
                    properties=part_atom,
                )
            ],
        )

    payload = _json_safe_value(part_atom)
    if not isinstance(payload, dict):
        payload = {"value": payload, "contentType": _content_type(part_atom)}

    return Collection(
        name="Part Atom",
        elements=[
            DataObject.of_type(
                "Objects.Data.RevitPartAtom",
                name="PartAtom",
                properties=payload,
                displayValue=[],
            )
        ],
    )


def _metadata_object(file_path: str, revit_file: rvt.RevitFile) -> DataObject:
    basic_file_info = _safe_call(
        "basic_file_info_json", lambda: _json_or_none(revit_file.basic_file_info_json())
    )
    part_atom = _safe_call(
        "part_atom_json", lambda: _json_or_none(revit_file.part_atom_json())
    )
    stream_names = _safe_method(revit_file, "stream_names")
    missing_required_streams = _safe_method(revit_file, "missing_required_streams")
    schema_summary = _safe_method(revit_file, "schema_summary")
    schema_json = _safe_method(revit_file, "schema_json")
    adocument = _safe_method(revit_file, "read_adocument")

    metadata = DataObject.of_type(
        "Objects.Data.RevitFile",
        name=Path(file_path).name,
        properties={
            "version": _safe_attr(revit_file, "version"),
            "build": _safe_attr(revit_file, "build"),
            "guid": _safe_attr(revit_file, "guid"),
            "originalPath": _safe_attr(revit_file, "original_path"),
            "partAtomTitle": _safe_attr(revit_file, "part_atom_title"),
            "basicFileInfo": _json_safe_value(basic_file_info),
            "partAtom": _json_safe_value(part_atom),
            "streamNames": _json_safe_value(stream_names),
            "missingRequiredStreams": _json_safe_value(missing_required_streams),
            "schemaSummary": _json_safe_value(schema_summary),
            "schemaJson": _json_safe_value(schema_json),
            "adocument": _json_safe_value(adocument),
        },
        # specklepy rejects a DataObject without an explicit displayValue
        displayValue=[],
    )
    metadata["warnings"] = [
        "RVT import is experimental.",
        "No geometry could be decoded from this file, so this import stores the parser's metadata and document records only. Geometry is decoded from Revit 2023 to 2025 project files whose element records rvt can locate.",
    ]
    return metadata


def _convert_decoded_element(element: Dict[str, Any]) -> DataObject:
    typed = element.get("typed") if isinstance(element.get("typed"), dict) else {}
    properties = {
        "id": element.get("id"),
        "className": element.get("class_name"),
        "byteRange": element.get("byte_range"),
        "fields": _truncate_fields(element.get("fields")),
        "typed": typed,
    }
    name = str(typed.get("name") or element.get("class_name") or element.get("id") or "")
    speckle_element = DataObject.of_type(
        "Objects.Data.RevitObject",
        name=name,
        properties=properties,
        displayValue=[],
    )
    if element.get("id") is not None:
        speckle_element.applicationId = str(element["id"])
    speckle_element["className"] = element.get("class_name")
    return speckle_element


def _document_collections(revit_file: rvt.RevitFile) -> Collection:
    document = _safe_method(revit_file, "read_adocument")
    if isinstance(document, dict) and document.get("unavailable"):
        return Collection(
            name="Document",
            elements=[
                DataObject(
                    name="ADocument unavailable",
                    displayValue=[],
                    properties=document,
                )
            ],
        )
    if isinstance(document, dict) and document.get("error"):
        return Collection(
            name="Document",
            elements=[
                DataObject(
                    name="ADocument read failed",
                    displayValue=[],
                    properties=document,
                )
            ],
        )
    if not isinstance(document, dict) or not document:
        return Collection(
            name="Document",
            elements=[
                DataObject(
                    name="No ADocument data available",
                    displayValue=[],
                    properties={
                        "message": "read_document() returned no data for this RVT file."
                    },
                )
            ],
        )

    fields = document.get("fields", []) if isinstance(document, dict) else []
    document_object = DataObject.of_type(
        "Objects.Data.RevitDocument",
        name="ADocument",
        properties={
            "entryOffset": document.get("entry_offset"),
            "version": document.get("version"),
            "fieldCount": len(fields) if isinstance(fields, list) else 0,
            "fields": fields,
        },
        displayValue=[],
    )
    return Collection(name="Document", elements=[document_object])


def _schema_collections(revit_file: rvt.RevitFile) -> Collection:
    schema_json = _safe_method(revit_file, "schema_json")
    if isinstance(schema_json, dict) and schema_json.get("unavailable"):
        return Collection(
            name="Schema",
            elements=[
                DataObject(
                    name="Schema unavailable",
                    displayValue=[],
                    properties=schema_json,
                )
            ],
        )
    if isinstance(schema_json, dict) and schema_json.get("error"):
        return Collection(
            name="Schema",
            elements=[
                DataObject(
                    name="Schema read failed",
                    displayValue=[],
                    properties=schema_json,
                )
            ],
        )
    if not isinstance(schema_json, str):
        return Collection(
            name="Schema",
            elements=[
                DataObject(
                    name="No schema data available",
                    displayValue=[],
                    properties={
                        "message": "schema_json() returned no data for this RVT file."
                    },
                )
            ],
        )

    try:
        schema_data = json.loads(schema_json)
    except json.JSONDecodeError as ex:
        return Collection(
            name="Schema",
            elements=[
                DataObject(
                    name="Schema decode failed",
                    displayValue=[],
                    properties={"error": str(ex), "raw": schema_json[:500]},
                )
            ],
        )

    classes = schema_data.get("classes", []) if isinstance(schema_data, dict) else []
    schema_elements: List[Base] = []
    for class_entry in classes:
        if not isinstance(class_entry, dict):
            continue
        fields = class_entry.get("fields", []) if isinstance(class_entry, dict) else []
        schema_elements.append(
            DataObject.of_type(
                "Objects.Data.RevitSchemaClass",
                name=str(class_entry.get("name") or "UnknownClass"),
                properties={
                    "tag": class_entry.get("tag"),
                    "offset": class_entry.get("offset"),
                    "fieldCount": len(fields) if isinstance(fields, list) else 0,
                    "fields": _truncate_fields(fields),
                    "parent": class_entry.get("parent"),
                },
                displayValue=[],
            )
        )

    return Collection(name="Schema", elements=schema_elements)


def _schema_summary_collections(revit_file: rvt.RevitFile) -> Collection:
    schema_summary = _safe_method(revit_file, "schema_summary")
    schema_summary = _maybe_json_loads(schema_summary)
    if isinstance(schema_summary, dict) and schema_summary.get("unavailable"):
        return Collection(
            name="Schema Summary",
            elements=[
                DataObject(
                    name="Schema summary unavailable",
                    displayValue=[],
                    properties=schema_summary,
                )
            ],
        )
    if isinstance(schema_summary, dict) and schema_summary.get("error"):
        return Collection(
            name="Schema Summary",
            elements=[
                DataObject(
                    name="Schema summary failed",
                    displayValue=[],
                    properties=schema_summary,
                )
            ],
        )
    if not isinstance(schema_summary, (dict, list)):
        return Collection(
            name="Schema Summary",
            elements=[
                DataObject(
                    name="No schema summary available",
                    displayValue=[],
                    properties={
                        "message": "schema_summary() returned no data for this RVT file."
                    },
                )
            ],
        )

    if isinstance(schema_summary, dict):
        return Collection(
            name="Schema Summary",
            elements=[
                DataObject.of_type(
                    "Objects.Data.RevitSchemaSummary",
                    name="SchemaSummary",
                    properties=schema_summary,
                    displayValue=[],
                )
            ],
        )

    summary_elements: List[Base] = []
    for summary_entry in schema_summary:
        if not isinstance(summary_entry, dict):
            continue
        summary_elements.append(
            DataObject.of_type(
                "Objects.Data.RevitSchemaSummaryEntry",
                name=str(summary_entry.get("name") or summary_entry.get("class_name") or "SummaryEntry"),
                properties=summary_entry,
                displayValue=[],
            )
        )

    if not summary_elements:
        return Collection(
            name="Schema Summary",
            elements=[
                DataObject(
                    name="No schema summary entries",
                    displayValue=[],
                    properties={"message": "schema_summary() returned an empty list."},
                )
            ],
        )

    return Collection(name="Schema Summary", elements=summary_elements)


def _ifc_export(revit_file: rvt.RevitFile) -> DataObject:
    ifc_step = _safe_call("write_ifc", lambda: revit_file.write_ifc())
    if isinstance(ifc_step, dict) and ifc_step.get("error"):
        return DataObject(
            name="IFC export failed",
            displayValue=[],
            properties=ifc_step,
        )
    if not isinstance(ifc_step, str):
        return DataObject(
            name="IFC export unavailable",
            displayValue=[],
            properties={"message": "write_ifc() returned no IFC STEP data."},
        )

    payload = ifc_step.strip()
    truncated = len(payload) > 200000
    preview = payload[:200000] if truncated else payload
    return DataObject.of_type(
        "Objects.Data.RevitIfcExport",
        name="IFC Export",
        properties={
            "ifcStep": preview,
            "truncated": truncated,
            "length": len(payload),
        },
        displayValue=[],
    )


def _stream_collections(revit_file: rvt.RevitFile) -> Collection:
    stream_names = _safe_method(revit_file, "stream_names")
    missing_required_streams = _safe_method(revit_file, "missing_required_streams")

    if not isinstance(stream_names, list):
        stream_names = []
    if not isinstance(missing_required_streams, list):
        missing_required_streams = []

    missing_required_streams = sorted(set(missing_required_streams))
    stream_elements: List[Base] = []
    stream_elements.append(
        DataObject.of_type(
            "Objects.Data.RevitStreamSummary",
            name="Stream Summary",
            properties={
                "streamCount": len(stream_names),
                "missingRequiredStreamCount": len(missing_required_streams),
                "missingRequiredStreams": missing_required_streams,
            },
            displayValue=[],
        )
    )

    missing_set = set(missing_required_streams)
    for stream_name in stream_names:
        stream_elements.append(
            DataObject.of_type(
                "Objects.Data.RevitStream",
                name=str(stream_name),
                properties={
                    "missingRequired": stream_name in missing_set,
                    "isMissingRequiredStream": stream_name in missing_set,
                },
                displayValue=[],
            )
        )

    if not stream_names:
        stream_elements.append(
            DataObject(
                name="No streams discovered",
                displayValue=[],
                properties={
                    "message": "stream_names() returned no data for this RVT file.",
                    "missingRequiredStreams": missing_required_streams,
                },
            )
        )

    return Collection(name="Streams", elements=stream_elements)


def _stream_content_collections(revit_file: rvt.RevitFile) -> Collection:
    stream_names = _safe_method(revit_file, "stream_names")
    if not isinstance(stream_names, list):
        stream_names = []

    stream_content_elements: List[Base] = []
    for stream_name in stream_names:
        stream_value = _safe_call(
            f"read_stream::{stream_name}",
            lambda: revit_file.read_stream(str(stream_name)),
        )
        stream_value = _maybe_json_loads(stream_value)
        if isinstance(stream_value, dict) and stream_value.get("error"):
            stream_content_elements.append(
                DataObject(
                    name=str(stream_name),
                    displayValue=[],
                    properties={
                        "streamName": str(stream_name),
                        "error": stream_value.get("error"),
                    },
                )
            )
            continue

        content = _json_safe_value(stream_value)
        stream_content_elements.append(
            DataObject.of_type(
                "Objects.Data.RevitStreamContent",
                name=str(stream_name),
                properties={
                    "streamName": str(stream_name),
                    "contentType": _content_type(stream_value),
                    "content": content,
                },
                displayValue=[],
            )
        )

    if not stream_content_elements:
        stream_content_elements.append(
            DataObject(
                name="No stream content available",
                displayValue=[],
                properties={
                    "message": "read_stream() returned no data for this RVT file."
                },
            )
        )

    return Collection(name="Stream Content", elements=stream_content_elements)


def _decoded_element_collections(revit_file: rvt.RevitFile) -> Collection:
    decoded_elements = _safe_method(revit_file, "decoded_elements")
    if isinstance(decoded_elements, dict) and decoded_elements.get("unavailable"):
        return Collection(
            name="Decoded Elements",
            elements=[
                DataObject(
                    name="Decoded element extraction unavailable",
                    displayValue=[],
                    properties=decoded_elements,
                )
            ],
        )
    if isinstance(decoded_elements, dict) and decoded_elements.get("error"):
        return Collection(
            name="Decoded Elements",
            elements=[
                DataObject(
                    name="Decoded element extraction failed",
                    displayValue=[],
                    properties=decoded_elements,
                )
            ],
        )
    if not isinstance(decoded_elements, list):
        decoded_elements = []

    collections_by_class: Dict[str, Collection] = {}
    root_elements: List[Base] = []
    for element in decoded_elements:
        if not isinstance(element, dict):
            continue
        class_name = str(element.get("class_name") or "Unknown")
        collection = collections_by_class.get(class_name)
        if collection is None:
            collection = Collection(name=class_name, elements=[])
            collections_by_class[class_name] = collection
            root_elements.append(collection)
        collection.elements.append(_convert_decoded_element(element))

    LOG.info(
        "Converted %s RVT decoded elements into %s class collections",
        len(decoded_elements),
        len(collections_by_class),
    )
    return Collection(name="Decoded Elements", elements=root_elements)


def _element_count(revit_file: rvt.RevitFile) -> Dict[str, Any]:
    counts = _safe_method(revit_file, "element_counts")
    if isinstance(counts, dict) and isinstance(counts.get("total"), int):
        return counts
    return {"total": 0, "by_class": {}}


def _file_info_object(
    file_path: str, revit_file: rvt.RevitFile, counts: Dict[str, Any]
) -> DataObject:
    """The RVT file's own metadata, kept next to the geometry. Lighter than
    _metadata_object: no schema dump, which only matters for the parser."""
    return DataObject.of_type(
        "Objects.Data.RevitFile",
        name=Path(file_path).name,
        properties={
            "version": _safe_attr(revit_file, "version"),
            "build": _safe_attr(revit_file, "build"),
            "guid": _safe_attr(revit_file, "guid"),
            "originalPath": _safe_attr(revit_file, "original_path"),
            "basicFileInfo": _json_safe_value(
                _safe_call(
                    "basic_file_info_json",
                    lambda: _json_or_none(revit_file.basic_file_info_json()),
                )
            ),
            "decodedElementCount": counts["total"],
            "decodedElementsByClass": counts.get("by_class", {}),
            "rvtPackageVersion": getattr(rvt, "__version__", None),
        },
        displayValue=[],
    )


def _improve_geometry(ifc_file: Any) -> Dict[str, Dict[str, int]]:
    """Fills gaps in rvt's IFC before speckleifc reads it: steel members'
    real cross-sections instead of boxes (steel_profiles.py), openings cut by
    opening/void families instead of their solid blocks (void_families.py),
    and openings for the doors/windows rvt couldn't tie to their wall
    (wall_openings.py). Each step is best effort -- if one fails, its part of
    rvt's IFC stays as is."""
    results: Dict[str, Dict[str, int]] = {}
    for key, module, function in (
        ("steelSections", "steel_profiles", "apply_real_sections"),
        ("voidFamilies", "void_families", "openings_from_void_families"),
        ("addedOpenings", "wall_openings", "add_missing_openings"),
    ):
        try:
            step = getattr(__import__(module), function)
            results[key] = step(ifc_file)
            LOG.info("%s: %s", key, results[key])
        except Exception as ex:
            LOG.warning("%s failed, leaving rvt's geometry as is: %s", key, ex)
            results[key] = {"failed": 1}
    return results


# Opt-in: draw family instances (doors, windows, furniture, fixtures) from
# the meshes Revit saved for their display instead of their record's bounding
# box -- the saved_meshes option our rvt-rs patch adds (rvt-rs-patches/0002).
# Off by default: on Autodesk's small 2023 sample project it turns 350 boxes
# into ~740,000 triangles (a 0.9 MB IFC becomes 29 MB) and speckleifc's
# conversion then outgrows 3 GB, which on a real project would take the
# import service down.
SAVED_MESHES = os.environ.get("RVT_SAVED_MESHES", "").lower() in ("1", "true", "yes")


def _write_ifc(revit_file: rvt.RevitFile) -> str:
    """rvt's IFC, with saved display meshes when RVT_SAVED_MESHES is set
    (rvt keeps the boxes where it can't read them; an rvt build without the
    option exports boxes as before)."""
    if SAVED_MESHES:
        try:
            return revit_file.write_ifc(saved_meshes=True)
        except TypeError:
            pass
    return revit_file.write_ifc()


class _QuietProgress:
    """speckleifc reports conversion progress to the server's model ingestion
    API, which this server doesn't have: swallow the reports."""

    def report(self, progress_message: str, progress: Optional[float]) -> None:
        pass

    def should_report_progress(self) -> bool:
        return False


def convert_rvt_geometry(file_path: str, revit_file: rvt.RevitFile) -> Optional[Base]:
    """
    Real geometry, when the rvt package can decode the file's elements (Revit
    2023-2025 projects as of rvt-rs main@120e2f9ffa): rvt writes an IFC4 model
    with typed elements and their bodies, which Speckle's own IFC importer
    (speckleifc, also used for .ifc uploads) turns into Speckle objects.

    Returns None when there are no decoded elements (older Revit releases,
    families, an rvt package without element decoding) or speckleifc isn't
    available -- the caller then falls back to the metadata-only import.
    """
    counts = _element_count(revit_file)
    if not counts["total"]:
        LOG.info("RVT has no decoded elements, importing metadata only")
        return None

    try:
        from speckleifc.ifc_geometry_processing import open_ifc
        from speckleifc.importer import ImportJob
    except ImportError as ex:
        LOG.warning("speckleifc is not importable, importing metadata only: %s", ex)
        return None

    ifc_step = _write_ifc(revit_file)
    fd, ifc_path = tempfile.mkstemp(suffix=".ifc")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as ifc_out:
            ifc_out.write(ifc_step)
        del ifc_step
        ifc_file = open_ifc(ifc_path)
        improvements = _improve_geometry(ifc_file)
        root = ImportJob(ifc_file, _QuietProgress()).convert()
    finally:
        os.unlink(ifc_path)

    LOG.info(
        "Converted %s decoded RVT elements to geometry via IFC", counts["total"]
    )
    # The IFC project is named after the file's original path on the author's
    # machine (e.g. "E:\\Projects\\Tower.rvt") -- keep just the file name
    root_name = getattr(root, "name", None)
    if isinstance(root_name, str) and root_name:
        root.name = PureWindowsPath(root_name).name
    elements = getattr(root, "elements", None)
    if isinstance(elements, list):
        file_info = _file_info_object(file_path, revit_file, counts)
        file_info.properties.update(improvements)
        # The upload sits in a temp file literally named "file" on the server;
        # the root carries the real file name
        if isinstance(root.name, str) and root.name:
            file_info.name = root.name
        elements.append(file_info)
    return root


def convert_rvt(
    file_path: str, revit_file: Optional[rvt.RevitFile] = None
) -> Collection:
    revit_file = revit_file or rvt.RevitFile(file_path)
    return Collection(
        name=Path(file_path).name,
        elements=[
            _metadata_object(file_path, revit_file),
            _basic_file_info_collection(revit_file),
            _part_atom_collection(revit_file),
            _document_collections(revit_file),
            _schema_collections(revit_file),
            _schema_summary_collections(revit_file),
            _stream_collections(revit_file),
            _stream_content_collections(revit_file),
            _ifc_export(revit_file),
            _decoded_element_collections(revit_file),
        ],
    )


def import_rvt(
    file_path: str,
    project_id: str,
    model_id: Optional[str],
    branch_name: str,
    commit_message: str,
) -> Version:
    revit_file = rvt.RevitFile(file_path)
    speckle_root: Optional[Base] = None
    try:
        speckle_root = convert_rvt_geometry(file_path, revit_file)
    except Exception as ex:
        LOG.warning("RVT geometry import failed, importing metadata only: %s", ex)
    if speckle_root is None:
        speckle_root = convert_rvt(file_path, revit_file)
    _strip_nul_in_tree(speckle_root)

    client = SpeckleClient(
        host=os.getenv("SPECKLE_SERVER_URL", "127.0.0.1:3000"), use_ssl=False
    )
    token = os.environ["USER_TOKEN"]
    if not token:
        raise Exception('Expected an env var "USER_TOKEN"')
    client.authenticate_with_token(token)

    if model_id:
        model = client.model.get(model_id, project_id)
    else:
        model_create_input = CreateModelInput(
            name=branch_name,
            description="File upload branch" if branch_name == "uploads" else "",
            project_id=project_id,
        )
        model = client.model.create(model_create_input)

    transport = ServerTransport(client=client, stream_id=project_id)
    object_id = operations.send(
        base=speckle_root, transports=[transport], use_default_cache=False
    )

    create_commit = CreateVersionInput(
        object_id=object_id,
        model_id=model.id,
        project_id=project_id,
        message=(commit_message or "RVT file upload"),
        source_application="RVT",
    )
    version = client.version.create(create_commit)

    return version


if __name__ == "__main__":
    (
        file_path,
        tmp_results_path,
        _,
        project_id,
        branch_name,
        commit_message,
        _,
        model_id,
        _,
    ) = sys.argv[1:]
    try:
        LOG.info("ImportRVT argv[1:]:%s", sys.argv[1:])
        version = import_rvt(file_path, project_id, model_id, branch_name, commit_message)
        results: Dict[str, Any] = {"success": True, "commitId": version.id}
    except Exception as ex:
        LOG.exception(ex)
        results = {"success": False, "error": str(ex)}

    Path(tmp_results_path).write_text(json.dumps(results))
