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

import pytest
import shutil
import tempfile

from ai.account.deployment_store import DeploymentStore
from ai.account.models import DeploymentRecord
from ai.account.store import StorageError
from ai.account.store_providers.filesystem import FilesystemStore


@pytest.fixture
def istore():
    temp_path = tempfile.mkdtemp()
    yield FilesystemStore(f'filesystem://{temp_path}')
    shutil.rmtree(temp_path, ignore_errors=True)


@pytest.fixture
def store(istore):
    return DeploymentStore(istore, 'user-1')


@pytest.fixture
def store2(istore):
    """Second client on the same backend — for isolation tests."""
    return DeploymentStore(istore, 'user-2')


def make_record(deployment_id: str = 'dep-1', **kwargs) -> DeploymentRecord:
    return DeploymentRecord(deployment_id=deployment_id, pipeline={}, created_by='user-1', **kwargs)


class TestDeploymentStore:
    @pytest.mark.asyncio
    async def test_save_and_get(self, store):
        record = make_record(name='my pipeline', schedule='0 * * * *')
        await store.save(record)
        result = await store.get('dep-1')
        assert result.deployment_id == 'dep-1'
        assert result.name == 'my pipeline'
        assert result.schedule == '0 * * * *'
        assert result.created_by == 'user-1'

    @pytest.mark.asyncio
    async def test_save_overwrites(self, store):
        await store.save(make_record(name='original'))
        await store.save(make_record(name='updated'))
        result = await store.get('dep-1')
        assert result.name == 'updated'

    @pytest.mark.asyncio
    async def test_delete(self, store):
        await store.save(make_record())
        await store.delete('dep-1')
        with pytest.raises(StorageError):
            await store.get('dep-1')

    @pytest.mark.asyncio
    async def test_list_empty(self, store):
        assert await store.list() == []

    @pytest.mark.asyncio
    async def test_list(self, store):
        await store.save(make_record('dep-1'))
        await store.save(make_record('dep-2'))
        await store.save(make_record('dep-3'))
        results = await store.list()
        assert sorted(r.deployment_id for r in results) == ['dep-1', 'dep-2', 'dep-3']

    @pytest.mark.asyncio
    async def test_get_missing_raises(self, store):
        with pytest.raises(StorageError):
            await store.get('nonexistent')

    @pytest.mark.asyncio
    async def test_delete_missing_raises(self, store):
        with pytest.raises(StorageError):
            await store.delete('nonexistent')

    @pytest.mark.asyncio
    async def test_isolation(self, store, store2):
        await store.save(make_record('dep-1'))
        assert await store2.list() == []
        with pytest.raises(StorageError):
            await store2.get('dep-1')
