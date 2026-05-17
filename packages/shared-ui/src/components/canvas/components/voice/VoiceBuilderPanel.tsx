// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import { CSSProperties, ReactElement } from 'react';
import { Loader2, Mic, MicOff, RotateCcw, Undo2, X } from 'lucide-react';

export interface IVoiceBuilderPanelProps {
	isListening: boolean;
	isStarting: boolean;
	isApplying: boolean;
	interimTranscript: string;
	finalTranscript: string;
	error: string | null;
	applySummary?: string | null;
	configErrors?: string[];
	appliedCount: number;
	canRevertLastEdit: boolean;
	utterances: string[];
	onToggleListening: () => void;
	onReset: () => void;
	onRevertLastEdit: () => void;
	onClose: () => void;
}

const iconButton: CSSProperties = {
	width: 28,
	height: 28,
	padding: 4,
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	border: 'none',
	borderRadius: 6,
	background: 'transparent',
	color: 'var(--rr-text-secondary)',
	cursor: 'pointer',
};

const styles = {
	panel: {
		position: 'absolute',
		top: 12,
		left: 12,
		zIndex: 1300,
		width: 330,
		maxWidth: 'calc(100% - 24px)',
		backgroundColor: 'var(--rr-bg-widget)',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		boxShadow: '0 8px 24px rgba(0,0,0,0.22)',
		color: 'var(--rr-text-primary)',
		fontFamily: 'var(--rr-font-family)',
		overflow: 'hidden',
	} as CSSProperties,
	header: {
		height: 40,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '0 8px 0 12px',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,
	status: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		fontSize: 'var(--rr-font-size-widget)',
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	dot: {
		width: 8,
		height: 8,
		borderRadius: 99,
		backgroundColor: 'var(--rr-text-disabled)',
		flexShrink: 0,
	} as CSSProperties,
	actions: {
		display: 'flex',
		alignItems: 'center',
		gap: 2,
	} as CSSProperties,
	body: {
		display: 'flex',
		flexDirection: 'column',
		gap: 8,
		padding: 12,
	} as CSSProperties,
	transcript: {
		minHeight: 72,
		maxHeight: 150,
		overflow: 'auto',
		padding: 10,
		borderRadius: 6,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-default)',
		fontSize: 'var(--rr-font-size-widget)',
		lineHeight: 1.45,
		whiteSpace: 'pre-wrap',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	placeholder: {
		color: 'var(--rr-text-disabled)',
	} as CSSProperties,
	utterance: {
		padding: '7px 9px',
		borderRadius: 6,
		backgroundColor: 'color-mix(in srgb, var(--rr-brand) 10%, transparent)',
		fontSize: 'var(--rr-font-size-widget)',
		lineHeight: 1.35,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	error: {
		padding: '7px 9px',
		borderRadius: 6,
		backgroundColor: 'color-mix(in srgb, var(--rr-color-error) 14%, transparent)',
		color: 'var(--rr-color-error)',
		fontSize: 'var(--rr-font-size-widget)',
		lineHeight: 1.35,
		whiteSpace: 'pre-wrap',
	} as CSSProperties,
	summary: {
		padding: '7px 9px',
		borderRadius: 6,
		backgroundColor: 'color-mix(in srgb, var(--rr-brand) 12%, transparent)',
		color: 'var(--rr-text-primary)',
		fontSize: 'var(--rr-font-size-widget)',
		lineHeight: 1.35,
	} as CSSProperties,
	footer: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 8,
		paddingTop: 2,
	} as CSSProperties,
	counter: {
		fontSize: 'var(--rr-font-size-small)',
		color: 'var(--rr-text-disabled)',
	} as CSSProperties,
};

function statusLabel(isStarting: boolean, isListening: boolean, isApplying: boolean): string {
	if (isApplying) return 'Applying';
	if (isStarting) return 'Starting';
	if (isListening) return 'Listening';
	return 'Ready';
}

export default function VoiceBuilderPanel({ isListening, isStarting, isApplying, interimTranscript, finalTranscript, error, applySummary, configErrors = [], appliedCount, canRevertLastEdit, utterances, onToggleListening, onReset, onRevertLastEdit, onClose }: IVoiceBuilderPanelProps): ReactElement {
	const activeText = finalTranscript || interimTranscript;
	const status = statusLabel(isStarting, isListening, isApplying);
	const latestUtterances = utterances.slice(-3).reverse();
	const visibleError = error ?? configErrors[0] ?? null;

	return (
		<div style={styles.panel}>
			<div style={styles.header}>
				<div style={styles.status}>
					<span
						style={{
							...styles.dot,
							backgroundColor: isListening ? 'var(--rr-brand)' : isStarting || isApplying ? 'var(--rr-color-warning)' : 'var(--rr-text-disabled)',
						}}
					/>
					<span>{status}</span>
				</div>
				<div style={styles.actions}>
					<button type="button" title={isListening || isStarting ? 'Stop listening' : 'Start listening'} onClick={onToggleListening} disabled={isStarting} style={{ ...iconButton, color: isListening ? 'var(--rr-brand)' : 'var(--rr-text-secondary)', opacity: isStarting ? 0.6 : 1 }}>
						{isStarting ? <Loader2 size={16} /> : isListening ? <MicOff size={16} /> : <Mic size={16} />}
					</button>
					<button type="button" title="Clear transcript" onClick={onReset} style={iconButton}>
						<RotateCcw size={16} />
					</button>
					<button type="button" title="Close" onClick={onClose} style={iconButton}>
						<X size={16} />
					</button>
				</div>
			</div>
			<div style={styles.body}>
				<div style={styles.transcript}>{activeText ? activeText : <span style={styles.placeholder}>Voice ready</span>}</div>
				{visibleError && <div style={styles.error}>{visibleError}</div>}
				{applySummary && !visibleError && <div style={styles.summary}>{applySummary}</div>}
				{latestUtterances.map((utterance, index) => (
					<div key={`${index}-${utterance}`} style={styles.utterance}>
						{utterance}
					</div>
				))}
				<div style={styles.footer}>
					<span style={styles.counter}>{appliedCount} applied</span>
					<button type="button" title="Revert last voice edit" onClick={onRevertLastEdit} disabled={!canRevertLastEdit || isApplying} style={{ ...iconButton, opacity: canRevertLastEdit && !isApplying ? 1 : 0.4, cursor: canRevertLastEdit && !isApplying ? 'pointer' : 'default' }}>
						<Undo2 size={16} />
					</button>
				</div>
			</div>
		</div>
	);
}
