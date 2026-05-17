// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Host-side helpers for the Voice Builder project editor flow.
 *
 * Secrets and external provider calls live in the VS Code extension host, never
 * in the webview bundle. The webview requests short-lived credentials and
 * project edits through the typed postMessage bridge.
 */

export interface IVoiceProjectEditRequest {
	transcript: string;
	currentProject: Record<string, unknown>;
	services: Record<string, unknown>;
}

export interface IVoiceProjectEditResponse {
	project: Record<string, unknown>;
	summary?: string;
}

export interface IVoiceBuilderStatus {
	enabled: boolean;
	deepgramConfigured: boolean;
	plannerConfigured: boolean;
	errors: string[];
	model?: string;
}

interface IVoicePlannerConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
}

type FetchLike = typeof fetch;

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
	const value = env[key];
	if (!value) throw new Error(`${key} not set`);
	return value;
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, '');
}

export function extractJsonObject(content: string): Record<string, unknown> {
	const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const raw = (fence?.[1] ?? content).trim();
	const start = raw.indexOf('{');
	if (start === -1) throw new Error('LLM response did not contain JSON');

	let depth = 0;
	for (let i = start; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === '{') depth++;
		if (ch === '}') {
			depth--;
			if (depth === 0) {
				return JSON.parse(raw.slice(start, i + 1)) as Record<string, unknown>;
			}
		}
	}

	throw new Error('LLM response contained incomplete JSON');
}

