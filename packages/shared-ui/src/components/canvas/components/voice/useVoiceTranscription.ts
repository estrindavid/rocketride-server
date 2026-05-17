// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';

type DeepgramToken = { key: string };

type DeepgramTranscriptMessage = {
	type?: string;
	is_final?: boolean;
	speech_final?: boolean;
	channel?: {
		alternatives?: Array<{
			transcript?: string;
		}>;
	};
};

export type VoiceTranscriptionSpeed = 'fast' | 'normal' | 'slow';

export interface IUseVoiceTranscriptionOptions {
	getTranscriptionToken: () => Promise<DeepgramToken>;
	onUtterance: (utterance: string) => void;
	onError?: (message: string) => void;
	speed?: VoiceTranscriptionSpeed;
}

export interface IVoiceTranscriptionState {
	isListening: boolean;
	isStarting: boolean;
	interimTranscript: string;
	finalTranscript: string;
	error: string | null;
	start: () => Promise<void>;
	stop: () => void;
	reset: () => void;
}

const DEEPGRAM_LISTEN_URL = 'wss://api.deepgram.com/v1/listen';

const SILENCE_MS: Record<VoiceTranscriptionSpeed, number> = {
	fast: 700,
	normal: 1200,
	slow: 1800,
};

function normalizeTranscript(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function createDeepgramUrl(): string {
	const url = new URL(DEEPGRAM_LISTEN_URL);
	url.searchParams.set('model', 'nova-2');
	url.searchParams.set('language', 'en-US');
	url.searchParams.set('interim_results', 'true');
	url.searchParams.set('smart_format', 'true');
	url.searchParams.set('utterance_end_ms', '1000');
	url.searchParams.set('endpointing', '300');
	return url.toString();
}

function pickMimeType(): string | undefined {
	if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return undefined;
	const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
	return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function describeStartError(err: unknown): string {
	if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
		return 'Microphone permission denied. Enable microphone access for Visual Studio Code in macOS System Settings > Privacy & Security > Microphone, then fully quit and reopen VS Code.';
	}

	if (err instanceof Error && /permission denied|notallowed/i.test(err.message)) {
		return 'Microphone permission denied. Enable microphone access for Visual Studio Code in macOS System Settings > Privacy & Security > Microphone, then fully quit and reopen VS Code.';
	}

	return err instanceof Error ? err.message : 'Unable to start voice transcription';
}

export function useVoiceTranscription({ getTranscriptionToken, onUtterance, onError, speed = 'normal' }: IUseVoiceTranscriptionOptions): IVoiceTranscriptionState {
	const [isListening, setIsListening] = useState(false);
	const [isStarting, setIsStarting] = useState(false);
	const [interimTranscript, setInterimTranscript] = useState('');
	const [finalTranscript, setFinalTranscript] = useState('');
	const [error, setError] = useState<string | null>(null);

	const socketRef = useRef<WebSocket | null>(null);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const sessionRef = useRef(0);
	const finalTranscriptRef = useRef('');
	const interimTranscriptRef = useRef('');
	const getTranscriptionTokenRef = useRef(getTranscriptionToken);
	const onUtteranceRef = useRef(onUtterance);
	const onErrorRef = useRef(onError);

	useEffect(() => {
		getTranscriptionTokenRef.current = getTranscriptionToken;
	}, [getTranscriptionToken]);

	useEffect(() => {
		onUtteranceRef.current = onUtterance;
	}, [onUtterance]);

	useEffect(() => {
		onErrorRef.current = onError;
	}, [onError]);

	const clearSilenceTimer = useCallback(() => {
		if (silenceTimerRef.current) {
			clearTimeout(silenceTimerRef.current);
			silenceTimerRef.current = null;
		}
	}, []);

	const publishError = useCallback((message: string) => {
		setError(message);
		onErrorRef.current?.(message);
	}, []);

	const flushUtterance = useCallback(() => {
		const text = normalizeTranscript(`${finalTranscriptRef.current} ${interimTranscriptRef.current}`);
		finalTranscriptRef.current = '';
		interimTranscriptRef.current = '';
		setFinalTranscript('');
		setInterimTranscript('');
		if (text) onUtteranceRef.current(text);
	}, []);

	const scheduleSilenceFlush = useCallback(() => {
		clearSilenceTimer();
		silenceTimerRef.current = setTimeout(() => {
			flushUtterance();
		}, SILENCE_MS[speed]);
	}, [clearSilenceTimer, flushUtterance, speed]);

	const teardown = useCallback(() => {
		clearSilenceTimer();

		const recorder = recorderRef.current;
		recorderRef.current = null;
		if (recorder && recorder.state !== 'inactive') {
			try {
				recorder.stop();
			} catch {
				// MediaRecorder can already be stopping after permission or websocket errors.
			}
		}

		const socket = socketRef.current;
		socketRef.current = null;
		if (socket && socket.readyState === WebSocket.OPEN) socket.close();
		else if (socket && socket.readyState === WebSocket.CONNECTING) socket.close();

		const stream = streamRef.current;
		streamRef.current = null;
		stream?.getTracks().forEach((track) => track.stop());

		setIsListening(false);
		setIsStarting(false);
	}, [clearSilenceTimer]);

	const reset = useCallback(() => {
		finalTranscriptRef.current = '';
		interimTranscriptRef.current = '';
		setFinalTranscript('');
		setInterimTranscript('');
		setError(null);
	}, []);

	const stop = useCallback(() => {
		sessionRef.current += 1;
		flushUtterance();
		teardown();
	}, [flushUtterance, teardown]);

	const start = useCallback(async () => {
		if (isStarting || isListening) return;

		const session = sessionRef.current + 1;
		sessionRef.current = session;
		reset();
		setIsStarting(true);

		try {
			if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
				throw new Error('Microphone capture is not available in this environment');
			}
			if (typeof WebSocket === 'undefined') throw new Error('Live transcription websocket is not available');
			if (typeof MediaRecorder === 'undefined') throw new Error('Microphone recording is not available');

			const [{ key }, stream] = await Promise.all([
				getTranscriptionTokenRef.current(),
				navigator.mediaDevices.getUserMedia({
					audio: {
						echoCancellation: true,
						noiseSuppression: true,
						autoGainControl: true,
					},
				}),
			]);

			if (sessionRef.current !== session) {
				stream.getTracks().forEach((track) => track.stop());
				return;
			}

			const mimeType = pickMimeType();
			const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
			const socket = new WebSocket(createDeepgramUrl(), ['token', key]);

			streamRef.current = stream;
			recorderRef.current = recorder;
			socketRef.current = socket;

			recorder.ondataavailable = (event: BlobEvent) => {
				if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
					socket.send(event.data);
				}
			};

			socket.onopen = () => {
				if (sessionRef.current !== session) return;
				recorder.start(250);
				setIsListening(true);
				setIsStarting(false);
			};

			socket.onmessage = (event: MessageEvent<string>) => {
				if (sessionRef.current !== session) return;

				let message: DeepgramTranscriptMessage;
				try {
					message = JSON.parse(event.data) as DeepgramTranscriptMessage;
				} catch {
					return;
				}

				if (message.type === 'UtteranceEnd') {
					flushUtterance();
					return;
				}

				const transcript = normalizeTranscript(message.channel?.alternatives?.[0]?.transcript ?? '');
				if (!transcript) return;

				if (message.is_final) {
					finalTranscriptRef.current = normalizeTranscript(`${finalTranscriptRef.current} ${transcript}`);
					interimTranscriptRef.current = '';
					setFinalTranscript(finalTranscriptRef.current);
					setInterimTranscript('');
					if (message.speech_final) flushUtterance();
					else scheduleSilenceFlush();
				} else {
					interimTranscriptRef.current = transcript;
					setInterimTranscript(transcript);
					scheduleSilenceFlush();
				}
			};

			socket.onerror = () => {
				if (sessionRef.current !== session) return;
				publishError('Live transcription connection failed');
				teardown();
			};

			socket.onclose = () => {
				if (sessionRef.current !== session) return;
				setIsListening(false);
				setIsStarting(false);
			};
		} catch (err) {
			if (sessionRef.current !== session) return;
			teardown();
			publishError(describeStartError(err));
		}
	}, [flushUtterance, isListening, isStarting, publishError, reset, scheduleSilenceFlush, teardown]);

	useEffect(() => {
		return () => {
			sessionRef.current += 1;
			teardown();
		};
	}, [teardown]);

	return {
		isListening,
		isStarting,
		interimTranscript,
		finalTranscript,
		error,
		start,
		stop,
		reset,
	};
}
