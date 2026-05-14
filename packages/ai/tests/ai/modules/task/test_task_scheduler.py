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
Unit tests for ai.modules.task.task_scheduler.TaskScheduler.

TaskScheduler.__init__ requires a live TaskServer and immediately spawns an
asyncio loop, so tests bypass __init__ via __new__ and seed only the attributes
each method under test actually reads.

Focus areas:
- schedule / unschedule  — in-memory registry management
- _load_all              — startup population via DeploymentStore.iter_all
- _dispatch              — task dispatch, record updates, error handling
- _loop                  — overdue dispatch and overlap guard
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from ai.account.deployment_store import DeploymentStore
from ai.account.models import DeploymentRecord
from ai.modules.task.task_scheduler import TaskScheduler


# =============================================================================
# Helpers
# =============================================================================


def make_record(
    deployment_id: str = 'dep-1',
    schedule: str = '*/15 * * * *',
    state: str = 'active',
    created_by: str = 'user-1',
    **kwargs,
) -> DeploymentRecord:
    return DeploymentRecord(
        deployment_id=deployment_id,
        pipeline={'components': []},
        created_by=created_by,
        schedule=schedule,
        state=state,
        **kwargs,
    )


def _make_scheduler(task_control=None) -> TaskScheduler:
    """Build a TaskScheduler with __init__ bypassed."""
    s = TaskScheduler.__new__(TaskScheduler)
    s._registry = {}
    s._active_tokens = {}
    s._server = SimpleNamespace(
        _task_control=task_control if task_control is not None else {},
        start_task=AsyncMock(return_value={'token': 'tk_new'}),
        store=SimpleNamespace(_store=MagicMock()),
    )
    return s


# =============================================================================
# schedule
# =============================================================================


class TestSchedule:
    def test_active_cron_record_added_to_registry(self):
        s = _make_scheduler()
        rec = make_record()
        s.schedule(rec)
        assert rec.deployment_id in s._registry
        next_run, stored = s._registry[rec.deployment_id]
        assert next_run > datetime.now()
        assert stored is rec

    def test_manual_schedule_not_added(self):
        s = _make_scheduler()
        s.schedule(make_record(schedule='manual'))
        assert 'dep-1' not in s._registry

    def test_manual_schedule_removes_existing_entry(self):
        s = _make_scheduler()
        rec = make_record(schedule='manual')
        s._registry[rec.deployment_id] = (datetime.now(), rec)
        s.schedule(rec)
        assert rec.deployment_id not in s._registry

    def test_paused_state_removes_from_registry(self):
        s = _make_scheduler()
        rec = make_record(state='paused')
        s._registry[rec.deployment_id] = (datetime.now(), rec)
        s.schedule(rec)
        assert rec.deployment_id not in s._registry

    def test_errored_state_removes_from_registry(self):
        s = _make_scheduler()
        rec = make_record(state='errored')
        s._registry[rec.deployment_id] = (datetime.now(), rec)
        s.schedule(rec)
        assert rec.deployment_id not in s._registry

    def test_reschedule_replaces_existing_entry(self):
        s = _make_scheduler()
        rec = make_record()
        s.schedule(rec)
        s.schedule(rec)
        assert len(s._registry) == 1
        next_run, _ = s._registry[rec.deployment_id]
        assert next_run > datetime.now()


# =============================================================================
# unschedule
# =============================================================================


class TestUnschedule:
    def test_removes_from_registry(self):
        s = _make_scheduler()
        rec = make_record()
        s._registry[rec.deployment_id] = (datetime.now(), rec)
        s.unschedule(rec.deployment_id)
        assert rec.deployment_id not in s._registry

    def test_removes_active_token(self):
        s = _make_scheduler()
        s._active_tokens['dep-1'] = 'tk_old'
        s.unschedule('dep-1')
        assert 'dep-1' not in s._active_tokens

    def test_noop_when_not_present(self):
        s = _make_scheduler()
        s.unschedule('nonexistent')  # must not raise


# =============================================================================
# _load_all
# =============================================================================


class TestLoadAll:
    @pytest.mark.asyncio
    async def test_schedules_active_deployment(self):
        s = _make_scheduler()
        rec = make_record(schedule='@hourly', state='active')

        async def _iter(store):
            yield rec

        with patch.object(DeploymentStore, 'iter_all', _iter):
            await s._load_all()

        assert rec.deployment_id in s._registry

    @pytest.mark.asyncio
    async def test_does_not_schedule_manual_deployment(self):
        s = _make_scheduler()
        rec = make_record(schedule='manual')

        async def _iter(store):
            yield rec

        with patch.object(DeploymentStore, 'iter_all', _iter):
            await s._load_all()

        assert rec.deployment_id not in s._registry

    @pytest.mark.asyncio
    async def test_loads_multiple_records(self):
        s = _make_scheduler()
        records = [make_record('dep-1'), make_record('dep-2'), make_record('dep-3')]

        async def _iter(store):
            for r in records:
                yield r

        with patch.object(DeploymentStore, 'iter_all', _iter):
            await s._load_all()

        assert set(s._registry) == {'dep-1', 'dep-2', 'dep-3'}

    @pytest.mark.asyncio
    async def test_handles_iter_all_exception_gracefully(self):
        s = _make_scheduler()

        async def _iter(store):
            raise OSError('storage unavailable')
            yield  # make it an async generator

        with patch.object(DeploymentStore, 'iter_all', _iter):
            await s._load_all()  # must not raise

        assert s._registry == {}


