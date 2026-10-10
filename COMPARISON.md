# Speckle Server and xspeckle-server compared

xspeckle-server is a fork of [Speckle Server](https://github.com/specklesystems/speckle-server). This page lists what a deployment of the fork does differently from a deployment of the original, so you can decide which one fits and know what to expect when moving between them.

"Original" here means the open-source Speckle Server at commit [`51d43b91c`](https://github.com/specklesystems/speckle-server/commit/51d43b91c) (15 June 2026), which is the commit the fork is built on. It does not describe Speckle's hosted service.

## At a glance

| | Original Speckle Server | xspeckle-server |
| --- | --- | --- |
| File types you can upload | IFC; OBJ and STL on the legacy import path | IFC, IFCZIP, Revit, SketchUp, Rhino, OBJ, STL |
| IFC converter | `speckleifc` from 2025 | `speckleifc` as shipped in specklepy 2026.8.1 |
| Issues in the viewer | comment threads with replies | BCF 3.0 topics, comments and viewpoints |
| BCF files (`.bcf`, `.bcfzip`) | not supported | import and export |
| Comments part of the GraphQL API | `commentThreads`, `commentMutations` | replaced by `topics`, `topicMutations` |
| Everything else in the API | | unchanged |
| Database | | six additional migrations, one of which drops a column |
| Maintained and supported by | Speckle | bau-tech, independently; no support from Speckle |

## File uploads

| File type | Original, default setup | Original, legacy import path | xspeckle-server |
| --- | --- | --- | --- |
| IFC `.ifc` | yes | yes | yes |
| Zipped IFC `.ifczip` | no | no | yes |
| Revit `.rvt` | no | no | yes, experimental |
| SketchUp `.skp` | no | no | yes |
| Rhino `.3dm` | no | no | yes |
| OBJ `.obj` | no | yes | yes |
| STL `.stl` | no | yes | yes |

- The original's Docker Compose files switch on its newer import path ("next-gen file importer"), which takes IFC only and runs it in `ifc-import-service`. Its older path, in `fileimport-service`, also takes OBJ and STL.
- xspeckle-server runs all uploads through `fileimport-service`, so it needs the next-gen importer switched off and legacy imports switched on. `docker-compose.yml` sets those flags. With the next-gen importer switched on, the fork behaves like the original and the added file types are not offered.
- The original also has a switch for a Rhino-based importer covering further 3D formats. The service that does that work is not in the open-source repository, so it is left out of the table.
- The Revit importer is experimental: files the reader cannot decode are imported with their metadata only, without geometry.

What each importer reads and produces is listed in [`packages/fileimport-service/README.md`](packages/fileimport-service/README.md#importers).

### The same IFC file gives a different model

| | Original | xspeckle-server |
| --- | --- | --- |
| Converter | `speckleifc` 0.2.2 with specklepy 3.0.1 (legacy path), or specklepy 3.0.9 (`ifc-import-service`) | `speckleifc` from specklepy 2026.8.1 |
| IfcOpenShell | 0.8.3 | 0.8.5 |
| Repeated geometry | every object carries its own meshes | stored once and placed as instances |
| Levels | not written | written, one entry per building storey |

Measured on the widely used Duplex sample model (`Duplex_A_20110907.ifc`), original legacy path against xspeckle-server: 298 meshes and 7.0 MB of object data become 241 meshes placed by 298 instances and 4.4 MB, with 4 levels added. The original's `ifc-import-service` was not measured.

A client that reads meshes straight from each object has to resolve instances to draw a model imported by xspeckle-server. The viewer in this repository does.

## Issues: comment threads become BCF topics

| | Original | xspeckle-server |
| --- | --- | --- |
| What an issue is | a comment thread: text, replies, attachments, a saved view | a BCF topic with comments and viewpoints |
| Fields | text | title, description, type, status, priority, stage, labels, due date, assignee, related topics, document references |
| Views | one saved viewer state per comment | any number of viewpoints per topic, each with a snapshot, stored in BCF form |
| Identity | Speckle ids | Speckle ids plus a BCF GUID on every topic, comment and viewpoint |
| Closing an issue | archive the thread | set its status; topics can also be deleted. Archiving is removed |
| Who may edit | the author | the author, and any member of the project |
| Notifications | when you are mentioned in a comment | also an in-app notification when a topic is assigned to you |
| Webhooks | `comment_created`, `comment_replied`, `comment_archived` | also `comment_updated` and `comment_deleted`; nothing is archived any more |
| BCF files | not supported | import of BCF 2.0, 2.1 and 3.0; export as 2.1 or 3.0, from the viewer's topic panel |
| Sync with a BCF server | not possible | possible from the other side: GUIDs are stable and every change raises a webhook |

Importing a BCF file again updates the topics it already brought in, matched by GUID, instead of creating duplicates.

## API compatibility

- **Changed: comments.** The GraphQL types and fields for comments are replaced. `Project.commentThreads` is now `Project.topics`, `commentMutations` is now `topicMutations`, replies are a topic's `comments`, and the archive operations are gone. A client written against the original's comments API, such as a connector feature that lists or creates comments, does not work against xspeckle-server without changes.
- **Changed: saved viewer state.** Its version goes from 1.8 to 1.9; camera direction, up vector, field of view and BCF-specific view settings are added. States saved by the original still load.
- **Added.** User notifications for topic assignment, the two webhook triggers above, and two REST routes: `/api/projects/:projectId/bcf/export` and `/api/projects/:projectId/bcf/import`.
- **Unchanged.** Projects, models, versions, object upload and download, file upload, authentication, permissions outside comments, and the viewer packages' public interfaces. Sending and receiving models from Speckle connectors is not affected.

## Database

xspeckle-server adds six migrations to the comments module. They add the BCF fields, tables for related topics, document references and viewpoints, and a GUID on every topic and comment, and one of them drops the `archived` column from `comments`.

- **Original to xspeckle-server:** start xspeckle-server on the existing database and the migrations run. Threads that were archived lose that mark.
- **xspeckle-server back to the original:** each migration has a rollback, but rolling back discards the BCF data. Treat the move as one-way unless you have a backup from before it.

## Deployment

| | Original | xspeckle-server |
| --- | --- | --- |
| Docker images | published by Speckle | none published; `./install.sh` builds them on your machine |
| Installing | follow Speckle's deployment documentation | `./install.sh` writes the settings, builds, starts and waits until the server answers |
| Compose files | `docker-compose-deps.yml`, `docker-compose-speckle.yml` | the same two, plus `docker-compose.yml` as an override for a single host |
| Import service | `ifc-import-service` | `fileimport-service` |
| Building the import image | | takes longer: the Revit reader is compiled from source |
| Object storage image | `minio/minio` from Docker Hub, which can no longer be pulled | `cgr.dev/chainguard/minio`, or the one named in `MINIO_IMAGE` |
| Ports open on the host | web, plus database, cache and storage on `127.0.0.1` | web only |

The override reads its secrets and host-specific values from an `.env` file next to it, which the install script writes. See [Run it](README.md#run-it).

## What is the same

Everything not listed above: the server's project, model and version handling, object storage, authentication, the frontend outside comments and the upload dialog, the viewer, the preview and webhook services, and the licence terms (see [`LICENSE`](LICENSE)).

## What to keep in mind

- xspeckle-server follows the original only as far as the commit named at the top. Later changes in the original are not included until they are merged.
- Speckle does not test or support this fork. Problems with it belong in this repository's issues, not Speckle's.
- The Revit, SketchUp and Rhino importers read those formats with independent open-source libraries, not with the vendors' software, and do not cover everything those files can contain.
