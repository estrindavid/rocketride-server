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
TaskScheduler — background asyncio loop that fires deployed pipelines on schedule.

On startup it scans the store for all active deployments and builds an in-memory
registry of (next_run, record) entries.  A single asyncio task wakes up when the
soonest job is due (capped at 60 s) and dispatches overdue runs via
TaskServer.start_task() — the same path as an on-demand API call.

Caller responsibilities:
  • Call scheduler.schedule(record) after every rrext_deploy_add / _update.
  • Call scheduler.unschedule(deployment_id) after every rrext_deploy_remove.
  • Do NOT call start() more than once.
"""

import asyncio
from datetime import datetime
from typing import TYPE_CHECKING, Dict, Tuple

from croniter import croniter
from rocketlib import debug

from ai.account.deployment_store import DeploymentStore
from ai.account.models import DeploymentRecord

if TYPE_CHECKING:
    from .task_server import TaskServer


class TaskScheduler:
    """Asyncio-native cron scheduler for server-managed pipeline deployments."""

    def __init__(self, task_server: 'TaskServer') -> None:
        self._server = task_server
        # deployment_id -> (next_run, record)
        self._registry: Dict[str, Tuple[datetime, DeploymentRecord]] = {}
        # deployment_id -> token of the most-recently dispatched task (overlap guard)
        self._active_tokens: Dict[str, str] = {}

    def schedule(self, record: DeploymentRecord) -> None:
        """Insert or update a deployment. Removes it when manual or not active."""
        dep_id = record.deployment_id
        if record.schedule == 'manual' or record.state != 'active':
            self._registry.pop(dep_id, None)
            return
        next_run = croniter(record.schedule, datetime.now()).get_next(datetime)
        self._registry[dep_id] = (next_run, record)

    def unschedule(self, deployment_id: str) -> None:
        """Remove a deployment from the registry."""
        self._registry.pop(deployment_id, None)
        self._active_tokens.pop(deployment_id, None)

    async def start(self) -> None:
        """Load all persisted deployments then start the scheduler loop."""
        await self._load_all()
        asyncio.create_task(self._loop())

    async def _load_all(self) -> None:
        """Populate the registry from all persisted deployments across all users."""
        try:
            async for record in DeploymentStore.iter_all(self._server.store._store):
                self.schedule(record)
            debug(f'[SCHEDULER] loaded {len(self._registry)} scheduled deployment(s)')
        except Exception as e:
            debug(f'[SCHEDULER] startup scan failed: {e}')

    async def _loop(self) -> None:
        while True:
            now = datetime.now()

            for dep_id, (next_run, record) in list(self._registry.items()):
                if next_run > now:
                    continue

                # Skip if the previous run for this deployment is still active.
                prev_token = self._active_tokens.get(dep_id)
                if prev_token:
                    ctrl = self._server._task_control.get(prev_token)
                    if ctrl and not ctrl.task.is_task_complete():
                        debug(f'[SCHEDULER] {dep_id}: previous run still active, skipping')
                        next_adv = croniter(record.schedule, now).get_next(datetime)
                        self._registry[dep_id] = (next_adv, record)
                        continue

                asyncio.create_task(self._dispatch(dep_id))

            # Sleep until the next scheduled run (max 60 s).
            if self._registry:
                soonest = min(t for t, _ in self._registry.values())
                delay = max(1.0, (soonest - datetime.now()).total_seconds())
                delay = min(delay, 60.0)
            else:
                delay = 60.0

            await asyncio.sleep(delay)

    async def _dispatch(self, dep_id: str) -> None:
        entry = self._registry.get(dep_id)
        if not entry:
            return
        _, record = entry

        try:
            request = {
                'command': 'execute',
                'arguments': {'pipeline': record.pipeline},
            }
            result = await self._server.start_task(
                request,
                conn=None,
                client_id=record.created_by,
                user_id=record.created_by,
            )
            token = result['token']
            self._active_tokens[dep_id] = token
            debug(f'[SCHEDULER] {dep_id}: dispatched → task {token}')

        except Exception as e:
            debug(f'[SCHEDULER] {dep_id}: dispatch failed: {e}')

        finally:
            # Advance to the next scheduled time regardless of success/failure.
            if dep_id in self._registry:
                _, rec = self._registry[dep_id]
                next_run = croniter(rec.schedule, datetime.now()).get_next(datetime)
                self._registry[dep_id] = (next_run, rec)