export async function createDeepgramTemporaryKey(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch): Promise<string> {
	const apiKey = requireEnv(env, 'DEEPGRAM_API_KEY');
	const projectId = requireEnv(env, 'DEEPGRAM_PROJECT_ID');
	const allowDirectKeyFallback = env.VOICE_BUILDER_ALLOW_DEEPGRAM_API_KEY_FALLBACK !== 'false';

	const res = await fetchImpl(`https://api.deepgram.com/v1/projects/${projectId}/keys`, {
		method: 'POST',
		headers: {
			Authorization: `Token ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			comment: 'rocketride-voice-builder',
			scopes: ['usage:write'],
			time_to_live_in_seconds: 10,
		}),
	});

	if (!res.ok) {
		const text = await res.text();
		if (allowDirectKeyFallback && text.includes('INSUFFICIENT_PERMISSIONS')) {
			return apiKey;
		}
		throw new Error(`Deepgram key creation failed: ${text}`);
	}

	const body = (await res.json()) as { key?: string };
	if (!body.key) throw new Error('Deepgram key creation returned no key');
	return body.key;
}

export function resolveVoicePlannerConfig(env: NodeJS.ProcessEnv = process.env): IVoicePlannerConfig {
	const explicitApiKey = env.VOICE_BUILDER_API_KEY;
	const groqApiKey = env.GROQ_API_KEY;
	const apiKey = explicitApiKey || groqApiKey;
	if (!apiKey) throw new Error('VOICE_BUILDER_API_KEY or GROQ_API_KEY not set');

	const baseUrl = env.VOICE_BUILDER_BASE_URL || (groqApiKey ? 'https://api.groq.com/openai/v1' : '');
	if (!baseUrl) throw new Error('VOICE_BUILDER_BASE_URL not set');

	const model = env.VOICE_BUILDER_MODEL || (groqApiKey ? 'llama-3.3-70b-versatile' : '');
	if (!model) throw new Error('VOICE_BUILDER_MODEL not set');

	return { apiKey, baseUrl: trimTrailingSlash(baseUrl), model };
}

export function getVoiceBuilderStatus(env: NodeJS.ProcessEnv = process.env): IVoiceBuilderStatus {
	const errors: string[] = [];
	const deepgramConfigured = Boolean(env.DEEPGRAM_API_KEY && env.DEEPGRAM_PROJECT_ID);
	if (!env.DEEPGRAM_API_KEY) errors.push('DEEPGRAM_API_KEY not set');
	if (!env.DEEPGRAM_PROJECT_ID) errors.push('DEEPGRAM_PROJECT_ID not set');

	let plannerConfigured = false;
	let model: string | undefined;
	try {
		const config = resolveVoicePlannerConfig(env);
		plannerConfigured = true;
		model = config.model;
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}

	return {
		enabled: deepgramConfigured && plannerConfigured,
		deepgramConfigured,
		plannerConfigured,
		errors,
		model,
	};
}

function summarizeServices(services: Record<string, unknown>): Array<Record<string, unknown>> {
	return Object.entries(services).map(([provider, raw]) => {
		const service = raw as Record<string, unknown>;
		return {
			provider,
			title: service.title,
			classType: service.classType,
			lanes: service.lanes,
		};
	});
}

function cloneRecord<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeSpeech(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleCase(text: string): string {
	return text
		.split(/\s+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

function getComponents(project: Record<string, unknown>): Array<Record<string, any>> {
	return Array.isArray(project.components) ? (project.components as Array<Record<string, any>>) : [];
}

function providerAvailable(provider: string, request: IVoiceProjectEditRequest): boolean {
	return Boolean(request.services[provider]) || getComponents(request.currentProject).some((component) => component.provider === provider);
}

function pickRequestedProvider(transcript: string, request: IVoiceProjectEditRequest): string | undefined {
	const normalized = normalizeSpeech(transcript);
	const candidates: Array<[string, string[]]> = [
		['llm_gemini', ['gemini', 'google']],
		['llm_openai', ['openai', 'gpt', '4o']],
		['llm_anthropic', ['anthropic', 'claude']],
		['memory_internal', ['memory']],
		['agent_rocketride', ['rocketride wave', 'rocket ride wave', 'agent']],
	];

	for (const [provider, words] of candidates) {
		if (words.some((word) => normalized.includes(word)) && providerAvailable(provider, request)) {
			return provider;
		}
	}

	return undefined;
}

function defaultNameForProvider(provider: string): string {
	if (provider === 'llm_gemini') return 'Voice Generated Gemini';
	if (provider === 'llm_openai') return 'Voice Generated OpenAI';
	if (provider === 'llm_anthropic') return 'Voice Generated Claude';
	if (provider === 'memory_internal') return 'Voice Memory';
	if (provider === 'agent_rocketride') return 'Voice Powered Agent';
	return 'Voice Generated Node';
}

function extractRequestedName(transcript: string): string | undefined {
	const match = transcript.match(/(?:name it|call it|rename(?:\s+it|\s+[^.]+?)?\s+to)\s+(.+)$/i);
	if (!match?.[1]) return undefined;
	const withoutCommands = match[1].split(/\b(?:and connect|then connect|and wire|then wire|with)\b/i)[0];
	const cleaned = withoutCommands.replace(/[.?!]+$/g, '').trim();
	return cleaned ? titleCase(cleaned) : undefined;
}

function nextComponentId(components: Array<Record<string, any>>, provider: string): string {
	let index = 1;
	const existing = new Set(components.map((component) => String(component.id ?? '')));
	while (existing.has(`${provider}_${index}`)) index++;
	return `${provider}_${index}`;
}

function defaultConfigForProvider(provider: string): Record<string, unknown> {
	if (provider === 'llm_gemini') {
		return { profile: 'gemini', gemini: { apikey: '${ROCKETRIDE_GEMINI_KEY}' }, parameters: {} };
	}
	if (provider === 'llm_openai') {
		return { profile: 'openai-4o', 'openai-4o': { apikey: '${ROCKETRIDE_OPENAI_KEY}' }, parameters: {} };
	}
	if (provider === 'llm_anthropic') {
		return { profile: 'claude', claude: { apikey: '${ROCKETRIDE_ANTHROPIC_KEY}' }, parameters: {} };
	}
	if (provider === 'memory_internal') {
		return { type: 'memory_internal' };
	}
	if (provider.startsWith('agent_')) {
		return { instructions: ['You are a helpful assistant. Answer the user clearly and concisely.'], parameters: {} };
	}
	return { parameters: {} };
}

function makeVoiceComponent(components: Array<Record<string, any>>, provider: string, name: string): Record<string, any> {
	const template = components.find((component) => component.provider === provider);
	const component = template ? cloneRecord(template) : { provider, config: defaultConfigForProvider(provider) };
	delete component.input;
	delete component.control;
	component.id = nextComponentId(components, provider);
	component.provider = provider;
	component.name = name;
	component.config = component.config ?? defaultConfigForProvider(provider);
	component.ui = {
		...(component.ui ?? {}),
		position: { x: 320, y: provider === 'memory_internal' ? 560 : 300 },
		nodeType: 'default',
		formDataValid: true,
	};
	return component;
}

function findVoiceComponent(components: Array<Record<string, any>>, provider: string, name: string): Record<string, any> | undefined {
	return components.find((component) => component.provider === provider && (component.name === name || String(component.name ?? '').startsWith('Voice ')));
}

function findComponent(components: Array<Record<string, any>>, provider: string): Record<string, any> | undefined {
	return components.find((component) => component.provider === provider);
}

function ensureInput(component: Record<string, any>, lane: string, from: string): void {
	const input = Array.isArray(component.input) ? component.input : [];
	if (!input.some((connection: Record<string, unknown>) => connection.lane === lane && connection.from === from)) {
		input.push({ lane, from });
	}
	component.input = input;
}

function ensureControl(component: Record<string, any>, classType: string, from: string): void {
	const control = Array.isArray(component.control) ? component.control : [];
	if (!control.some((connection: Record<string, unknown>) => connection.classType === classType && connection.from === from)) {
		control.push({ classType, from });
	}
	component.control = control;
}

function positionBetween(component: Record<string, any>, left?: Record<string, any>, right?: Record<string, any>): void {
	const leftPos = left?.ui?.position;
	const rightPos = right?.ui?.position;
	if (leftPos && rightPos) {
		component.ui = {
			...(component.ui ?? {}),
			position: {
				x: (Number(leftPos.x) + Number(rightPos.x)) / 2,
				y: (Number(leftPos.y) + Number(rightPos.y)) / 2,
			},
		};
	}
}

function removeConnectionsTo(component: Record<string, any>, deletedIds: Set<string>): void {
	if (Array.isArray(component.input)) {
		component.input = component.input.filter((connection: Record<string, unknown>) => !deletedIds.has(String(connection.from ?? '')));
		if (component.input.length === 0) delete component.input;
	}
	if (Array.isArray(component.control)) {
		component.control = component.control.filter((connection: Record<string, unknown>) => !deletedIds.has(String(connection.from ?? '')));
		if (component.control.length === 0) delete component.control;
	}
}

function matchesDeleteTarget(component: Record<string, any>, provider: string | undefined, normalized: string): boolean {
	if (provider && component.provider === provider) return true;

	const name = normalizeSpeech(String(component.name ?? ''));
	const id = normalizeSpeech(String(component.id ?? ''));
	if (name && normalized.includes(name)) return true;
	if (id && normalized.includes(id)) return true;

	if (/voice generated gemini|gemini/.test(normalized) && component.provider === 'llm_gemini') return true;
	if (/voice generated openai|openai|gpt/.test(normalized) && component.provider === 'llm_openai') return true;
	if (/voice generated claude|claude|anthropic/.test(normalized) && component.provider === 'llm_anthropic') return true;
	if (/memory/.test(normalized) && component.provider === 'memory_internal') return true;

	return false;
}

function tryDeleteDeterministicProjectEdit(request: IVoiceProjectEditRequest, normalized: string): IVoiceProjectEditResponse | undefined {
	if (!/\b(delete|remove|clear)\b/.test(normalized)) return undefined;

	const project = cloneRecord(request.currentProject);
	const components = getComponents(project);
	const provider = pickRequestedProvider(request.transcript, request);
	const keepCore = !/\b(chat|source|return answers|response answers|response)\b/.test(normalized);
	const deleted: Array<Record<string, any>> = [];
	const remaining = components.filter((component) => {
		if (keepCore && (component.provider === 'chat' || component.provider === 'response_answers')) return true;
		const shouldDelete = matchesDeleteTarget(component, provider, normalized);
		if (shouldDelete) deleted.push(component);
		return !shouldDelete;
	});

	if (deleted.length === 0) return undefined;

	const deletedIds = new Set(deleted.map((component) => String(component.id ?? '')));
	for (const component of remaining) {
		removeConnectionsTo(component, deletedIds);
	}

	project.components = remaining;
	const names = deleted.map((component) => component.name || component.provider || component.id).join(', ');
	return { project, summary: `Deleted ${names}` };
}

function tryGenerateDeterministicProjectEdit(request: IVoiceProjectEditRequest): IVoiceProjectEditResponse | undefined {
	const normalized = normalizeSpeech(request.transcript);
	const isActionable = /\b(add|create|insert|connect|wire|rename|name|delete|remove|clear)\b/.test(normalized);
	if (!isActionable) return undefined;

	const deleteEdit = tryDeleteDeterministicProjectEdit(request, normalized);
	if (deleteEdit) return deleteEdit;

	const provider = pickRequestedProvider(request.transcript, request);
	const project = cloneRecord(request.currentProject);
	const components = getComponents(project);
	const chat = findComponent(components, 'chat');
	const response = findComponent(components, 'response_answers');
	const rocketrideAgent = findComponent(components, 'agent_rocketride');
	const summaries: string[] = [];

	if (/rename/.test(normalized) && rocketrideAgent && /rocket\s*ride|rocketride|wave|agent/.test(normalized)) {
		const newName = extractRequestedName(request.transcript) ?? 'Voice Powered Agent';
		rocketrideAgent.name = newName;
		summaries.push(`Renamed RocketRide Wave to ${newName}`);
	}

	if (!provider) {
		return summaries.length > 0 ? { project, summary: summaries.join('. ') } : undefined;
	}

	const name = extractRequestedName(request.transcript) ?? defaultNameForProvider(provider);
	let target = findVoiceComponent(components, provider, name);
	if (!target) {
		target = makeVoiceComponent(components, provider, name);
		components.push(target);
		summaries.push(`Added ${name}`);
	} else if (target.name !== name && /name|rename|call/.test(normalized)) {
		target.name = name;
		summaries.push(`Renamed ${provider} to ${name}`);
	}

	if (provider === 'memory_internal') {
		if (rocketrideAgent?.id) {
			ensureControl(target, 'memory', String(rocketrideAgent.id));
			summaries.push('Connected memory to RocketRide Wave');
		}
	} else if (provider.startsWith('llm_')) {
		if (/\bbetween\b|\bchat\b|\bsource\b/.test(normalized) && chat?.id) {
			ensureInput(target, 'questions', String(chat.id));
			summaries.push(`Connected Chat to ${target.name}`);
		}
		if (/\breturn\b|\banswers\b|\bresponse\b|\bbetween\b/.test(normalized) && response?.id) {
			ensureInput(response, 'answers', String(target.id));
			positionBetween(target, chat, response);
			summaries.push(`Connected ${target.name} to Return Answers`);
		}
		if (/\bwave\b|\bagent\b|\btool\b/.test(normalized) && rocketrideAgent?.id) {
			ensureControl(target, 'llm', String(rocketrideAgent.id));
			summaries.push(`Connected ${target.name} to RocketRide Wave`);
		}
	}

	project.components = components;
	return summaries.length > 0 ? { project, summary: summaries.join('. ') } : undefined;
}

export function buildVoicePlannerMessages(request: IVoiceProjectEditRequest): Array<{ role: 'system' | 'user'; content: string }> {
	return [
		{
			role: 'system',
			content: [
				'You are RocketRide Voice Builder.',
				'Update a RocketRide .pipe project from a voice command.',
				'Return JSON only with this shape: {"project": <full updated project>, "summary": "short change summary"}.',
				'The project must keep the same project_id and must only use providers present in the service catalog.',
				'Preserve existing component IDs unless the user explicitly asks to remove or replace those components.',
			].join(' '),
		},
		{
			role: 'user',
			content: JSON.stringify({
				transcript: request.transcript,
				currentProject: request.currentProject,
				availableServices: summarizeServices(request.services),
			}),
		},
	];
}

export async function generateVoiceProjectEdit(request: IVoiceProjectEditRequest, env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch): Promise<IVoiceProjectEditResponse> {
	if (!request.transcript.trim()) throw new Error('Transcript is empty');

	const deterministicEdit = tryGenerateDeterministicProjectEdit(request);
	if (deterministicEdit) return deterministicEdit;

	const config = resolveVoicePlannerConfig(env);
	const messages = buildVoicePlannerMessages(request);

	const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: config.model,
			messages,
			temperature: 0.2,
			max_tokens: 3000,
		}),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Voice planner failed: ${text}`);
	}

	const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
	const content = body.choices?.[0]?.message?.content ?? '';
	if (!content) throw new Error('Voice planner returned empty content');

	const parsed = extractJsonObject(content);
	const project = parsed.project as Record<string, unknown> | undefined;
	if (!project || !Array.isArray(project.components)) {
		throw new Error('Voice planner response did not include a project with components');
	}
	if (project.project_id !== request.currentProject.project_id) {
		throw new Error('Voice planner attempted to change project_id');
	}

	return {
		project,
		summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
	};
}
