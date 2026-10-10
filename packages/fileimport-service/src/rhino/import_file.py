"""
Rhino (.3dm) importer, built on rhino3dm (github.com/mcneel/rhino3dm, MIT) --
McNeel's own openNURBS reader, no Rhino install or license involved.

Straight to Speckle objects, laid out like Speckle's own Rhino connector:

  - root Collection (the file) > nested Collections for the layer tree
  - each Rhino object: a DataObject (name, user strings as properties) whose
    displayValue is its geometry -- meshes, polylines, points, point clouds
  - block references: InstanceProxies; block definitions in
    root.instanceDefinitionProxies, their member objects converted once
  - materials / display colours: root.renderMaterialProxies

rhino3dm reads every object but can't mesh NURBS: Breps and extrusions show
the render meshes Rhino cached in the file. A file saved without them
("Save Small", or written by another program) leaves those objects without
geometry -- they're kept, with their properties, and counted on the
Objects.Data.RhinoFile object (brepsWithoutRenderMeshes). SubDs are meshed
from their subdivided control net.
"""
import json
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import rhino3dm as rh
import structlog
from logging import INFO, WARNING, basicConfig, getLogger
from specklepy.api import operations
from specklepy.api.client import SpeckleClient
from specklepy.core.api.inputs import CreateModelInput, CreateVersionInput
from specklepy.core.api.models import Version
from specklepy.objects.base import Base
from specklepy.objects.data_objects import DataObject
from specklepy.objects.geometry import Mesh, Point, Polyline
from specklepy.objects.models.collections.collection import Collection
from specklepy.objects.other import RenderMaterial
from specklepy.objects.proxies import (
    InstanceDefinitionProxy,
    InstanceProxy,
    RenderMaterialProxy,
)
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
        structlog.processors.add_log_level,
        structlog.processors.format_exc_info,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(INFO),
    logger_factory=structlog.stdlib.LoggerFactory(),
    cache_logger_on_first_use=True,
)
LOG = structlog.get_logger()

# Rhino unit system -> (Speckle unit, factor to apply to coordinates). Units
# Speckle has no name for are converted to metres.
_UNITS = {
    rh.UnitSystem.Millimeters: ("mm", 1.0),
    rh.UnitSystem.Centimeters: ("cm", 1.0),
    rh.UnitSystem.Meters: ("m", 1.0),
    rh.UnitSystem.Kilometers: ("km", 1.0),
    rh.UnitSystem.Inches: ("in", 1.0),
    rh.UnitSystem.Feet: ("ft", 1.0),
    rh.UnitSystem.Yards: ("yd", 1.0),
    rh.UnitSystem.Miles: ("mi", 1.0),
    rh.UnitSystem.Microns: ("m", 1e-6),
    rh.UnitSystem.Decimeters: ("m", 0.1),
    rh.UnitSystem.Nanometers: ("m", 1e-9),
}


class Pointcloud(Base, speckle_type="Objects.Geometry.Pointcloud"):
    """The point cloud the viewer draws: `points` a flat x,y,z list.
    specklepy 3's own Objects.Geometry.PointCloud holds Point objects under a
    type name the viewer doesn't know, so it would never render."""


# SubD: subdivide the control net until about this many faces (at most 3
# levels) -- close to the smooth limit surface without exploding in size
SUBD_TARGET_FACES = 150_000
BLOCK_DEFINITIONS = "Block definitions"


def _argb(color, alpha: Optional[float] = None) -> int:
    """rhino3dm colours are (r, g, b, a) tuples; Speckle stores a signed
    32-bit ARGB int."""
    r, g, b = int(color[0]), int(color[1]), int(color[2])
    a = int(round(alpha * 255)) if alpha is not None else 255
    value = (a << 24) | (r << 16) | (g << 8) | b
    return value - (1 << 32) if value >= (1 << 31) else value


def _uuid(value) -> str:
    return str(value).lower()


