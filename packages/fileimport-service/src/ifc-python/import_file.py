"""
.ifc importer: converts the file with Speckle's IFC converter (speckleifc, which
ships inside specklepy) and commits the result as a version.

speckleifc's own entry point (`python -m speckleifc`) reports through the
server's model ingestion API, which this server doesn't have. This is the same
flow without it: convert, send, create the version.
"""
import json
import sys
import time
import traceback
from os import getenv
from time import monotonic

from speckleifc.ifc_geometry_processing import open_ifc
from speckleifc.importer import ImportJob
from specklepy.core.api.client import SpeckleClient
from specklepy.core.api.inputs.version_inputs import CreateVersionInput
from specklepy.core.api.operations import send
from specklepy.transports.server import ServerTransport

PROGRESS_INTERVAL_SECONDS = 10


class LogProgress:
    """What ImportJob needs of specklepy's IngestionProgressManager, printing
    the progress instead of sending it to the server."""

    def __init__(self, update_interval_seconds: float = PROGRESS_INTERVAL_SECONDS):
        self.update_interval = update_interval_seconds
        self._last_updated_at = monotonic()

    def report(self, progress_message: str, progress: float | None) -> None:
        self._last_updated_at = monotonic()
        formatted_progress = f" {progress:.0%}" if progress else ""
        print(f"{progress_message}{formatted_progress}")

    def should_report_progress(self) -> bool:
        return monotonic() - self._last_updated_at >= self.update_interval


def open_and_convert_file(
    file_path: str,
    project_id: str,
    version_message: str | None,
    model_id: str,
    client: SpeckleClient,
) -> str:
    start = time.time()
    very_start = start

    ifc_file = open_ifc(file_path)
    data = ImportJob(ifc_file, LogProgress()).convert()  # type: ignore[arg-type]

    print(f"File conversion complete after {(time.time() - start) * 1000}ms")

    start = time.time()
    remote_transport = ServerTransport(project_id, account=client.account)
    root_id = send(data, transports=[remote_transport], use_default_cache=False)
    print(f"Sending to speckle complete after: {(time.time() - start) * 1000}ms")

    start = time.time()
    version = client.version.create(
        CreateVersionInput(
            object_id=root_id,
            model_id=model_id,
            project_id=project_id,
            message=version_message,
            source_application="IFC",
        )
    )
    end = time.time()
    print(f"Version committed after: {(end - start) * 1000}ms")
    print(f"Total time (to commit): {(end - very_start) * 1000}ms")
    del ifc_file

    return version.id


def main() -> None:
    file_path, output_path, project_id, version_message, model_id = sys.argv[1:6]

    token = getenv("USER_TOKEN")
    assert token is not None
    server_url = getenv("SPECKLE_SERVER_URL") or "http://127.0.0.1:3000"

    try:
        client = SpeckleClient(server_url, use_ssl=not server_url.startswith("http://"))
        client.authenticate_with_token(token)
        version_id = open_and_convert_file(
            file_path, project_id, version_message, model_id, client
        )
        with open(output_path, "w") as f:
            json.dump({"success": True, "commitId": version_id}, f)
    except Exception as e:
        print(f"IFC Importer failed with exception:\n{traceback.format_exc()}")
        with open(output_path, "w") as f:
            json.dump({"success": False, "error": str(e)}, f)


if __name__ == "__main__":
    start = time.time()
    main()
    print(f"Total time (including cleanup): {(time.time() - start) * 1000}ms")
