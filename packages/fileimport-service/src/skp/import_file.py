"""
SketchUp (.skp) importer, built on OpenSKP (github.com/iamahsanmehmood/openskp,
MIT): a clean-room .skp reader, no SketchUp or Trimble SDK involved.

Straight to Speckle objects, no IFC in between -- SketchUp models are plain
geometry, and going through IFC would only flatten the component instancing
and turn every loose edge into its own object. The result follows the
layout Speckle's own SketchUp connector sends:

  - root Collection (the file) > one Collection per tag
  - each placed component / group: an InstanceProxy, its definition meshed
    ONCE (one Mesh per material) and listed in root.instanceDefinitionProxies
  - loose faces at the model root: Meshes; loose edges: Polylines
  - materials: root.renderMaterialProxies
  - dynamic component / attribute dictionaries: the instance's properties

OpenSKP hands everything over in metres, glTF Y-up; Speckle is Z-up, so
points go (x, y, z) -> (x, -z, y) and placement matrices get the same axis
change.
"""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import structlog
from logging import INFO, WARNING, basicConfig, getLogger
from openskp import SkpFile
from specklepy.api import operations
from specklepy.api.client import SpeckleClient
from specklepy.core.api.inputs import CreateModelInput, CreateVersionInput
from specklepy.core.api.models import Version
from specklepy.objects.base import Base
from specklepy.objects.data_objects import DataObject
from specklepy.objects.geometry import Mesh, Polyline
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

UNITS = "m"
UNTAGGED = "Untagged"


# ── coordinates ─────────────────────────────────────────────────────────────


def _point(x: float, y: float, z: float) -> Tuple[float, float, float]:
    """glTF Y-up -> Speckle Z-up."""
    return (x, -z, y)


def _points(flat) -> List[float]:
    out: List[float] = []
    for i in range(0, len(flat), 3):
        out.extend(_point(flat[i], flat[i + 1], flat[i + 2]))
    return out


def _transform(gltf: Tuple[float, ...]) -> List[float]:
    """A column-major glTF (Y-up) matrix as Speckle's row-major Z-up one:
    C . M . C^-1, C the (x, y, z) -> (x, -z, y) axis change."""
    m = [[gltf[c * 4 + r] for c in range(4)] for r in range(4)]  # row-major
    c = [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]]
    c_inv = [[c[j][i] for j in range(4)] for i in range(4)]  # orthonormal: C^T

    def mul(a, b):
        return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]

    t = mul(mul(c, m), c_inv)
    return [float(v) for row in t for v in row]


# ── materials ───────────────────────────────────────────────────────────────


def _argb(rgba) -> int:
    r, g, b = (max(0, min(255, round(v * 255))) for v in rgba[:3])
    a = max(0, min(255, round((rgba[3] if len(rgba) > 3 else 1.0) * 255)))
    # Speckle stores a signed 32-bit ARGB int
    value = (a << 24) | (r << 16) | (g << 8) | b
    return value - (1 << 32) if value >= (1 << 31) else value


def _render_material(index: int, gltf_material: Dict[str, Any]) -> RenderMaterial:
    pbr = gltf_material.get("pbrMetallicRoughness", {})
    rgba = pbr.get("baseColorFactor", [0.8, 0.8, 0.8, 1.0])
    return RenderMaterial(
        name=gltf_material.get("name") or f"Material {index + 1}",
        diffuse=_argb(rgba),
        opacity=float(rgba[3]) if len(rgba) > 3 else 1.0,
        metalness=float(pbr.get("metallicFactor", 0.0)),
        roughness=float(pbr.get("roughnessFactor", 1.0)),
        applicationId=f"material:{index}",
    )


# ── conversion ──────────────────────────────────────────────────────────────