class _Converter:
    def __init__(self, model: rh.File3dm) -> None:
        self.model = model
        self.units, self.scale = _UNITS.get(model.Settings.ModelUnitSystem, ("m", 1.0))
        self.layers = {layer.Index: layer for layer in model.Layers}
        self.layer_by_id = {_uuid(layer.Id): layer for layer in model.Layers}
        self.materials = [model.Materials[i] for i in range(len(model.Materials))]
        self.layer_collections: Dict[int, Collection] = {}
        self.top_collections: List[Collection] = []
        self.material_targets: Dict[Any, Tuple[RenderMaterial, List[str]]] = {}
        self.stats: Counter = Counter()
        self.skipped: Counter = Counter()

    # ── geometry ────────────────────────────────────────────────────────────

    def _xyz(self, p) -> Tuple[float, float, float]:
        s = self.scale
        return (p.X * s, p.Y * s, p.Z * s)

    def _mesh(self, meshes: List[rh.Mesh], app_id: str) -> Optional[Mesh]:
        """One Speckle mesh from one or more Rhino meshes (a Brep's faces)."""
        vertices: List[float] = []
        faces: List[int] = []
        colors: List[int] = []
        all_colored = True
        for mesh in meshes:
            base = len(vertices) // 3
            verts = mesh.Vertices
            for i in range(len(verts)):
                vertices.extend(self._xyz(verts[i]))
            vc = mesh.VertexColors
            if len(vc) == len(verts):
                colors.extend(_argb(vc[i]) for i in range(len(vc)))
            else:
                all_colored = False
            fl = mesh.Faces
            for i in range(fl.Count):
                a, b, c, d = fl[i]
                if c == d:
                    faces.extend((3, base + a, base + b, base + c))
                else:
                    faces.extend((4, base + a, base + b, base + c, base + d))
        if not faces:
            return None
        out = Mesh(vertices=vertices, faces=faces, units=self.units, applicationId=app_id)
        if all_colored and colors:
            out.colors = colors
        return out

    def _brep_meshes(self, brep: rh.Brep) -> Optional[List[rh.Mesh]]:
        meshes = [brep.Faces[i].GetMesh(rh.MeshType.Any) for i in range(len(brep.Faces))]
        found = [m for m in meshes if m is not None]
        return found or None

    def _subd_mesh(self, subd: rh.SubD) -> Optional[rh.Mesh]:
        levels = 0
        faces = max(subd.FaceCount, 1)
        while levels < 3 and faces * 4 <= SUBD_TARGET_FACES:
            faces *= 4
            levels += 1
        refined = subd.Duplicate() if levels else subd
        if levels:
            refined.Subdivide(levels)
        return rh.Mesh.CreateFromSubDControlNet(refined, False)

    def _curve_points(self, curve: rh.Curve) -> List[Tuple[float, float, float]]:
        if isinstance(curve, rh.LineCurve) or curve.IsLinear():
            return [self._xyz(curve.PointAtStart), self._xyz(curve.PointAtEnd)]
        if isinstance(curve, rh.PolylineCurve):
            return [self._xyz(curve.Point(i)) for i in range(curve.PointCount)]
        # Everything else: sampled along its domain, denser for more spans /
        # higher degree
        count = min(max(curve.SpanCount * max(curve.Degree, 1) * 8, 32), 512)
        domain = curve.Domain
        t0, t1 = domain.T0, domain.T1
        points = [self._xyz(curve.PointAt(t0 + (t1 - t0) * i / count)) for i in range(count + 1)]
        return points

    def _displayables(self, geometry, app_id: str) -> Optional[List[Base]]:
        """Speckle display geometry for a Rhino geometry; None if it's a
        type this importer doesn't handle."""
        if isinstance(geometry, rh.Mesh):
            mesh = self._mesh([geometry], f"{app_id}:mesh")
            return [mesh] if mesh else []
        if isinstance(geometry, rh.Brep):
            meshes = self._brep_meshes(geometry)
            if meshes is None:
                self.stats["brepsWithoutRenderMeshes"] += 1
                return []
            mesh = self._mesh(meshes, f"{app_id}:mesh")
            return [mesh] if mesh else []
        if isinstance(geometry, rh.Extrusion):
            cached = geometry.GetMesh(rh.MeshType.Any)
            if cached is None:
                self.stats["brepsWithoutRenderMeshes"] += 1
                return []
            mesh = self._mesh([cached], f"{app_id}:mesh")
            return [mesh] if mesh else []
        if isinstance(geometry, rh.SubD):
            control = self._subd_mesh(geometry)
            mesh = self._mesh([control], f"{app_id}:mesh") if control else None
            return [mesh] if mesh else []
        if isinstance(geometry, rh.Curve):
            points = self._curve_points(geometry)
            value = [c for p in points for c in p]
            return [Polyline(value=value, units=self.units, applicationId=f"{app_id}:curve")]
        if isinstance(geometry, rh.Point):
            x, y, z = self._xyz(geometry.Location)
            return [Point(x=x, y=y, z=z, units=self.units, applicationId=f"{app_id}:point")]
        if isinstance(geometry, rh.PointCloud):
            cloud = Pointcloud(applicationId=f"{app_id}:points")
            cloud["points"] = [c for i in range(geometry.Count) for c in self._xyz(geometry[i].Location)]
            cloud["units"] = self.units
            return [cloud]
        return None

    # ── materials ───────────────────────────────────────────────────────────

    def _layer(self, attributes) -> Optional[rh.Layer]:
        return self.layers.get(attributes.LayerIndex)

    def _material_key(self, attributes) -> Tuple[Any, RenderMaterial]:
        """The object's render material, else its display colour -- what it
        looks like in Rhino's rendered or shaded view respectively."""
        layer = self._layer(attributes)
        index = -1
        if attributes.MaterialSource == rh.ObjectMaterialSource.MaterialFromObject:
            index = attributes.MaterialIndex
        elif layer is not None:
            index = layer.RenderMaterialIndex
        if 0 <= index < len(self.materials):
            material = self.materials[index]
            opacity = 1.0 - float(material.Transparency)
            return ("material", index), RenderMaterial(
                name=material.Name or f"Material {index}",
                diffuse=_argb(material.DiffuseColor, opacity),
                opacity=opacity,
                applicationId=f"material:{index}",
            )
        if attributes.ColorSource == rh.ObjectColorSource.ColorFromObject:
            color = attributes.ObjectColor
        else:
            color = layer.Color if layer is not None else (128, 128, 128, 255)
        rgb = tuple(int(c) for c in color[:3])
        return ("color", rgb), RenderMaterial(
            name=f"Color {rgb[0]},{rgb[1]},{rgb[2]}",
            diffuse=_argb(color),
            applicationId=f"color:{rgb[0]}-{rgb[1]}-{rgb[2]}",
        )

    def _bind_material(self, attributes, displayables: List[Base]) -> None:
        meshes = [d.applicationId for d in displayables if isinstance(d, Mesh) and d.applicationId]
        if not meshes:
            return
        key, material = self._material_key(attributes)
        if key not in self.material_targets:
            self.material_targets[key] = (material, [])
        self.material_targets[key][1].extend(meshes)

    # ── objects ─────────────────────────────────────────────────────────────

    def _properties(self, obj, layer: Optional[rh.Layer]) -> Dict[str, Any]:
        attributes = obj.Attributes
        properties: Dict[str, Any] = {"Type": type(obj.Geometry).__name__}
        if layer is not None:
            properties["Layer"] = layer.FullPath
        user_strings = dict(attributes.GetUserStrings() or [])
        user_strings.update(dict(obj.Geometry.GetUserStrings() or []))
        if user_strings:
            properties["User strings"] = user_strings
        return properties

    def convert_object(self, obj) -> Optional[Base]:
        geometry = obj.Geometry
        attributes = obj.Attributes
        app_id = _uuid(attributes.Id)
        type_name = type(geometry).__name__
        if isinstance(geometry, rh.InstanceReference):
            self.stats["blockInstances"] += 1
            xf = geometry.Xform
            s = self.scale
            transform = [
                xf.M00, xf.M01, xf.M02, xf.M03 * s,
                xf.M10, xf.M11, xf.M12, xf.M13 * s,
                xf.M20, xf.M21, xf.M22, xf.M23 * s,
                xf.M30, xf.M31, xf.M32, xf.M33,
            ]
            definition_id = _uuid(geometry.ParentIdefId)
            proxy = InstanceProxy(
                definitionId=definition_id, transform=transform, maxDepth=0,
                units=self.units, applicationId=app_id,
            )
            proxy["name"] = attributes.Name or "Block"
            proxy["properties"] = self._properties(obj, self._layer(attributes))
            return proxy

        displayables = self._displayables(geometry, app_id)
        if displayables is None:
            self.skipped[type_name] += 1
            return None
        self.stats[type_name] += 1
        self._bind_material(attributes, displayables)
        return DataObject(
            name=attributes.Name or type_name,
            properties=self._properties(obj, self._layer(attributes)),
            displayValue=displayables,
            applicationId=app_id,
        )

    def _layer_collection(self, layer_index: int) -> Collection:
        if layer_index in self.layer_collections:
            return self.layer_collections[layer_index]
        layer = self.layers.get(layer_index)
        if layer is None:
            return self._orphans()
        collection = Collection(name=layer.Name, elements=[], applicationId=_uuid(layer.Id))
        self.layer_collections[layer_index] = collection
        parent = self.layer_by_id.get(_uuid(layer.ParentLayerId))
        if parent is not None:
            self._layer_collection(parent.Index).elements.append(collection)
        else:
            self.top_collections.append(collection)
        return collection

    def _orphans(self) -> Collection:
        if -1 not in self.layer_collections:
            self.layer_collections[-1] = Collection(name="Default", elements=[], applicationId="layer:default")
            self.top_collections.append(self.layer_collections[-1])
        return self.layer_collections[-1]

    def convert(self, name: str) -> Collection:
        # Keep the file's layer order
        for index in sorted(self.layers):
            self._layer_collection(index)

        by_id = {}
        definition_members = []
        for obj in self.model.Objects:
            converted = self.convert_object(obj)
            if converted is None:
                continue
            by_id[converted.applicationId] = converted
            if obj.Attributes.IsInstanceDefinitionObject:
                definition_members.append(converted)
            else:
                self._layer_collection(obj.Attributes.LayerIndex).elements.append(converted)

        definitions = []
        for idef in self.model.InstanceDefinitions:
            members = [_uuid(i) for i in idef.GetObjectIds() if _uuid(i) in by_id]
            if not members:
                continue
            proxy = InstanceDefinitionProxy(
                objects=members, maxDepth=0, name=idef.Name or "Block",
                applicationId=_uuid(idef.Id),
            )
            definitions.append(proxy)
        self._set_depths(definitions, by_id)

        root = Collection(name=name, elements=[c for c in self.top_collections if c.elements])
        if definition_members:
            root.elements.append(
                Collection(name=BLOCK_DEFINITIONS, elements=definition_members, applicationId="block-definitions")
            )
        root["units"] = self.units
        root["instanceDefinitionProxies"] = definitions
        root["renderMaterialProxies"] = [
            RenderMaterialProxy(objects=targets, value=material)
            for material, targets in self.material_targets.values()
        ]
        return root

    @staticmethod
    def _set_depths(definitions, by_id) -> None:
        """maxDepth: how deep a definition's blocks nest (0 = none)."""
        by_def = {d.applicationId: d for d in definitions}
        memo: Dict[str, int] = {}

        def depth(def_id: str, seen: frozenset) -> int:
            if def_id in memo:
                return memo[def_id]
            if def_id in seen or def_id not in by_def:
                return 0
            nested = [
                by_id[m]["definitionId"]
                for m in by_def[def_id]["objects"]
                if by_id[m].speckle_type.endswith("InstanceProxy")
            ]
            memo[def_id] = max((1 + depth(n, seen | {def_id}) for n in nested), default=0)
            return memo[def_id]

        for d in definitions:
            d.maxDepth = depth(d.applicationId, frozenset())


