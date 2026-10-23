# File Import Service

## Description of how this works

A micro-service which polls a Postgres database table `file_uploads` for new records and processes them.

It retrieves a referenced file from an S3 bucket and stores it in a local directory for parsing.

It hands the file to the importer for its type (see [Importers](#importers)). The importers are separate programs, written in Python, .NET or Node.js, and are run as shell commands.

The parsers are responsible for extracting the necessary data from the files and storing it in the database. They are also responsible for creating a new Speckle model if necessary.

The service is then responsible for updating the status of the `file_uploads` table, and for posting a Postgres notification.

## Importers

Each upload is handed to one importer, chosen by its file extension in `src/controller/daemon.ts`. An importer is a separate program: it converts the file to Speckle objects, sends them to the server and creates the model version.

| File type | Importer | Reads the file with | What you get |
| --- | --- | --- | --- |
| IFC `.ifc` | `src/ifc-python/import_file.py` | `speckleifc`, Speckle's IFC converter (part of `specklepy`), built on IfcOpenShell | The spatial structure as the model tree, element properties, levels, and repeated geometry stored once as instances. [Details](#ifc-importer) |
| Zipped IFC `.ifczip` | `src/ifczip/import_file.py` | the IFC importer, after unpacking | The same result as the `.ifc` inside. [Details](#ifczip-importer) |
| Revit `.rvt` (experimental) | `src/rvt/import_file.py` | [rvt-rs](https://github.com/DrunkOnJava/rvt-rs), no Revit needed | Geometry, materials, property sets and storeys for project files the reader can decode; file metadata only for the rest. [Details](#rvt-importer-experimental) |
| SketchUp `.skp` | `src/skp/import_file.py` | [OpenSKP](https://github.com/iamahsanmehmood/openskp) | A collection per tag, components as instances, materials. [Details](#skp-importer) |
| Rhino `.3dm` | `src/rhino/import_file.py` | [rhino3dm](https://github.com/mcneel/rhino3dm) | Layers as collections, blocks as instances, meshes, curves and points; Breps as the render meshes saved in the file. [Details](#rhino-3dm-importer) |
| STL `.stl` | `src/stl/import_file.py` | numpy-stl | One mesh. |
| OBJ `.obj` | `src/obj/import_file.py` | the parser in `src/obj/obj_file.py` | Meshes with the materials of the `.mtl` files. |

Two older IFC importers are still in the image and are used only when the file name asks for them: `*.legacyimporter.ifc` goes to the Node.js parser in `src/ifc`, `*.dotnetimporter.ifc` to the .NET parser in `src/ifc-dotnet`.

### RVT importer (experimental)

`src/rvt/import_file.py` reads `.rvt` files with the clean-room `rvt` package ([rvt-rs](https://github.com/DrunkOnJava/rvt-rs), Apache-2.0), so no Revit install or license is involved.

- **Revit 2024 and 2025 project files get geometry.** `rvt` decodes their element records into an IFC4 model (typed walls, slabs, roofs, columns, beams, stairs, curtain walls, doors, windows, MEP, furniture and more, with bodies, materials, property sets and storeys), which the importer hands to `speckleifc`, the same importer `.ifc` uploads use. The Revit file's own metadata is added to the model as an `Objects.Data.RevitFile` object. Doors, windows and most furniture/equipment are boxes; walls, slabs and columns follow Revit's shapes closely (see rvt-rs's README for its per-category accuracy against Revit's own IFC export).
- **Steel members get their real cross-sections.** `rvt` doesn't read Revit's family parameters yet, so it draws every beam and column as a box. `src/rvt/steel_profiles.py` reads the standard designation from the type name (W18x55, HE 120 B, IPE 300, HSS6x6x5/8, SHS100x8, L4x4x1/2, …) and swaps the box for the real I/H, channel, tee, hollow, pipe or angle section — dimensions from `src/rvt/steel/sections.json` (AISC + EN tables, see its `THIRD_PARTY_NOTICES.md`) or from the name itself. Bar joists (K/LH series) become chords with a zigzag web. A section only replaces a box it fits, so an unknown or inconsistent name keeps its box. The counts per outcome are on the model's `Objects.Data.RevitFile` object (`steelSections`).
- **Doors and windows cut their walls.** `rvt` writes an opening only for a door/window whose record names its host wall; `src/rvt/wall_openings.py` finds the wall of the others geometrically (clear overlap with exactly one wall, within its height, lined up with it) and adds the same kind of opening (the door/window box, slightly deeper across the wall), so the wall gets its hole. Counts on the `Objects.Data.RevitFile` object (`addedOpenings`). Separate Revit opening elements (shaft openings, floor/roof openings by face) aren't decoded by `rvt` yet, so those holes are missing; holes sketched into a floor's own outline do show.
- **Anything else** (older Revit releases, families, files it can't decode elements from) falls back to a metadata-only import: parser metadata, stream/schema summaries, document walker output and an IFC preview.

`rvt` is built from a pinned rvt-rs commit in the Dockerfile (`rvt-build-stage`, `RVT_RS_REVISION`), not installed from PyPI: our patches are in no release (the latest is 0.6.1), and rvt-rs `main` moves well ahead of its releases. Once a release includes what they do, drop that stage and pin `rvt` in `requirements.txt` again. Our own patches on top of that commit live in `src/rvt/rvt-rs-patches/` (currently: beams along their location line and floor/roof outlines for Revit 2025 files too, saved display meshes from Python, rectangular wall openings); `git apply` fails the build if one stops applying after a bump.

### SKP importer

`src/skp/import_file.py` reads SketchUp `.skp` files with [OpenSKP](https://github.com/iamahsanmehmood/openskp) (MIT, clean-room, no SketchUp or Trimble SDK), straight into Speckle objects — no IFC in between, which would only flatten the component instancing and turn every loose edge into its own object. The layout follows Speckle's own SketchUp connector: a collection per tag, each placed component/group an `InstanceProxy` whose definition is meshed once (one mesh per material) and listed in `instanceDefinitionProxies`, materials in `renderMaterialProxies`, loose edges as polylines, attribute dictionaries (dynamic components) as instance properties. OpenSKP reads SketchUp 2013–2018, 2020, 2021 and 2025 files; V3/V4/V6 and 2019 files currently fail to parse (OpenSKP issue #284).

### Rhino (3DM) importer

`src/rhino/import_file.py` reads Rhino `.3dm` files with McNeel's own [rhino3dm](https://github.com/mcneel/rhino3dm) (MIT, openNURBS; no Rhino install or license) straight into Speckle objects, laid out like Speckle's own Rhino connector: nested collections for the layer tree, each object a `DataObject` (its name, layer, user strings) whose `displayValue` is its geometry, blocks as `InstanceProxy`s with `instanceDefinitionProxies`, materials — or the display colour where there is none — in `renderMaterialProxies`, in the file's own units.

- Meshes, curves (sampled to polylines), points and point clouds convert directly; SubDs are meshed from their subdivided control net.
- **Breps and extrusions show the render meshes Rhino cached in the file.** rhino3dm can't mesh NURBS itself (McNeel confirmed no standalone mesher is planned, rhino3dm#743). Files saved normally from Rhino with a shaded view carry those meshes; a "Save Small" file, or one written by another program, doesn't — such objects are kept with their properties but without geometry, and counted on the `Objects.Data.RhinoFile` object (`brepsWithoutRenderMeshes`). Meshing them ourselves (NURBS + trims → OpenCASCADE) is the planned next step.
- Text, dots, lights, hatches, dimensions and other annotations are skipped (counted in `skippedTypes`).

Point clouds use `Objects.Geometry.Pointcloud` with a flat `points` list, what the viewer draws — specklepy 3's own `PointCloud` holds `Point` objects under a type name the viewer doesn't know.

### IFC importer

`src/ifc-python/import_file.py` converts `.ifc` files with `speckleifc`, Speckle's IFC converter built on IfcOpenShell. It ships inside `specklepy` (pinned in `requirements.txt`), so updating specklepy updates the converter.

speckleifc's own entry point (`python -m speckleifc`) reports through the server's model ingestion API, which the open-source server doesn't have. The script does the same without it: convert, send the objects, create the version. The Revit and IFCZIP importers go through the same converter.

### IFCZIP importer

`src/ifczip/import_file.py` unpacks the `.ifc` inside an `.ifczip` (the largest one if there are several, ignoring `__MACOSX` entries) and runs the IFC importer on it, so the result is identical to uploading the plain `.ifc`.

## Dev setup

### Building/Running the .NET importer

Requirements:

- Ubuntu 24+

Do this on Ubuntu/OSX to install dotnet:

```bash
# Add microsoft package repo
sudo apt update && sudo apt install -y wget apt-transport-https
wget https://packages.microsoft.com/config/ubuntu/$(lsb_release -rs)/packages-microsoft-prod.deb -O packages-microsoft-prod.deb
sudo dpkg -i packages-microsoft-prod.deb

# Install dotnet sdk 8
sudo apt update
sudo apt install -y dotnet-sdk-8.0

# Verify version
dotnet --version
```

Do this to build:

```bash
cd ./packages/fileimport-service/src/ifc-dotnet

dotnet publish ifc-converter.csproj -c Release -o output/
```