class _Converter:
    def __init__(self, scene) -> None:
        self.scene = scene
        self.mesh_resources = {r.id: r for r in scene.mesh_resources}
        self.curve_resources = {r.id: r for r in scene.curve_resources}
        self.materials = [_render_material(i, m) for i, m in enumerate(scene.gltf_materials)]
        self.material_objects: Dict[int, List[str]] = {}
        # Every mesh / polyline / nested instance a definition refers to has
        # to be somewhere in the tree for the viewer to find it by
        # applicationId; they live here, not under a tag
        self.definition_members: List[Base] = []
        self.meshes_by_resource: Dict[str, List[str]] = {}
        self.curves_by_resource: Dict[str, List[str]] = {}
        self.definitions: Dict[Any, InstanceDefinitionProxy] = {}
        self.instance_count = 0

    def mesh_ids(self, resource_id: Optional[str]) -> List[str]:
        """One Mesh per material of a mesh resource, made once."""
        if not resource_id or resource_id not in self.mesh_resources:
            return []
        if resource_id not in self.meshes_by_resource:
            ids = []
            for i, prim in enumerate(self.mesh_resources[resource_id].primitives):
                app_id = f"mesh:{resource_id}:{i}"
                faces: List[int] = []
                idx = prim.indices
                for t in range(0, len(idx), 3):
                    faces.extend((3, idx[t], idx[t + 1], idx[t + 2]))
                mesh = Mesh(vertices=_points(prim.positions), faces=faces, units=UNITS, applicationId=app_id)
                if len(prim.normals) == len(prim.positions):
                    mesh.vertexNormals = _points(prim.normals)
                self.definition_members.append(mesh)
                self.material_objects.setdefault(prim.material_index, []).append(app_id)
                ids.append(app_id)
            self.meshes_by_resource[resource_id] = ids
        return self.meshes_by_resource[resource_id]

    def curve_ids(self, resource_id: Optional[str]) -> List[str]:
        if not resource_id or resource_id not in self.curve_resources:
            return []
        if resource_id not in self.curves_by_resource:
            ids = []
            for i, curve in enumerate(self.curve_resources[resource_id].curves):
                if len(curve.points_m) < 2:
                    continue
                app_id = f"curve:{resource_id}:{i}"
                value = [c for p in curve.points_m for c in _point(*p)]
                if curve.closed:
                    value.extend(value[:3])
                self.definition_members.append(Polyline(value=value, units=UNITS, applicationId=app_id))
                ids.append(app_id)
            self.curves_by_resource[resource_id] = ids
        return self.curves_by_resource[resource_id]

    def definition(self, node, depth: int) -> Optional[str]:
        """The definition proxy a placed node refers to, shared by every
        placement with the same geometry and the same nested placements."""
        children = [(self.definition(c, depth + 1), c) for c in node.children]
        key = (
            node.mesh_resource_id,
            node.curve_resource_id,
            tuple((d, tuple(round(v, 9) for v in c.matrix)) for d, c in children if d),
        )
        if key in self.definitions:
            return self.definitions[key]["applicationId"]
        members = self.mesh_ids(node.mesh_resource_id) + self.curve_ids(node.curve_resource_id)
        for definition_id, child in children:
            if definition_id:
                instance = self.instance(child, definition_id, depth + 1)
                self.definition_members.append(instance)
                members.append(instance["applicationId"])
        if not members:
            return None
        proxy = InstanceDefinitionProxy(
            objects=members,
            maxDepth=depth,
            name=node.definition_name or node.name or "Component",
            applicationId=f"definition:{len(self.definitions)}",
        )
        self.definitions[key] = proxy
        return proxy["applicationId"]

    def instance(self, node, definition_id: str, depth: int) -> InstanceProxy:
        self.instance_count += 1
        # Not node.guid: a nested component recurs in every variant of its
        # parent's definition, and applicationIds must stay unique
        proxy = InstanceProxy(
            definitionId=definition_id,
            transform=_transform(node.matrix),
            maxDepth=depth,
            units=UNITS,
            applicationId=f"instance:{self.instance_count}",
        )
        proxy["name"] = node.name or node.definition_name or "Component"
        properties: Dict[str, Any] = {}
        if node.definition_name:
            properties["Definition"] = node.definition_name
        if node.layer:
            properties["Tag"] = node.layer
        if node.guid:
            properties["SketchUp GUID"] = node.guid
        properties.update(node.properties or {})
        if node.attribute_dictionaries:
            properties["Attributes"] = node.attribute_dictionaries
        proxy["properties"] = properties
        return proxy

    def convert(self, name: str) -> Collection:
        root_node = self.scene.scene_hierarchy
        tags: Dict[str, Collection] = {}

        def tag(layer: str) -> Collection:
            label = layer or UNTAGGED
            if label not in tags:
                tags[label] = Collection(name=label, elements=[], applicationId=f"tag:{label}")
            return tags[label]

        # Loose geometry at the model root, placed as is
        loose_meshes = self.mesh_ids(root_node.mesh_resource_id)
        loose_curves = self.curve_ids(root_node.curve_resource_id)
        loose = set(loose_meshes + loose_curves)
        for obj in [m for m in self.definition_members if m.applicationId in loose]:
            tag(root_node.layer).elements.append(obj)
        self.definition_members = [m for m in self.definition_members if m.applicationId not in loose]

        for child in root_node.children:
            definition_id = self.definition(child, 1)
            if definition_id:
                tag(child.layer).elements.append(self.instance(child, definition_id, 0))

        root = Collection(name=name, elements=list(tags.values()))
        if self.definition_members:
            root.elements.append(
                Collection(name="Component definitions", elements=self.definition_members,
                           applicationId="component-definitions")
            )
        root["units"] = UNITS
        root["instanceDefinitionProxies"] = list(self.definitions.values())
        root["renderMaterialProxies"] = [
            RenderMaterialProxy(objects=ids, value=self.materials[i])
            for i, ids in sorted(self.material_objects.items())
            if 0 <= i < len(self.materials)
        ]
        return root