def convert_3dm(file_path: str, display_name: str) -> Collection:
    model = rh.File3dm.Read(file_path)
    if model is None:
        raise ValueError("rhino3dm could not read this file as a .3dm model")
    converter = _Converter(model)
    root = converter.convert(display_name)
    root.elements.append(
        DataObject.of_type(
            "Objects.Data.RhinoFile",
            name=display_name,
            properties={
                "rhinoVersion": model.ArchiveVersion,
                "units": str(model.Settings.ModelUnitSystem),
                "createdBy": model.CreatedBy,
                "lastEditedBy": model.LastEditedBy,
                "objects": dict(converter.stats),
                "skippedTypes": dict(converter.skipped),
                "brepsWithoutRenderMeshes": converter.stats.get("brepsWithoutRenderMeshes", 0),
                "rhino3dmVersion": rh.__version__,
            },
            displayValue=[],
        )
    )
    LOG.info("Converted 3DM: %s | skipped %s", dict(converter.stats), dict(converter.skipped))
    return root


def _display_name(commit_message: str, file_path: str) -> str:
    # The upload sits in a temp file named "file"; the daemon's commit
    # message carries the real name ("File upload: Chair.3dm")
    prefix = "File upload: "
    if commit_message and commit_message.startswith(prefix):
        return commit_message[len(prefix):]
    return Path(file_path).name


