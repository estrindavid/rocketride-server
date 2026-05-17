// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ProjectProvider — Unified custom editor for .pipeline files.
 *
 * Combines the former PageEditorProvider (canvas editing, file I/O, undo/redo)
 * and StatusProvider (status, trace, flow monitoring) into a single provider
 * that renders the shared-ui ProjectView component.
 *
 * Uses the ProjectViewIncoming / ProjectViewOutgoing message protocol to
 * communicate with the Project webview.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import { TaskStatus, GenericEvent, ConnectionState, PIPE_BUILDER_APP_ID } from '../shared/types';
import { ConnectionManager } from '../connection/connection';
import { ConfigManager } from '../config';
import type { PipelineConfig } from 'rocketride';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';
import { PipelineFileParser } from '../shared/util/pipelineParser';
import { isSubscribed } from '../shared/util/subscriptionGate';
import { createDeepgramTemporaryKey, generateVoiceProjectEdit, getVoiceBuilderStatus } from './voice/voiceProjectPlanner';

// =============================================================================
// CONSTANTS
// =============================================================================

const PREFS_KEY = 'rocketride.prefs';
const LAYOUTS_KEY = 'rocketride.layouts';
const VOICE_METRICS_KEY = 'rocketride.voiceBuilder.metrics';

// =============================================================================
// TYPES
// =============================================================================

interface EditorState {
	document: vscode.TextDocument;
	webviewPanel: vscode.WebviewPanel;
	projectId?: string;
	isDisposed: boolean;
	isReady: boolean;
	cachedStatuses: Record<string, TaskStatus>;
}

interface VoiceUsageMetrics {
	totalEvents: number;
	sessionStarted: number;
	sessionStopped: number;
	utteranceCompleted: number;
	editApplied: number;
	editFailed: number;
	editReverted: number;
	totalTranscriptChars: number;
	totalAppliedComponents: number;
	lastEventAt?: string;
	lastProject?: string;
	lastError?: string;
}

// =============================================================================
// PROVIDER
// =============================================================================

export class ProjectProvider implements vscode.CustomTextEditorProvider {
	private disposables: vscode.Disposable[] = [];
	private editorStates: Map<vscode.WebviewPanel, EditorState> = new Map();
	private connectionManager = ConnectionManager.getInstance();
	private logger = getLogger();
	private savesForRun: Set<string> = new Set();
	private voiceCaptureServer?: http.Server;
	private voiceCapturePort?: number;
	private voiceCaptureToken = crypto.randomBytes(16).toString('hex');

	constructor(private readonly context: vscode.ExtensionContext) {
		this.registerCommands();
		this.setupEventListeners();
	}

	// =========================================================================
	// SAVE-FOR-RUN CHECK
	// =========================================================================

	public isSaveForRun(uri: vscode.Uri): boolean {
		return this.savesForRun.has(uri.toString());
	}

	public getTaskStatus(projectId: string, sourceId: string): TaskStatus | undefined {
		for (const editorState of this.editorStates.values()) {
			if (editorState.projectId === projectId) {
				return editorState.cachedStatuses[sourceId];
			}
		}
		return undefined;
	}

	// =========================================================================
	// EVENT LISTENERS
	// =========================================================================

	private setupEventListeners(): void {
		const eventListener = this.connectionManager.on('shell:event', (event) => {
			try {
				this.handleEvent(event);
			} catch (error) {
				this.logger.error(`Handling event: ${error}`);
			}
		});

		// Account updates (subscription changes, env changes) are emitted as
		// a dedicated shell:accountUpdate — no longer buried in shell:event
		const accountUpdateListener = this.connectionManager.on('shell:accountUpdate', () => {
			this.broadcastSubscriptionStatus();
		});

		const connectionStateListener = this.connectionManager.on('shell:statusChange', async (connectionStatus) => {
			try {
				if (connectionStatus.state === ConnectionState.CONNECTED) {
					this.onConnectedClearStaleData();
				}
				this.broadcastConnectionState(this.connectionManager.isConnected());
			} catch (error) {
				this.logger.error(`Handling connection state change: ${error}`);
			}
		});

		const servicesUpdatedListener = this.connectionManager.on('shell:servicesUpdated', (payload: { services: Record<string, unknown>; servicesError?: string }) => {
			this.broadcastServicesToAllEditors(payload);
		});

		this.disposables.push(eventListener, accountUpdateListener, connectionStateListener, servicesUpdatedListener);
	}

	// =========================================================================
	// EVENT ROUTING
	// =========================================================================

	private handleEvent(event: GenericEvent): void {
		const projectId = event.body?.project_id;
		if (!projectId) return;

		if (event.event === 'apaevt_status_update') {
			const source = event.body?.source;
			if (source) {
				for (const editorState of this.editorStates.values()) {
					if (!editorState.isDisposed && editorState.projectId === projectId) {
						editorState.cachedStatuses[source] = event.body as TaskStatus;
					}
				}
			}
		}

		if (event.event === 'apaevt_status_update' || event.event === 'apaevt_flow') {
			for (const editorState of this.editorStates.values()) {
				if (editorState.isDisposed || !editorState.isReady) continue;
				if (editorState.projectId !== projectId) continue;
				editorState.webviewPanel.webview.postMessage({ type: 'shell:event', event });
			}
		}
	}

