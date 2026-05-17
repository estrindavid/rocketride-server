// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import type { IProject } from '../../types';
import { PIPELINE_SCHEMA_VERSION } from '../../types';

function getRevision(project: IProject | undefined): number {
	return typeof project?.docRevision === 'number' ? project.docRevision : 0;
}

export function prepareVoiceProjectEdit(currentProject: IProject, generatedProject: IProject): IProject {
	if (!generatedProject || typeof generatedProject !== 'object') {
		throw new Error('Voice edit did not return a project');
	}

	if (!Array.isArray(generatedProject.components)) {
		throw new Error('Voice edit did not return project components');
	}

	const nextProject: IProject = {
		...currentProject,
		...generatedProject,
		project_id: currentProject.project_id ?? generatedProject.project_id,
		version: PIPELINE_SCHEMA_VERSION,
		docRevision: Math.max(getRevision(currentProject) + 1, getRevision(generatedProject)),
	};

	delete (nextProject as any).viewport;

	return nextProject;
}