# =============================================================================
# _dispatch
# =============================================================================


class TestDispatch:
    @pytest.mark.asyncio
    async def test_calls_start_task_with_correct_args(self):
        s = _make_scheduler()
        rec = make_record()
        s._registry[rec.deployment_id] = (datetime.now(), rec)

        await s._dispatch(rec.deployment_id)

        s._server.start_task.assert_called_once()
        call = s._server.start_task.call_args
        assert call.args[0]['command'] == 'execute'
        assert call.args[0]['arguments']['pipeline'] == rec.pipeline
        assert call.kwargs['user_id'] == rec.created_by
        assert call.kwargs['client_id'] == rec.created_by
        assert call.kwargs['conn'] is None

    @pytest.mark.asyncio
    async def test_stores_returned_token(self):
        s = _make_scheduler()
        rec = make_record()
        s._registry[rec.deployment_id] = (datetime.now(), rec)
        s._server.start_task = AsyncMock(return_value={'token': 'tk_abc'})

        await s._dispatch(rec.deployment_id)

        assert s._active_tokens[rec.deployment_id] == 'tk_abc'

    @pytest.mark.asyncio
    async def test_advances_next_run_on_success(self):
        s = _make_scheduler()
        rec = make_record()
        old_next = datetime.now() - timedelta(minutes=5)
        s._registry[rec.deployment_id] = (old_next, rec)

        await s._dispatch(rec.deployment_id)

        new_next, _ = s._registry[rec.deployment_id]
        assert new_next > old_next

    @pytest.mark.asyncio
    async def test_advances_next_run_on_failure(self):
        s = _make_scheduler()
        rec = make_record()
        old_next = datetime.now() - timedelta(minutes=5)
        s._registry[rec.deployment_id] = (old_next, rec)
        s._server.start_task = AsyncMock(side_effect=RuntimeError('boom'))

        await s._dispatch(rec.deployment_id)

        new_next, _ = s._registry[rec.deployment_id]
        assert new_next > old_next

    @pytest.mark.asyncio
    async def test_noop_when_not_in_registry(self):
        s = _make_scheduler()
        await s._dispatch('nonexistent')
        s._server.start_task.assert_not_called()


# =============================================================================
# _loop
# =============================================================================


class TestLoop:
    @pytest.mark.asyncio
    async def test_dispatches_overdue_job(self):
        s = _make_scheduler()
        rec = make_record()
        s._registry[rec.deployment_id] = (datetime.now() - timedelta(seconds=1), rec)
        s._dispatch = AsyncMock()

        task = asyncio.create_task(s._loop())
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        s._dispatch.assert_called_once_with(rec.deployment_id)

    @pytest.mark.asyncio
    async def test_does_not_dispatch_future_job(self):
        s = _make_scheduler()
        rec = make_record()
        s._registry[rec.deployment_id] = (datetime.now() + timedelta(hours=1), rec)
        s._dispatch = AsyncMock()

        task = asyncio.create_task(s._loop())
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        s._dispatch.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_when_previous_run_still_active(self):
        s = _make_scheduler()
        rec = make_record()
        s._registry[rec.deployment_id] = (datetime.now() - timedelta(seconds=1), rec)
        s._active_tokens[rec.deployment_id] = 'tk_old'
        s._server._task_control['tk_old'] = SimpleNamespace(task=SimpleNamespace(is_task_complete=lambda: False))
        s._dispatch = AsyncMock()

        task = asyncio.create_task(s._loop())
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        s._dispatch.assert_not_called()

    @pytest.mark.asyncio
    async def test_dispatches_when_previous_run_complete(self):
        s = _make_scheduler()
        rec = make_record()
        s._registry[rec.deployment_id] = (datetime.now() - timedelta(seconds=1), rec)
        s._active_tokens[rec.deployment_id] = 'tk_old'
        s._server._task_control['tk_old'] = SimpleNamespace(task=SimpleNamespace(is_task_complete=lambda: True))
        s._dispatch = AsyncMock()

        task = asyncio.create_task(s._loop())
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        s._dispatch.assert_called_once_with(rec.deployment_id)

    @pytest.mark.asyncio
    async def test_dispatches_when_previous_token_already_cleaned_up(self):
        s = _make_scheduler()
        rec = make_record()
        s._registry[rec.deployment_id] = (datetime.now() - timedelta(seconds=1), rec)
        s._active_tokens[rec.deployment_id] = 'tk_old'
        # token not in _task_control — task was already cleaned up
        s._dispatch = AsyncMock()

        task = asyncio.create_task(s._loop())
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        s._dispatch.assert_called_once_with(rec.deployment_id)