def convert_skp(file_path: str, display_name: str) -> Collection:
    # OpenSKP insists on a .skp extension, and the upload sits in a temp file
    # named just "file": hand it a .skp-named hard link (a copy where links
    # fail). Not a symlink -- OpenSKP resolves those back to "file".
    with tempfile.TemporaryDirectory() as tmp:
        if not file_path.lower().endswith(".skp"):
            linked = os.path.join(tmp, "upload.skp")
            try:
                os.link(file_path, linked)
            except OSError:
                shutil.copyfile(file_path, linked)
            file_path = linked
        return _convert(file_path, display_name)


def _convert(file_path: str, display_name: str) -> Collection:
    skp = SkpFile.open(file_path)
    model = skp.parse()
    scene = skp.build_instanced_scene()
    converter = _Converter(scene)
    root = converter.convert(display_name)
    root.elements.append(
        DataObject.of_type(
            "Objects.Data.SketchUpFile",
            name=display_name,
            properties={
                "version": str(model.version),
                "definitions": len(model.definitions),
                "placedComponents": converter.instance_count,
                "materials": len(model.materials),
                "tags": [layer.name for layer in model.layers],
                "openskpVersion": getattr(sys.modules["openskp"], "__version__", None),
            },
            displayValue=[],
        )
    )
    LOG.info(
        "Converted SKP: %s definitions, %s placements, %s materials",
        len(converter.definitions), converter.instance_count, len(converter.materials),
    )
    return root


def _display_name(commit_message: str, file_path: str) -> str:
    # The upload sits in a temp file named "file"; the daemon's commit
    # message carries the real name ("File upload: Tower.skp")
    prefix = "File upload: "
    if commit_message and commit_message.startswith(prefix):
        return commit_message[len(prefix):]
    return Path(file_path).name


def import_skp(
    file_path: str,
    project_id: str,
    model_id: Optional[str],
    branch_name: str,
    commit_message: str,
) -> Version:
    root = convert_skp(file_path, _display_name(commit_message, file_path))

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
            message=(commit_message or "SKP file upload"),
            source_application="SketchUp",
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
        LOG.info("ImportSKP argv[1:]:%s", sys.argv[1:])
        version = import_skp(file_path, project_id, model_id, branch_name, commit_message)
        results: Dict[str, Any] = {"success": True, "commitId": version.id}
    except Exception as ex:
        LOG.exception(ex)
        results = {"success": False, "error": str(ex)}

    Path(tmp_results_path).write_text(json.dumps(results))