	// =========================================================================
	// BROADCASTING
	// =========================================================================

	private broadcastServicesToAllEditors(payload: { services: Record<string, unknown>; servicesError?: string }): void {
		for (const editorState of this.editorStates.values()) {
			if (editorState.isReady && !editorState.isDisposed && editorState.webviewPanel.webview) {
				editorState.webviewPanel.webview
					.postMessage({
						type: 'project:services',
						services: payload.services,
					})
					.then(undefined, (err: unknown) => {
						this.logger.error(`Failed to post services to webview: ${err}`);
					});
			}
		}
	}

	private broadcastConnectionState(isConnected: boolean): void {
		const client = this.connectionManager.getClient();
		const subscribed = isSubscribed(client, PIPE_BUILDER_APP_ID);
		for (const editorState of this.editorStates.values()) {
			if (editorState.isReady && !editorState.isDisposed && editorState.webviewPanel.webview) {
				editorState.webviewPanel.webview.postMessage({ type: 'shell:connectionChange', isConnected, isSubscribed: subscribed }).then(undefined, (err: unknown) => {
					this.logger.error(`Failed to post connectionState to webview: ${err}`);
				});
			}
		}
	}

	/**
	 * Broadcasts updated subscription status to all open editor webviews.
	 * Called when an apaext_account event arrives (subscription change).
	 */
	private broadcastSubscriptionStatus(): void {
		const client = this.connectionManager.getClient();
		const subscribed = isSubscribed(client, PIPE_BUILDER_APP_ID);
		for (const editorState of this.editorStates.values()) {
			if (editorState.isReady && !editorState.isDisposed && editorState.webviewPanel.webview) {
				editorState.webviewPanel.webview.postMessage({ type: 'checkout:subscriptionUpdate', isSubscribed: subscribed }).then(undefined, (err: unknown) => {
					this.logger.error(`Failed to post subscriptionUpdate to webview: ${err}`);
				});
			}
		}
	}

	// =========================================================================
	// MONITORING
	// =========================================================================

	private async startMonitoring(panel: vscode.WebviewPanel): Promise<void> {
		const editorState = this.editorStates.get(panel);
		if (!editorState || editorState.isDisposed || !editorState.projectId || !this.connectionManager.isConnected()) {
			return;
		}

		try {
			const client = this.connectionManager.getClient();
			if (!client) throw new Error('No client available');
			await client.addMonitor({ projectId: editorState.projectId, source: '*' }, ['summary', 'flow']);
		} catch (error) {
			this.logger.error(`Starting monitoring for project ${editorState.projectId}: ${error}`);
		}
	}

	private async stopMonitoring(panel: vscode.WebviewPanel): Promise<void> {
		const editorState = this.editorStates.get(panel);
		if (!editorState || !editorState.projectId) return;

		try {
			const client = this.connectionManager.getClient();
			if (client) await client.removeMonitor({ projectId: editorState.projectId, source: '*' }, ['summary', 'flow']);
		} catch (error) {
			this.logger.error(`Stopping monitoring for project ${editorState.projectId}: ${error}`);
		}
	}

	private onConnectedClearStaleData(): void {
		for (const editorState of this.editorStates.values()) {
			editorState.cachedStatuses = {};
		}
	}

	// =========================================================================
	// COMMANDS
	// =========================================================================

