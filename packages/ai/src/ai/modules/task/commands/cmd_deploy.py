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

# =============================================================================
# CMD DEPLOY — DAP router for all rrext_deploy_* commands
#
# Handles server-side pipeline deployment lifecycle: add, remove, list,
# status, and update. Deployments are persisted via DeploymentStore and
# executed autonomously by the server (on-demand or cron-scheduled).
# =============================================================================

import time
import uuid
from typing import TYPE_CHECKING, Any, Dict

from ai.account import DeploymentRecord, DeploymentStore
from ai.common.dap import DAPConn, TransportBase

if TYPE_CHECKING:
    from ..task_server import TaskServer


# Cron preset aliases accepted in addition to 5-field expressions.
_CRON_PRESETS = frozenset(
    {
        '@yearly',
        '@annually',
        '@monthly',
        '@weekly',
        '@daily',
        '@midnight',
        '@hourly',
    }
)


def _validate_schedule(schedule: str) -> None:
    """Raise ValueError if schedule is not 'manual', a preset, or a 5-field cron expression."""
    if schedule == 'manual' or schedule in _CRON_PRESETS:
        return
    if len(schedule.split()) == 5:
        return
    raise ValueError(
        f'Invalid schedule {schedule!r}. Expected "manual", a cron preset (@hourly etc.), or a 5-field cron expression.'
    )


# =============================================================================
# DEPLOY COMMANDS MIXIN
# =============================================================================


class DeployCommands(DAPConn):
    """DAP router for ``rrext_deploy_*`` commands."""

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """No-op — all state lives on TaskConn via the other mixins."""
        pass

    # ── internal helpers ─────────────────────────────────────────────────────

    def _deployment_store(self) -> DeploymentStore:
        return DeploymentStore(self._server.store._store, self._account_info.userId)

    # ── rrext_deploy_add ─────────────────────────────────────────────────────

    async def on_rrext_deploy_add(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Accept a pipeline definition, persist it as a deployment, and activate it."""
        self.verify_permission('task.control')

        args = request.get('arguments') or {}
        pipeline = args.get('pipeline')
        if not pipeline:
            raise ValueError('pipeline is required')

        schedule = args.get('schedule', 'manual')
        _validate_schedule(schedule)

        record = DeploymentRecord(
            deployment_id=str(uuid.uuid4()),
            name=args.get('name', ''),
            pipeline=pipeline,
            schedule=schedule,
            state='active',
            created_by=self._account_info.userId,
            created_at=time.time(),
            updated_at=time.time(),
        )
        await self._deployment_store().save(record)
        return self.build_response(request, body=record.model_dump())

    # ── rrext_deploy_remove ──────────────────────────────────────────────────

    async def on_rrext_deploy_remove(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Undeploy and remove a pipeline from the server."""
        self.verify_permission('task.control')

        args = request.get('arguments') or {}
        deployment_id = args.get('deploymentId')
        if not deployment_id:
            raise ValueError('deploymentId is required')

        await self._deployment_store().delete(deployment_id)
        return self.build_response(request, body={})

    # ── rrext_deploy_list ────────────────────────────────────────────────────

    async def on_rrext_deploy_list(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Return all deployments for the caller with their status and schedule config."""
        self.verify_permission('task.monitor')

        records = await self._deployment_store().list()
        return self.build_response(
            request,
            body={
                'deployments': [r.model_dump() for r in records],
            },
        )

    # ── rrext_deploy_status ──────────────────────────────────────────────────

    async def on_rrext_deploy_status(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Get detailed status of a specific deployment."""
        self.verify_permission('task.monitor')

        args = request.get('arguments') or {}
        deployment_id = args.get('deploymentId')
        if not deployment_id:
            raise ValueError('deploymentId is required')

        record = await self._deployment_store().get(deployment_id)
        return self.build_response(request, body=record.model_dump())

    # ── rrext_deploy_update ──────────────────────────────────────────────────

    async def on_rrext_deploy_update(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Modify schedule or pipeline config for an existing deployment."""
        self.verify_permission('task.control')

        args = request.get('arguments') or {}
        deployment_id = args.get('deploymentId')
        if not deployment_id:
            raise ValueError('deploymentId is required')

        ds = self._deployment_store()
        record = await ds.get(deployment_id)

        if 'pipeline' in args:
            record.pipeline = args['pipeline']
        if 'schedule' in args:
            _validate_schedule(args['schedule'])
            record.schedule = args['schedule']

        record.updated_at = time.time()
        await ds.save(record)
        return self.build_response(request, body={})