def import_3dm(
    file_path: str,
    project_id: str,
    model_id: Optional[str],
    branch_name: str,
    commit_message: str,
) -> Version:
    root = convert_3dm(file_path, _display_name(commit_message, file_path))

    client = SpeckleClient(host=os.getenv("SPECKLE_SERVER_URL", "127.0.0.1:3000"), use_ssl=False)
    token = os.environ.get("USER_TOKEN")
    if not token:
        raise Exception('Expected an env var "USER_TOKEN"')
    client.authenticate_with_token(token)

    if model_id:
        model = client.model.get(model_id, project_id)
    else:
        model = client.model.create(
            CreateModelInput(
                name=branch_name,
                description="File upload branch" if branch_name == "uploads" else "",
                project_id=project_id,
            )
        )

    transport = ServerTransport(client=client, stream_id=project_id)
    object_id = operations.send(base=root, transports=[transport], use_default_cache=False)
    return client.version.create(
        CreateVersionInput(
            object_id=object_id,
            model_id=model.id,
            project_id=project_id,
            message=(commit_message or "3DM file upload"),
            source_application="Rhino",
        )
    )


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
        LOG.info("Import3DM argv[1:]:%s", sys.argv[1:])
        version = import_3dm(file_path, project_id, model_id, branch_name, commit_message)
        results: Dict[str, Any] = {"success": True, "commitId": version.id}
    except Exception as ex:
        LOG.exception(ex)
        results = {"success": False, "error": str(ex)}

    Path(tmp_results_path).write_text(json.dumps(results))