	private registerCommands(): void {
		const commands = [
			vscode.commands.registerCommand('rocketride.openPipelineAsText', (uri: vscode.Uri) => {
				const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
				if (targetUri) {
					vscode.commands.executeCommand('vscode.openWith', targetUri, 'default');
				} else {
					vscode.window.showErrorMessage('No pipeline file selected');
				}
			}),

			vscode.commands.registerCommand('rocketride.editor.save', async () => {
				if (vscode.window.activeTextEditor?.document.languageId === 'pipeline') {
					await vscode.commands.executeCommand('workbench.action.files.save');
				}
			}),

			vscode.commands.registerCommand('rocketride.editor.refresh', async () => {
				if (vscode.window.activeTextEditor?.document.languageId === 'pipeline') {
					await vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
			}),
		];

		this.disposables.push(...commands);
		commands.forEach((command) => this.context.subscriptions.push(command));
	}

	private async recordVoiceMetric(event: Record<string, unknown>, uri: vscode.Uri): Promise<void> {
		const name = typeof event.name === 'string' ? event.name : 'unknown';
		const existing = this.context.workspaceState.get<VoiceUsageMetrics>(VOICE_METRICS_KEY) ?? {
			totalEvents: 0,
			sessionStarted: 0,
			sessionStopped: 0,
			utteranceCompleted: 0,
			editApplied: 0,
			editFailed: 0,
			editReverted: 0,
			totalTranscriptChars: 0,
			totalAppliedComponents: 0,
		};

		const next: VoiceUsageMetrics = {
			...existing,
			totalEvents: existing.totalEvents + 1,
			lastEventAt: new Date().toISOString(),
			lastProject: uri.toString(),
		};

		if (name in next && typeof next[name as keyof VoiceUsageMetrics] === 'number') {
			(next as unknown as Record<string, number>)[name] = ((next as unknown as Record<string, number>)[name] ?? 0) + 1;
		}
		if (typeof event.transcriptLength === 'number') {
			next.totalTranscriptChars += event.transcriptLength;
		}
		if (name === 'editApplied' && typeof event.componentCount === 'number') {
			next.totalAppliedComponents += event.componentCount;
		}
		if (name === 'editFailed' && typeof event.error === 'string') {
			next.lastError = event.error;
		}

		await this.context.workspaceState.update(VOICE_METRICS_KEY, next);

		if (name === 'editApplied' || name === 'editFailed' || name === 'editReverted') {
			this.logger.output(`${icons.pipeline} Voice Builder ${name}: ${next.editApplied} applied, ${next.editFailed} failed, ${next.editReverted} reverted`);
		}
	}

	private async ensureVoiceCaptureServer(): Promise<number> {
		if (this.voiceCaptureServer && this.voiceCapturePort) return this.voiceCapturePort;

		this.voiceCaptureServer = http.createServer((req, res) => {
			this.handleVoiceCaptureRequest(req, res).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: message }));
			});
		});

		await new Promise<void>((resolve, reject) => {
			this.voiceCaptureServer!.once('error', reject);
			this.voiceCaptureServer!.listen(0, '127.0.0.1', () => resolve());
		});

		const address = this.voiceCaptureServer.address();
		if (!address || typeof address === 'string') throw new Error('Voice capture server did not return a local port');
		this.voiceCapturePort = address.port;
		return address.port;
	}

	private async handleVoiceCaptureRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const token = url.searchParams.get('token');
		const allow = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Headers': 'content-type',
			'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
		};

		if (req.method === 'OPTIONS') {
			res.writeHead(204, allow);
			res.end();
			return;
		}

		if (token !== this.voiceCaptureToken) {
			res.writeHead(403, { ...allow, 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid voice capture token' }));
			return;
		}

		if (req.method === 'GET' && url.pathname === '/') {
			res.writeHead(200, { ...allow, 'Content-Type': 'text/html; charset=utf-8' });
			res.end(this.getVoiceCaptureHtml(this.voiceCaptureToken));
			return;
		}

		if (req.method === 'GET' && url.pathname === '/deepgram-token') {
			const key = await createDeepgramTemporaryKey();
			res.writeHead(200, { ...allow, 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ key }));
			return;
		}

		if (req.method === 'POST' && url.pathname === '/utterance') {
			const body = await this.readRequestBody(req);
			const parsed = JSON.parse(body || '{}') as { transcript?: string };
			const transcript = typeof parsed.transcript === 'string' ? parsed.transcript.trim() : '';
			if (transcript) {
				this.logger.output(`${icons.pipeline} Voice Builder heard: ${transcript}`);
				for (const editorState of this.editorStates.values()) {
					if (editorState.isReady && !editorState.isDisposed) {
						editorState.webviewPanel.webview.postMessage({ type: 'voice:externalUtterance', transcript });
					}
				}
			}
			res.writeHead(200, { ...allow, 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true }));
			return;
		}

		res.writeHead(404, { ...allow, 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not found' }));
	}

	private readRequestBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			let body = '';
			req.setEncoding('utf8');
			req.on('data', (chunk) => {
				body += chunk;
				if (body.length > 1024 * 1024) {
					req.destroy(new Error('Voice capture request too large'));
				}
			});
			req.on('end', () => resolve(body));
			req.on('error', reject);
		});
	}

	private async openExternalVoiceCapture(): Promise<void> {
		const port = await this.ensureVoiceCaptureServer();
		const uri = vscode.Uri.parse(`http://127.0.0.1:${port}/?token=${this.voiceCaptureToken}`);
		await vscode.env.openExternal(uri);
		this.logger.output(`${icons.pipeline} Opened browser Voice Builder capture window`);
	}

	private getVoiceCaptureHtml(token: string): string {
		const safeToken = JSON.stringify(token);
		return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RocketRide Voice Capture</title>
<style>
body{margin:0;min-height:100vh;background:#111;color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center}
main{width:min(680px,calc(100vw - 32px));border:1px solid #333;border-radius:10px;background:#191919;padding:22px;box-shadow:0 14px 42px rgba(0,0,0,.35)}
h1{font-size:22px;margin:0 0 8px}p{color:#aaa;line-height:1.45}button{height:40px;padding:0 16px;border:0;border-radius:7px;background:#2387b8;color:white;font-weight:700;cursor:pointer}button.stop{background:#555}.box{min-height:90px;border:1px solid #333;border-radius:8px;background:#101010;padding:12px;margin:16px 0;color:#eee}.status{color:#aaa;font-size:13px}.err{color:#ff8a70}
</style>
</head>
<body>
<main>
<h1>RocketRide Voice Capture</h1>
<p>This browser window captures microphone audio and sends completed voice commands back to the RocketRide canvas.</p>
<button id="toggle">Start listening</button>
<div class="box" id="transcript">Voice ready</div>
<div class="status" id="status">Idle</div>
</main>
<script>
const token=${safeToken};
let socket, recorder, stream, finalText='', interimText='', timer, listening=false;
const sentLiveKeys=new Set();
const transcriptEl=document.getElementById('transcript');
const statusEl=document.getElementById('status');
const toggle=document.getElementById('toggle');
function setStatus(text,isError){statusEl.textContent=text;statusEl.className=isError?'status err':'status'}
function norm(text){return String(text||'').replace(/\\s+/g,' ').trim()}
function render(){transcriptEl.textContent=norm(finalText+' '+interimText)||'Voice ready'}
function postUtterance(text){return fetch('/utterance?token='+token,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({transcript:text})})}
function liveKey(text){const lower=text.toLowerCase(); if(!/\\b(add|create|insert|connect|wire|rename|name|delete|remove|clear)\\b/.test(lower))return ''; const mode=/\\b(delete|remove|clear)\\b/.test(lower)?'delete:':'edit:'; if(/gemini|google/.test(lower))return mode+'gemini'; if(/openai|gpt|4o/.test(lower))return mode+'openai'; if(/anthropic|claude/.test(lower))return mode+'claude'; if(/memory/.test(lower))return mode+'memory'; if(/rocket\\s*ride|rocketride|wave|agent/.test(lower))return mode+'agent'; return mode+'general'}
function maybePostLive(){const text=norm(finalText+' '+interimText); const key=liveKey(text); if(!key||sentLiveKeys.has(key)||text.length<16)return; sentLiveKeys.add(key); setStatus('Sent live command to RocketRide. Keep speaking to refine it.'); postUtterance(text)}
function flush(){const text=norm(finalText+' '+interimText); finalText=''; interimText=''; render(); if(text) postUtterance(text)}
function schedule(){clearTimeout(timer); timer=setTimeout(flush,1000)}
function deepgramUrl(){const u=new URL('wss://api.deepgram.com/v1/listen'); u.searchParams.set('model','nova-2'); u.searchParams.set('language','en-US'); u.searchParams.set('interim_results','true'); u.searchParams.set('smart_format','true'); u.searchParams.set('utterance_end_ms','1000'); u.searchParams.set('endpointing','300'); return u.toString()}
async function start(){
 try{
  setStatus('Requesting microphone...');
  const keyResp=await fetch('/deepgram-token?token='+token);
  if(!keyResp.ok) throw new Error(await keyResp.text());
  const {key}=await keyResp.json();
  stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  socket=new WebSocket(deepgramUrl(),['token',key]);
  recorder=new MediaRecorder(stream);
  recorder.ondataavailable=e=>{if(e.data.size>0&&socket&&socket.readyState===WebSocket.OPEN)socket.send(e.data)};
  socket.onopen=()=>{recorder.start(250); listening=true; toggle.textContent='Stop listening'; toggle.className='stop'; setStatus('Listening. Speak a RocketRide command.')};
  socket.onmessage=e=>{let m; try{m=JSON.parse(e.data)}catch{return} if(m.type==='UtteranceEnd'){flush();return} const t=norm(m.channel?.alternatives?.[0]?.transcript||''); if(!t)return; if(m.is_final){finalText=norm(finalText+' '+t); interimText=''; if(m.speech_final)flush(); else schedule()}else{interimText=t; schedule()} render(); maybePostLive()};
  socket.onerror=()=>setStatus('Deepgram websocket failed',true);
  socket.onclose=()=>{if(listening)stop()};
 }catch(e){setStatus(e&&e.message?e.message:String(e),true); stop()}
}
function stop(){clearTimeout(timer); flush(); listening=false; if(recorder&&recorder.state!=='inactive')recorder.stop(); if(socket&&socket.readyState<=1)socket.close(); if(stream)stream.getTracks().forEach(t=>t.stop()); recorder=null; socket=null; stream=null; toggle.textContent='Start listening'; toggle.className=''; setStatus('Idle')}
toggle.onclick=()=>listening?stop():start();
</script>
</body>
</html>`;
	}

	// =========================================================================
	// RESOLVE CUSTOM TEXT EDITOR
	// =========================================================================

	public async resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel, _token: vscode.CancellationToken): Promise<void> {
		const webview = webviewPanel.webview;

		const fileName = document.uri.fsPath.split(/[\\/]/).pop() ?? document.uri.fsPath;
		webviewPanel.title = fileName.replace(/\.pipe(\.json)?$/i, '');

		const { projectId } = this.extractPipelineIds(document);

		const editorState: EditorState = {
			document,
			webviewPanel,
			projectId,
			isDisposed: false,
			isReady: false,
			cachedStatuses: {},
		};

		this.editorStates.set(webviewPanel, editorState);

		webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		};

		webview.html = this.getHtmlForWebview(webview);

		// --- Handle messages from the webview (ProjectViewOutgoing) -----------

		webview.onDidReceiveMessage(async (data) => {
			switch (data.type) {
				case 'view:ready': {
					editorState.isReady = true;

					// Build project from document
					const text = document.getText();
					const parsed = PipelineFileParser.parseContent(text, document.uri.fsPath);
					let project: Record<string, unknown> | undefined;
					if (parsed.isValid) {
						try {
							project = JSON.parse(this.enrichComponentNames(text));
						} catch {
							/* invalid JSON */
						}
					}

					// Load layout defaults + prefs
					const layouts = this.context.workspaceState.get<Record<string, Record<string, unknown>>>(LAYOUTS_KEY) ?? {};
					const layout = layouts[document.uri.toString()] ?? {};
					const storedPrefs = this.context.workspaceState.get<Record<string, unknown>>(PREFS_KEY) ?? {};
					const cached = this.connectionManager.getCachedServices();
					const client = this.connectionManager.getClient();

					// Send everything in one message
					webview.postMessage({
						type: 'project:load',
						project,
						viewState: { mode: 'design', ...layout },
						prefs: storedPrefs,
						services: cached.services,
						isConnected: this.connectionManager.isConnected(),
						isSubscribed: isSubscribed(client, PIPE_BUILDER_APP_ID),
						statuses: editorState.cachedStatuses,
						serverHost: this.connectionManager.getHttpUrl(),
						voiceStatus: getVoiceBuilderStatus(),
					});
					webview.postMessage({ type: 'project:dirtyState', isDirty: document.isDirty, isNew: document.isUntitled });

					// Kick off background services refresh
					this.connectionManager.refreshServices().catch((err) => {
						this.logger.error(`Background services refresh failed: ${err}`);
					});

					// Start monitoring
					try {
						await this.startMonitoring(webviewPanel);
					} catch (error) {
						this.logger.error(`Starting monitoring after webview ready: ${error}`);
					}
					break;
				}

				// Canvas messages
				case 'project:contentChanged': {
					if (data.project) {
						const content = typeof data.project === 'string' ? data.project : JSON.stringify(data.project);
						this.applyDocumentEdit(document, content);
					}
					break;
				}

				case 'project:validate': {
					this.logger.output(`${icons.pipeline} Validating pipeline...`);
					try {
						const client = this.connectionManager.getClient();
						if (!client) throw new Error('Not connected to server');
						const result = await client.validate({ pipeline: data.pipeline });
						this.logger.output(`${icons.success} Pipeline validation passed`);
						webview.postMessage({ type: 'project:validateResponse', requestId: data.requestId, result });
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						this.logger.output(`${icons.error} Pipeline validation failed: ${msg}`);
						webview.postMessage({ type: 'project:validateResponse', requestId: data.requestId, result: { errors: [], warnings: [] }, error: msg });
					}
					break;
				}

				case 'project:requestSave': {
					await document.save();
					break;
				}

				case 'voice:deepgramToken': {
					try {
						const key = await createDeepgramTemporaryKey();
						webview.postMessage({ type: 'voice:deepgramTokenResponse', requestId: data.requestId, key });
					} catch (error: unknown) {
						const msg = error instanceof Error ? error.message : String(error);
						webview.postMessage({ type: 'voice:deepgramTokenResponse', requestId: data.requestId, error: msg });
					}
					break;
				}

				case 'voice:generateProjectEdit': {
					try {
						const result = await generateVoiceProjectEdit({
							transcript: data.transcript as string,
							currentProject: data.currentProject as Record<string, unknown>,
							services: data.services as Record<string, unknown>,
						});
						webview.postMessage({ type: 'voice:generateProjectEditResponse', requestId: data.requestId, project: result.project, summary: result.summary });
					} catch (error: unknown) {
						const msg = error instanceof Error ? error.message : String(error);
						webview.postMessage({ type: 'voice:generateProjectEditResponse', requestId: data.requestId, error: msg });
					}
					break;
				}

				case 'voice:openExternalCapture': {
					try {
						await this.openExternalVoiceCapture();
					} catch (error: unknown) {
						const msg = error instanceof Error ? error.message : String(error);
						vscode.window.showErrorMessage(`Unable to open browser voice capture: ${msg}`);
					}
					break;
				}

				case 'voice:metric': {
					this.recordVoiceMetric(data.event as Record<string, unknown>, document.uri).catch((error: unknown) => {
						this.logger.error(`Recording voice metric failed: ${error}`);
					});
					break;
				}

				// Status messages
				case 'status:pipelineAction': {
					const action = data.action as 'run' | 'stop' | 'restart';
					const source = data.source as string | undefined;
					if (action === 'run' || action === 'restart') {
						// Gate: check connection before running
						const runClient = this.connectionManager.getClient();
						if (!runClient) {
							vscode.window.showErrorMessage('Not connected to server');
							break;
						}
						// Gate: check subscription before running
						const sub = isSubscribed(runClient, PIPE_BUILDER_APP_ID);
						if (!sub) {
							webview.postMessage({ type: 'checkout:required' });
							break;
						}
						const uriKey = document.uri.toString();
						this.savesForRun.add(uriKey);
						try {
							await this.saveDocument(document, document.getText());
							const parsed = JSON.parse(document.getText());
							const pipeName = path.basename(document.uri.fsPath, '.pipe');
							await this.runPipeline({ pipeline: { ...parsed, source: source ?? parsed.source } }, pipeName);
						} catch (error: unknown) {
							const message = error instanceof Error ? error.message : String(error);
							vscode.window.showErrorMessage(`Failed to run pipeline: ${message}`);
						}
						setTimeout(() => this.savesForRun.delete(uriKey), 2000);
					} else if (action === 'stop') {
						if (source) {
							await this.stopPipeline(source, document);
						}
					}
					break;
				}

				// Link opening
				case 'project:openLink': {
					if (data.url) {
						this.openLink(data.url as string, data.displayName as string | undefined);
					}
					break;
				}

				// Trace messages
				case 'trace:clear':
					// No-op on host side
					break;

				// View state change — not persisted in VS Code
				case 'project:viewStateChange': {
					// Update layouts (per-document defaults for future opens)
					if (data.viewState) {
						const allLayouts = this.context.workspaceState.get<Record<string, unknown>>(LAYOUTS_KEY) ?? {};
						allLayouts[document.uri.toString()] = data.viewState;
						this.context.workspaceState.update(LAYOUTS_KEY, allLayouts).then(undefined, (err: unknown) => {
							this.logger.error(`Failed to persist layout: ${err}`);
						});
					}
					break;
				}

				// Prefs change — persist globally
				case 'project:prefsChange': {
					if (data.prefs) {
						this.context.workspaceState.update(PREFS_KEY, data.prefs).then(undefined, (err: unknown) => {
							this.logger.error(`Failed to persist prefs: ${err}`);
						});
					}
					break;
				}

				// Checkout flow — bridge billing SDK calls for the CheckoutModal
				case 'checkout:fetchPlans': {
					try {
						const billingClient = this.connectionManager.getClient();
						if (!billingClient) throw new Error('Not connected');
						const plans = await billingClient.billing.getProductPrices(PIPE_BUILDER_APP_ID);
						webview.postMessage({ type: 'checkout:plansResult', plans, error: null });
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						webview.postMessage({ type: 'checkout:plansResult', plans: [], error: msg });
					}
					break;
				}

				case 'checkout:createSession': {
					try {
						const billingClient = this.connectionManager.getClient();
						if (!billingClient) throw new Error('Not connected');
						const orgId = billingClient.getAccountInfo()?.organizations?.[0]?.id;
						if (!orgId) throw new Error('No organisation found');
						const result = await billingClient.billing.createCheckoutSession(orgId, PIPE_BUILDER_APP_ID, data.priceId as string);
						webview.postMessage({ type: 'checkout:sessionResult', ...result, error: null });
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						webview.postMessage({ type: 'checkout:sessionResult', clientSecret: '', subscriptionId: '', error: msg });
					}
					break;
				}

				case 'checkout:confirmPending': {
					try {
						const billingClient = this.connectionManager.getClient();
						if (!billingClient) throw new Error('Not connected');
						await (billingClient as any).dapRequest('rrext_account_billing', {
							subcommand: 'confirm_pending',
							appId: PIPE_BUILDER_APP_ID,
							subscriptionId: data.subscriptionId,
							priceId: data.priceId,
						});
						webview.postMessage({ type: 'checkout:confirmResult', error: null });
					} catch (err: unknown) {
						// Non-fatal — the webhook will still update the DB
						webview.postMessage({ type: 'checkout:confirmResult', error: null });
					}
					break;
				}
			}
		});

		// Listen for document changes (undo/redo) and sync to webview
		const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.toString() === document.uri.toString()) {
				const { projectId: newProjectId } = this.extractPipelineIds(e.document);
				editorState.projectId = newProjectId;
				this.sendCanvasUpdate(webview, e.document);
				if (editorState.isReady) {
					webview.postMessage({ type: 'project:dirtyState', isDirty: e.document.isDirty, isNew: e.document.isUntitled });
				}
			}
		});

		// Listen for saves to clear dirty state in canvas
		const saveDocumentSubscription = vscode.workspace.onDidSaveTextDocument((savedDoc) => {
			if (savedDoc.uri.toString() === document.uri.toString() && editorState.isReady) {
				webview.postMessage({ type: 'project:dirtyState', isDirty: false, isNew: savedDoc.isUntitled });
			}
		});

		// Clean up when panel is disposed
		webviewPanel.onDidDispose(async () => {
			await this.stopMonitoring(webviewPanel);
			editorState.cachedStatuses = {};
			editorState.isDisposed = true;
			this.editorStates.delete(webviewPanel);
			changeDocumentSubscription.dispose();
			saveDocumentSubscription.dispose();
		});

		// Start monitoring immediately if connected
		if (this.connectionManager.isConnected()) {
			this.startMonitoring(webviewPanel).catch((error) => {
				this.logger.error(`Starting initial monitoring: ${error}`);
			});
		}
	}

	// =========================================================================
	// DOCUMENT I/O
	// =========================================================================

	private sendCanvasUpdate(webview: vscode.Webview, document: vscode.TextDocument): void {
		const text = document.getText();
		const parsed = PipelineFileParser.parseContent(text, document.uri.fsPath);
		if (!parsed.isValid) {
			return;
		}

		const enriched = this.enrichComponentNames(text);
		try {
			const project = JSON.parse(enriched);
			webview.postMessage({ type: 'project:update', project });
		} catch {
			// Invalid JSON — skip
		}
	}

	private enrichComponentNames(text: string): string {
		const cached = this.connectionManager.getCachedServices();
		const services = cached?.services;
		if (!services || Object.keys(services).length === 0) return text;

		const pipeline = JSON.parse(text);
		const components = pipeline.components as Array<{ provider: string; name?: string }> | undefined;
		if (!components) return text;

		let changed = false;
		for (const component of components) {
			if (!component.name) {
				const service = services[component.provider] as { title?: string } | undefined;
				if (service?.title) {
					component.name = service.title;
					changed = true;
				}
			}
		}

		return changed ? JSON.stringify(pipeline, null, 2) : text;
	}

	private toVerboseJson(content: string | Record<string, unknown>): string {
		const obj = typeof content === 'string' ? JSON.parse(content) : content;
		return JSON.stringify(obj, null, 2);
	}

	private async applyDocumentEdit(document: vscode.TextDocument, content: string): Promise<{ changed: boolean; applied: boolean }> {
		let normalizedNew: string;
		try {
			normalizedNew = this.toVerboseJson(content);
		} catch {
			normalizedNew = content;
		}
		const currentText = document.getText();
		let normalizedCurrent: string;
		try {
			normalizedCurrent = this.toVerboseJson(currentText);
		} catch {
			normalizedCurrent = currentText;
		}
		if (normalizedNew === normalizedCurrent) {
			return { changed: false, applied: false };
		}

		const edit = new vscode.WorkspaceEdit();
		const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(currentText.length));
		edit.replace(document.uri, fullRange, normalizedNew);
		const success = await vscode.workspace.applyEdit(edit);
		if (!success) {
			this.logger.error('[ProjectProvider] Failed to apply document edit');
		}
		return { changed: true, applied: success };
	}

	private async saveDocument(document: vscode.TextDocument, content: string | Record<string, unknown>): Promise<void> {
		const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
		const { changed, applied } = await this.applyDocumentEdit(document, contentStr);
		if (applied) {
			await document.save();
		} else if (changed) {
			vscode.window.showErrorMessage('Failed to save pipeline file');
		}
	}

	private extractPipelineIds(document: vscode.TextDocument): { projectId?: string; sourceId?: string } {
		try {
			const content = document.getText();
			const parsed = JSON.parse(content);
			return { projectId: parsed.project_id, sourceId: parsed.source };
		} catch {
			return { projectId: undefined, sourceId: undefined };
		}
	}

	// =========================================================================
	// PIPELINE EXECUTION
	// =========================================================================

	private async runPipeline(document: { pipeline: PipelineConfig }, name?: string): Promise<void> {
		try {
			const client = this.connectionManager.getClient();
			if (!client) throw new Error('Not connected to server');

			const project = document.pipeline;

			await client.use({
				pipeline: project,
				source: project.source,
				pipelineTraceLevel: 'full',
				args: ConfigManager.getInstance().getEngineArgs('development'),
				name,
			});
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to run pipeline: ${message}`);
		}
	}

	private async stopPipeline(componentId: string, document: vscode.TextDocument): Promise<void> {
		try {
			const client = this.connectionManager.getClient();
			if (!client) throw new Error('Not connected to server');

			const parsed = JSON.parse(document.getText());
			const projectId = parsed.project_id;

			if (!projectId || !componentId) {
				this.logger.error(`[ProjectProvider] Missing projectId or componentId`);
				vscode.window.showErrorMessage('Invalid pipeline: missing project ID or component ID');
				return;
			}

			const token = await client.getTaskToken({ projectId, source: componentId });

			if (!token) {
				this.logger.error('[ProjectProvider] No token found for running task');
				vscode.window.showErrorMessage('No running task found to stop');
				return;
			}

			await client.terminate(token);
		} catch (error: unknown) {
			this.logger.error(`[ProjectProvider] Unable to stop pipeline: ${error}`);
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to stop pipeline: ${message}`);
		}
	}

	// =========================================================================
	// OPEN LINK
	// =========================================================================

	/**
	 * Opens a URL in an embedded VS Code WebviewPanel with an iframe.
	 * Bridges theme colors, env vars, clipboard, and drag-and-drop to the iframe.
	 */
	private openLink(url: string, displayName?: string): void {
		const panel = vscode.window.createWebviewPanel('externalContent', displayName || 'Pipeline', vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});

		panel.webview.html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>body{margin:0;padding:0}iframe{width:100%;height:100vh;border:none}</style>
</head><body>
<iframe id="app-iframe" src="${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}" allow="clipboard-read; clipboard-write"></iframe>
<script>
(function() {
	const vscode = acquireVsCodeApi();
	const iframe = document.getElementById('app-iframe');
	const envVars = { devMode: true };
	let iframeOrigin = '*';
	try { iframeOrigin = new URL(iframe.src).origin; } catch(e) {}

	['dragenter', 'dragover'].forEach(eventName => {
		document.addEventListener(eventName, (e) => {
			e.preventDefault();
			e.stopPropagation();
			try { iframe.contentWindow.postMessage({ type: 'dragHover', x: e.clientX, y: e.clientY }, iframeOrigin); } catch(err) {}
		});
	});
	document.addEventListener('dragleave', (e) => {
		if (e.relatedTarget === null) {
			try { iframe.contentWindow.postMessage({ type: 'dragLeave' }, iframeOrigin); } catch(err) {}
		}
	});
	document.addEventListener('drop', async (e) => {
		e.preventDefault();
		e.stopPropagation();
		const files = e.dataTransfer && e.dataTransfer.files;
		if (!files || files.length === 0) return;
		const fileDataArray = [];
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			const buffer = await file.arrayBuffer();
			fileDataArray.push({ name: file.name, type: file.type || 'application/octet-stream', size: file.size, lastModified: file.lastModified, buffer: buffer });
		}
		try {
			iframe.contentWindow.postMessage({ type: 'bridgedFileDrop', files: fileDataArray }, iframeOrigin, fileDataArray.map(f => f.buffer));
			iframe.contentWindow.postMessage({ type: 'dragLeave' }, iframeOrigin);
		} catch (err) { console.error('[Parent] Error bridging file drop to iframe:', err); }
	});

	function getVSCodeThemeColors() {
		const style = getComputedStyle(document.body);
		const getColor = (varName, fallback = '') => { const value = style.getPropertyValue(varName).trim(); return value || fallback; };
		return {
			'--bg-primary': getColor('--vscode-editor-background'),
			'--bg-secondary': getColor('--vscode-sideBar-background'),
			'--bg-tertiary': getColor('--vscode-editorWidget-background'),
			'--bg-hover': getColor('--vscode-list-hoverBackground'),
			'--text-primary': getColor('--vscode-editor-foreground'),
			'--text-secondary': getColor('--vscode-descriptionForeground'),
			'--text-muted': getColor('--vscode-disabledForeground'),
			'--border-color': getColor('--vscode-panel-border'),
			'--border-hover': getColor('--vscode-focusBorder'),
			'--accent-primary': getColor('--vscode-focusBorder'),
			'--accent-secondary': getColor('--vscode-button-background'),
			'--accent-hover': getColor('--vscode-button-hoverBackground'),
			'--success-color': getColor('--vscode-terminal-ansiGreen'),
			'--error-color': getColor('--vscode-errorForeground'),
			'--warning-color': getColor('--vscode-editorWarning-foreground'),
			'--info-color': getColor('--vscode-editorInfo-foreground'),
			'--code-bg': getColor('--vscode-textCodeBlock-background'),
			'--input-bg': getColor('--vscode-input-background'),
			'--input-border': getColor('--vscode-input-border'),
			'--shadow-sm': getColor('--vscode-widget-shadow'),
			'--shadow-md': getColor('--vscode-widget-shadow'),
			'--shadow-lg': getColor('--vscode-widget-shadow')
		};
	}

	function sendDataToIframe() {
		const colors = getVSCodeThemeColors();
		try { iframe.contentWindow.postMessage({ type: 'vscodeData', env: envVars, theme: colors }, iframeOrigin); }
		catch (error) { console.error('[Parent] Error sending data to iframe:', error); }
	}

	window.addEventListener('message', (event) => {
		if (event.source === iframe.contentWindow) {
			if (event.data.type === 'view:ready') sendDataToIframe();
			if (event.data.type === 'requestPaste') vscode.postMessage({ type: 'requestPaste' });
			if (event.data.type === 'copyText' && event.data.text) vscode.postMessage({ type: 'copyText', text: event.data.text });
			if (event.data.type === 'requestFileDialog') vscode.postMessage({ type: 'requestFileDialog' });
		}
		const msg = event.data;
		if (msg.type === 'themeChanged') setTimeout(() => sendDataToIframe(), 50);
		if (msg.type === 'pasteContent' && msg.text && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'paste', text: msg.text }, iframeOrigin);
		if (msg.type === 'nativeFilesSelected' && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'nativeFilesSelected', files: msg.files }, iframeOrigin);
	});
})();
</script>
</body></html>`;

		// Bridge clipboard requests from the embedded iframe.  The chat-ui
		// (and any future embedded web app) cannot read the OS clipboard from
		// inside a VSCode webview iframe — VSCode intercepts native paste at
		// the Electron layer.  The iframe posts {type:'requestPaste'} up to
		// the bridge script, which forwards it here via vscode.postMessage;
		// we read the clipboard via the extension-host API and post the text
		// back to the webview, where the bridge relays it into the iframe.
		panel.webview.onDidReceiveMessage(async (msg) => {
			if (msg?.type === 'requestPaste') {
				const text = await vscode.env.clipboard.readText();
				panel.webview.postMessage({ type: 'pasteContent', text });
			} else if (msg?.type === 'copyText' && typeof msg.text === 'string') {
				await vscode.env.clipboard.writeText(msg.text);
			}
		});
	}

	// =========================================================================
	// HTML GENERATION
	// =========================================================================

	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-project.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');

			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			// Inject CSP meta tag allowing Stripe Elements (js.stripe.com for scripts/frames,
			// api.stripe.com for network calls). Required for the in-editor checkout flow.
			const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${webview.cspSource} https://js.stripe.com; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource} data:; frame-src https://js.stripe.com; connect-src ${webview.cspSource} https://api.stripe.com; img-src ${webview.cspSource} data:;">`;
			htmlContent = htmlContent.replace('<head>', `<head>\n\t${cspMeta}`);

			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			this.logger.error(`Error loading project editor HTML: ${error}`);
			return `<!DOCTYPE html>
            <html><body style="padding:20px;color:#f44336;">
                <h3>Error Loading Project Editor</h3>
                <p>${error}</p>
                <p>Run <code>pnpm run build:webview</code> to build the webview.</p>
                <p>Expected: <code>${htmlPath.fsPath}</code></p>
            </body></html>`;
		}
	}

	private generateNonce(): string {
		let text = '';
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}

	// =========================================================================
	// DISPOSAL
	// =========================================================================

	public dispose(): void {
		this.voiceCaptureServer?.close();
		this.voiceCaptureServer = undefined;
		this.voiceCapturePort = undefined;
		this.disposables.forEach((disposable) => disposable.dispose());
		this.disposables = [];
	}
}
