# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
DeploymentStore — persistence layer for deployment control records.

Stores each deployment as a JSON file at:
    users/<client_id>/deployments/<deployment_id>.json

Uses IStore directly (not FileStore) because deployments are small structured
JSON, not user-uploaded binary data.
"""

from rocketlib import debug

from .models import DeploymentRecord
from .store import IStore, StorageError


class DeploymentStore:
    """Read/write DeploymentRecord objects via an IStore backend."""

    def __init__(self, store: IStore, client_id: str) -> None:
        if not client_id:
            raise ValueError('client_id is required')
        self._store = store
        self._client_id = client_id

    # =========================================================================
    # Public API
    # =========================================================================

    async def save(self, record: DeploymentRecord) -> None:
        """Persist a deployment record, creating or overwriting the file."""
        await self._store.write_file(self._path(record.deployment_id), record.model_dump_json())

    async def get(self, deployment_id: str) -> DeploymentRecord:
        """
        Return the deployment record for deployment_id.

        Raises:
            StorageError: If the deployment does not exist.
        """
        data = await self._store.read_file(self._path(deployment_id))
        return DeploymentRecord.model_validate_json(data)

    async def delete(self, deployment_id: str) -> None:
        """
        Remove the deployment record for deployment_id.

        Raises:
            StorageError: If the deployment does not exist.
        """
        await self._store.delete_file(self._path(deployment_id))

    async def list(self) -> list[DeploymentRecord]:
        """Return all deployment records for this account, in no particular order."""
        paths = await self._store.list_files(self._prefix())
        records = []
        for path in paths:
            try:
                data = await self._store.read_file(path)
                records.append(DeploymentRecord.model_validate_json(data))
            except (StorageError, Exception) as e:
                debug(f'DeploymentStore.list: skipping {path}: {e}')
        return records

    @staticmethod
    async def iter_all(store: IStore):
        """Async-generate every DeploymentRecord found across all users in store."""
        paths = await store.list_files('users/')
        for path in paths:
            if '/deployments/' not in path:
                continue
            try:
                data = await store.read_file(path)
                yield DeploymentRecord.model_validate_json(data)
            except Exception as e:
                debug(f'DeploymentStore.iter_all: skipping {path}: {e}')

    # =========================================================================
    # Private helpers
    # =========================================================================

    def _path(self, deployment_id: str) -> str:
        return f'users/{self._client_id}/deployments/{deployment_id}.json'

    def _prefix(self) -> str:
        return f'users/{self._client_id}/deployments/'


__all__ = ['DeploymentStore']
