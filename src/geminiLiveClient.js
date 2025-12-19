import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import {
  EndSensitivity,
  GoogleGenAI,
  Modality,
  StartSensitivity,
  VadSignalType,
} from '@google/genai';
import { pcmu8ToPcm16_16k } from './audio/codec.js';
import { resamplePcm16Best } from './audio/resample.js';
import {
  initDspState,
  pcm16ToFloat32,
  float32ToPcm16,
  processForTelephony,
} from './audio/dsp.js';
import {
  getTwilioFrameBytes,
  getTwilioSampleRate,
  pcm16ToMulaw,
} from './audio/mulaw.js';

const DEFAULT_AUDIO_INPUT_MIME_TYPE = 'audio/pcm;rate=16000';
const DEFAULT_AUDIO_OUTPUT_MIME_TYPE = 'audio/pcm;rate=24000';
const DEFAULT_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const DEFAULT_VOICE = 'Puck';
const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com';
const DEFAULT_WS_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService/BidiGenerateContent';
const DEBUG_GEMINI_EVENTS = process.env.DEBUG_GEMINI_EVENTS === 'true';
const DEBUG_GEMINI_SESSION = process.env.DEBUG_GEMINI_SESSION !== 'false';
const DEBUG_AUDIO_STATS = process.env.DEBUG_AUDIO_STATS !== 'false';
const FORWARD_GEMINI_AUDIO = process.env.GEMINI_FORWARD_AUDIO_TO_TWILIO !== 'false';
const DEFAULT_OUTPUT_SAMPLE_RATE = 24000;
const TWILIO_SAMPLE_RATE = getTwilioSampleRate();

function parseSampleRate(mimeType) {
  if (!mimeType) return null;
  const match = String(mimeType).match(/rate=([0-9]+)/i);
  if (match && match[1]) {
    const rate = Number(match[1]);
    if (!Number.isNaN(rate) && rate > 0) return rate;
  }
  return null;
}

function normalizeBaseUrl(rawBaseUrl) {
  if (!rawBaseUrl) return undefined;
  return rawBaseUrl.endsWith('/') ? rawBaseUrl.slice(0, -1) : rawBaseUrl;
}

function joinUrl(base, path) {
  const baseClean = typeof base === 'string' ? base.replace(/\/+$/, '') : '';
  if (!path) return baseClean;
  const pathClean = path.startsWith('/') ? path : `/${path}`;
  return `${baseClean}${pathClean}`;
}

function cleanEnv(value) {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : undefined;
}

function previewText(text = '', maxLength = 80) {
  if (!text) return '';
  const compact = String(text).replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

function normalizeCloseReason(reason) {
  if (!reason) return 'none';
  if (typeof reason === 'string') return reason || 'none';
  if (reason instanceof Buffer) {
    const decoded = reason.toString('utf8');
    return decoded || 'none';
  }
  if (typeof reason === 'object' && reason?.reason) {
    return reason.reason;
  }
  return 'unknown';
}

function base64Bytes(value) {
  if (!value || typeof value !== 'string') return 0;
  try {
    return Buffer.from(value, 'base64').length;
  } catch (err) {
    return 0;
  }
}

function isLikelyBase64Audio(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length <= 100) return false;
  if (trimmed.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(trimmed)) return false;
  return true;
}

function bufferFromData(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function buildWsUrl(endpoint, apiKey) {
  if (!apiKey) {
    throw new Error('[Gemini] GEMINI_API_KEY missing; cannot build WebSocket URL');
  }
  const normalized = normalizeBaseUrl(endpoint || DEFAULT_ENDPOINT) || DEFAULT_ENDPOINT;
  const protocolNormalized = normalized.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  const path = DEFAULT_WS_PATH.startsWith('/') ? DEFAULT_WS_PATH : `/${DEFAULT_WS_PATH}`;
  const url = joinUrl(protocolNormalized, path);
  return `${url}?key=${encodeURIComponent(apiKey)}`;
}

class GeminiLiveClient extends EventEmitter {
  constructor(
    session,
    {
      audioMimeType = DEFAULT_AUDIO_INPUT_MIME_TYPE,
      greetingText,
      traceId,
      model,
      endpoint,
      voiceName,
      callSid,
      debugEvents = DEBUG_GEMINI_EVENTS,
      debugSession = DEBUG_GEMINI_SESSION,
      debugAudioStats = DEBUG_AUDIO_STATS,
    } = {}
  ) {
    super();
    this.session = session;
    this.audioMimeType = audioMimeType || DEFAULT_AUDIO_INPUT_MIME_TYPE;
    this.textBuffer = '';
    this.greetingText = greetingText;
    this.traceId = traceId || 'unknown';
    this.model = model || DEFAULT_MODEL;
    this.endpoint = endpoint;
    this.voiceName = voiceName || DEFAULT_VOICE;
    this.callSid = callSid || null;
    this.debugEvents = debugEvents;
    this.debugSession = debugSession;
    this.debugAudioStats = debugAudioStats;
    this.sentAudioFrames = 0;
    this.sentAudioBytes = 0;
    this.receivedAudioDeltas = 0;
    this.receivedAudioBytes = 0;
    this.sentToTwilioAudioFrames = 0;
    this.sentToTwilioAudioBytes = 0;
    this.audioInBuffer = Buffer.alloc(0);
    this.audio8kBuffer = Buffer.alloc(0);
    this.dspState = initDspState();
    this.inputFormatLogged = false;
    this.lastEventType = 'none';
    this.sessionInitSent = true;
    this.sessionAcked = false;
    this.connectedAtMs = null;
    this.closedAtMs = null;
    this.loggedSocketClosedSkip = false;
    this.loggedNotReadySkip = false;
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
  }

  log(level, message, meta) {
    const prefix = `[Gemini][trace=${this.traceId}]`;
    const line = `${prefix} ${message}`;
    const metaWithCall = meta && typeof meta === 'object'
      ? { ...meta, callSid: meta.callSid || this.callSid || null }
      : meta;
    if (metaWithCall !== undefined) {
      if (level === 'error') {
        console.error(line, metaWithCall);
      } else if (level === 'warn') {
        console.warn(line, metaWithCall);
      } else {
        console.log(line, metaWithCall);
      }
    } else if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  getStats() {
    return {
      sentAudioFrames: this.sentAudioFrames,
      sentAudioBytes: this.sentAudioBytes,
      receivedAudioDeltas: this.receivedAudioDeltas,
      receivedAudioBytes: this.receivedAudioBytes,
      sentToTwilioAudioFrames: this.sentToTwilioAudioFrames,
      sentToTwilioAudioBytes: this.sentToTwilioAudioBytes,
      lastEventType: this.lastEventType,
      sessionAcked: this.sessionAcked,
      closedAtMs: this.closedAtMs,
      connectedAtMs: this.connectedAtMs,
    };
  }

  markConnected(ts = Date.now()) {
    this.connectedAtMs = ts;
    if (this.debugSession) {
      this.log('log', '[session] WebSocket open', {
        connectedAt: new Date(ts).toISOString(),
        model: this.model,
        endpoint: this.endpoint || 'default',
        audioInput: this.audioMimeType,
        audioOutput: DEFAULT_AUDIO_OUTPUT_MIME_TYPE,
        voice: this.voiceName,
      });
    }
  }

  markReady() {
    if (this._resolveReady) {
      this._resolveReady(true);
      this._resolveReady = null;
    }
    if (this.greetingText) {
      this.sendTextPrompt(
        `Start the call by saying exactly: "${this.greetingText}" Then stop and wait for the caller's answer before saying anything else.`
      );
    }
  }

  handleClose(code, reason) {
    this.closedAtMs = Date.now();
    const durationMs = this.connectedAtMs ? this.closedAtMs - this.connectedAtMs : null;
    this.log('log', '[close] Gemini socket closed', {
      code,
      reason: normalizeCloseReason(reason),
      durationMs,
      sentAudioFrames: this.sentAudioFrames,
      sentAudioBytes: this.sentAudioBytes,
      receivedAudioDeltas: this.receivedAudioDeltas,
      receivedAudioBytes: this.receivedAudioBytes,
      sentToTwilioAudioFrames: this.sentToTwilioAudioFrames,
      sentToTwilioAudioBytes: this.sentToTwilioAudioBytes,
      lastEventType: this.lastEventType,
      sessionInitSent: this.sessionInitSent,
      sessionAcked: this.sessionAcked,
    });
    this.emit('close', { code, reason });
  }

  handleWsError(err) {
    this.lastEventType = 'ws-error';
    this.log('error', '[ws-error] Gemini socket error', {
      message: err?.message,
      stack: err?.stack,
    });
  }

  handleGeminiAudioBytes(pcmBuffer, sourceRate = DEFAULT_OUTPUT_SAMPLE_RATE) {
    try {
      const bytes = pcmBuffer?.length || 0;
      if (!bytes) return;
      this.lastEventType = 'audio.binary';
      this.receivedAudioDeltas += 1;
      this.receivedAudioBytes += bytes;
      if (this.debugAudioStats) {
        this.log('log', '[audio-out] frame accepted', {
          bytes,
          forwarded: FORWARD_GEMINI_AUDIO,
          sampleRate: sourceRate,
        });
      }

      if (!FORWARD_GEMINI_AUDIO) {
        return;
      }

      const rate = Number(sourceRate) > 0 ? Number(sourceRate) : DEFAULT_OUTPUT_SAMPLE_RATE;
      const neededInputBytes = Math.max(2, Math.ceil((getTwilioFrameBytes() * rate) / TWILIO_SAMPLE_RATE) * 2);
      this.audioInBuffer = Buffer.concat([this.audioInBuffer, pcmBuffer]);

      if (!this.inputFormatLogged) {
        this.inputFormatLogged = true;
        this.log('log', '[audio-out] input format detected', {
          sampleRate: rate,
          channels: 1,
          codec: 'pcm16le',
          forwarding: FORWARD_GEMINI_AUDIO,
        });
      }

      while (this.audioInBuffer.length >= neededInputBytes) {
        const processLen = Math.min(this.audioInBuffer.length - (this.audioInBuffer.length % 2), neededInputBytes * 10);
        const chunk = this.audioInBuffer.subarray(0, processLen);
        this.audioInBuffer = this.audioInBuffer.subarray(processLen);

        const floatChunk = pcm16ToFloat32(chunk);
        processForTelephony(floatChunk, rate, this.dspState);
        const processedPcm = float32ToPcm16(floatChunk);

        const pcm8k = resamplePcm16Best(processedPcm, rate, TWILIO_SAMPLE_RATE);
        if (!pcm8k?.length) continue;

        this.audio8kBuffer = Buffer.concat([this.audio8kBuffer, pcm8k]);

        const pcmFrameBytes = getTwilioFrameBytes() * 2; // 160 samples * 2 bytes
        while (this.audio8kBuffer.length >= pcmFrameBytes) {
          const framePcm = this.audio8kBuffer.subarray(0, pcmFrameBytes);
          this.audio8kBuffer = this.audio8kBuffer.subarray(pcmFrameBytes);
          const mulawFrame = pcm16ToMulaw(framePcm);
          if (!mulawFrame?.length) continue;
          const payload = mulawFrame.toString('base64');
          this.sentToTwilioAudioFrames += 1;
          this.sentToTwilioAudioBytes += mulawFrame.length;
          this.emit('audio.delta', { chunk: payload });
        }
      }
    } catch (err) {
      this.log('warn', '[audio-out] failed to process Gemini audio bytes', { error: err?.message });
    }
  }

  handleMessage(rawMessage) {
    const dataField = rawMessage?.data ?? rawMessage;
    const isBinary = rawMessage?.isBinary === true || rawMessage?.binary === true;
    const binaryCandidate = bufferFromData(dataField) || bufferFromData(rawMessage);
    if (binaryCandidate && (isBinary || Buffer.isBuffer(dataField) || Buffer.isBuffer(rawMessage))) {
      this.handleGeminiAudioBytes(binaryCandidate, DEFAULT_OUTPUT_SAMPLE_RATE);
      return;
    }

    let message = null;
    const textPayload =
      typeof dataField === 'string'
        ? dataField
        : typeof rawMessage === 'string'
          ? rawMessage
          : typeof rawMessage?.data === 'string'
            ? rawMessage.data
            : null;

    if (typeof textPayload === 'string') {
      const trimmed = textPayload.trim();
      const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
      if (looksJson) {
        try {
          message = JSON.parse(trimmed);
        } catch (err) {
          this.log('warn', '[event=parse-error] Failed to parse Gemini message', { error: err?.message });
          return;
        }
      } else if (isLikelyBase64Audio(trimmed)) {
        try {
          const pcmBuf = Buffer.from(trimmed, 'base64');
          this.handleGeminiAudioBytes(pcmBuf, DEFAULT_OUTPUT_SAMPLE_RATE);
        } catch (err) {
          if (this.debugEvents) {
            this.log('warn', '[audio-out] failed to decode base64 audio', { error: err?.message });
          }
        }
        return;
      } else {
        if (this.debugEvents) {
          this.log('log', '[event=unknown] non-JSON text frame ignored', { preview: previewText(trimmed, 48) });
        }
        return;
      }
    } else if (rawMessage && typeof rawMessage === 'object' && !Buffer.isBuffer(rawMessage)) {
      message = rawMessage;
    }

    if (!message || typeof message !== 'object') {
      if (this.debugEvents) {
        this.log('log', '[event=unknown] Gemini message ignored', { messageType: typeof message });
      }
      return;
    }

    try {
      const { serverContent, toolCall, voiceActivityDetectionSignal, error: topLevelError } = message || {};
      const eventType =
        message?.type ||
        message?.event ||
        serverContent?.eventType ||
        (voiceActivityDetectionSignal ? 'voice_activity' : 'message') ||
        'unknown';
      this.lastEventType = eventType || 'unknown';
      this.sessionAcked = this.sessionAcked || !!message;

      if (voiceActivityDetectionSignal?.vadSignalType === VadSignalType.VAD_SIGNAL_TYPE_SOS) {
        this.log('log', '[event=vad_start] Start of speech detected');
        this.emit('user.start');
      }
      if (voiceActivityDetectionSignal?.vadSignalType === VadSignalType.VAD_SIGNAL_TYPE_EOS) {
        this.log('log', '[event=vad_end] End of speech detected');
      }

      const inlineAudioParts =
        serverContent?.modelTurn?.parts?.filter((p) => p.inlineData?.data && p.inlineData?.mimeType?.startsWith('audio/')) ||
        [];
      const audioDeltaBytes = inlineAudioParts.reduce((sum, part) => sum + base64Bytes(part.inlineData.data), 0);
      const transcriptText =
        serverContent?.inputTranscription?.text ||
        serverContent?.outputTranscription?.text ||
        serverContent?.modelTurn?.parts?.map((p) => p.text).join('') ||
        '';

      if (this.debugEvents) {
        this.log('log', `[event=${this.lastEventType}] Gemini message`, {
          audioDeltaBytes,
          transcriptLength: transcriptText ? transcriptText.length : 0,
          hasToolCalls: !!(serverContent?.modelTurn?.parts?.some((p) => p.functionCall) || toolCall?.functionCalls?.length),
          hasError: !!(topLevelError || serverContent?.error),
        });
        if (!inlineAudioParts.length) {
          this.log('log', '[event=debug] Gemini payload (no inline audio)', { message });
        }
      }

      if (topLevelError || serverContent?.error) {
        this.log('error', '[event=error] Gemini error payload', {
          error: topLevelError || serverContent?.error,
        });
      }

      if (serverContent?.inputTranscription?.text) {
        const inputText = serverContent.inputTranscription.text;
        if (this.debugEvents) {
          this.log('log', '[event=transcript.partial]', { text: inputText });
        }
        if (serverContent.inputTranscription.finished && inputText) {
          this.emit('transcript.completed', { text: inputText });
          this.log('log', '[event=transcript.final]', { text: inputText });
        }
      }

      if (serverContent?.outputTranscription?.text) {
        this.textBuffer += serverContent.outputTranscription.text;
        this.emit('text.delta', { text: serverContent.outputTranscription.text });
        if (this.debugEvents) {
          this.log('log', '[event=text.delta]', { length: serverContent.outputTranscription.text.length });
        }
      }

      if (serverContent?.modelTurn?.parts?.length) {
        for (const part of serverContent.modelTurn.parts) {
          if (part.text) {
            this.textBuffer += part.text;
            this.emit('text.delta', { text: part.text });
            if (this.debugEvents) {
              this.log('log', '[event=text.delta]', { length: part.text.length });
            }
          }

          if (part.inlineData?.data && part.inlineData?.mimeType?.startsWith('audio/')) {
            try {
              const pcmBuffer = Buffer.from(part.inlineData.data, 'base64');
              const rate = parseSampleRate(part.inlineData.mimeType) || DEFAULT_OUTPUT_SAMPLE_RATE;
              this.handleGeminiAudioBytes(pcmBuffer, rate);
            } catch (err) {
              this.log('warn', '[audio-out] failed to decode inline audio', { error: err?.message });
            }
          }

          if (part.functionCall) {
            const argsJsonString = JSON.stringify(part.functionCall.args || {});
            const deltaSize = argsJsonString.length;
            this.log('log', `[TOOL][${part.functionCall.name || 'unknown'}] delta`, {
              callId: part.functionCall.id || null,
              deltaSize,
            });
            this.emit('tool.call', {
              name: part.functionCall.name || 'unknown',
              callId: part.functionCall.id || null,
              argumentsJsonString: argsJsonString,
            });
          }
        }
      }

      if (toolCall?.functionCalls?.length) {
        for (const fnCall of toolCall.functionCalls) {
          const argsJsonString = JSON.stringify(fnCall.args || {});
          const deltaSize = argsJsonString.length;
          this.log('log', `[TOOL][${fnCall.name || 'unknown'}] delta`, {
            callId: fnCall.id || null,
            deltaSize,
          });
          this.emit('tool.call', {
            name: fnCall.name || 'unknown',
            callId: fnCall.id || null,
            argumentsJsonString: argsJsonString,
          });
        }
      }

      if (serverContent?.interrupted) {
        this.log('log', '[event=response.interrupted]');
        this.emit('response.interrupted');
      }

      if (serverContent?.turnComplete || serverContent?.generationComplete) {
        if (this.textBuffer.trim()) {
          this.emit('text.done', { text: this.textBuffer.trim() });
        }
        this.textBuffer = '';
        this.emit('response.complete');
        this.log('log', '[event=response.complete]');
      }
    } catch (err) {
      this.log('warn', '[event=handle-error] Gemini message handling failed', { error: err?.message });
    }
  }

  async sendAudioChunk(base64Pcmu) {
    if (!base64Pcmu) return;
    try {
      await this.ready;
      if (this.closedAtMs) {
        if (!this.loggedSocketClosedSkip) {
          this.loggedSocketClosedSkip = true;
          this.log('warn', '[audio] skipping: socket already closed');
        }
        return;
      }
      if (!this.sessionAcked) {
        if (!this.loggedNotReadySkip) {
          this.loggedNotReadySkip = true;
          this.log('warn', '[audio] skipping: session not yet acked');
        }
        return;
      }
      const muLawBuffer = Buffer.from(base64Pcmu, 'base64');
      const pcm16_16k = pcmu8ToPcm16_16k(muLawBuffer);
      this.sentAudioFrames += 1;
      this.sentAudioBytes += pcm16_16k.length;
      if (this.debugAudioStats) {
        this.log('log', '[audio] sending chunk', {
          frame: this.sentAudioFrames,
          bytes: pcm16_16k.length,
        });
      }
      this.session.sendRealtimeInput({
        audio: {
          data: pcm16_16k.toString('base64'),
          mimeType: this.audioMimeType,
        },
      });
    } catch (err) {
      console.error('[Gemini] failed to send audio chunk', err);
      this.emit('error', err);
    }
  }

  cancelResponse() {
    try {
      this.session.sendClientContent({ turnComplete: true });
      this.lastEventType = 'response.cancel';
      this.log('log', '[event=response.cancel] cancelResponse invoked');
    } catch (err) {
      console.error('[Gemini] failed to cancel response', err);
    }
  }

  sendToolResponse({ callId, name, response }) {
    try {
      this.session.sendToolResponse({
        functionResponses: [
          {
            id: callId || undefined,
            name,
            response: response || {},
          },
        ],
      });
    } catch (err) {
      console.error('[Gemini] failed to send tool response', err);
    }
  }

  sendTextPrompt(text) {
    if (!text) return;
    try {
      this.session.sendClientContent({
        turns: text,
        turnComplete: true,
      });
    } catch (err) {
      console.error('[Gemini] failed to send text prompt', err);
    }
  }

  close() {
    try {
      this.session.close();
    } catch (err) {
      console.error('[Gemini] failed to close session', err);
    }
  }
}

export async function connectGeminiLive({
  instructions,
  voice,
  audioFormat,
  tools,
  greetingText,
  callSid,
  callTraceId,
  restaurantId,
  model = process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL,
  endpoint = process.env.GEMINI_LIVE_ENDPOINT || DEFAULT_ENDPOINT,
} = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('[Gemini] GEMINI_API_KEY missing; cannot connect to Gemini Live.');
  }

  const resolvedModel = cleanEnv(model) || DEFAULT_MODEL;
  const resolvedEndpoint = cleanEnv(endpoint) || DEFAULT_ENDPOINT;
  const inputMimeType = cleanEnv(audioFormat) || DEFAULT_AUDIO_INPUT_MIME_TYPE;
  const traceId = callTraceId || callSid || randomUUID();
  const geminiPrefix = `[Gemini][trace=${traceId}]`;
  const clientOptions = {
    apiKey,
  };

  const baseUrl = normalizeBaseUrl(resolvedEndpoint);
  if (baseUrl) {
    clientOptions.httpOptions = { baseUrl };
  }

  const wsUrl = buildWsUrl(baseUrl, apiKey);
  console.log(`${geminiPrefix} Using model=${resolvedModel} endpoint=${baseUrl || 'default'} ws=${wsUrl}`);

  const ai = new GoogleGenAI(clientOptions);

  const toolDeclarations = Array.isArray(tools) ? tools : [];

  const vadConfig = {
    startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
    endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
    prefixPaddingMs: 120,
    silenceDurationMs: 150,
  };

  if (DEBUG_GEMINI_SESSION) {
    const instructionText = instructions || '';
    console.log(`${geminiPrefix}[session-init] Gemini session config`, {
      model: resolvedModel,
      endpoint: baseUrl || 'default',
      voice: voice || DEFAULT_VOICE,
      audioInputMimeType: inputMimeType,
      audioOutputMimeType: DEFAULT_AUDIO_OUTPUT_MIME_TYPE,
      instructionsLength: instructionText.length,
      instructionsPreview: previewText(instructionText),
      toolNames: toolDeclarations.map((t) => t.name || 'unknown'),
      vadConfig,
      restaurantId: restaurantId || null,
      callSid: callSid || null,
      traceId,
    });
  }

  if (DEBUG_GEMINI_SESSION) {
    console.log(`${geminiPrefix}[session-init] outbound payload`, {
      responseModalities: ['AUDIO'],
      systemInstruction: { parts: [{ text: instructions || '' }] },
      tools: toolDeclarations.length ? [{ functionDeclarations: toolDeclarations }] : undefined,
      realtimeInputConfig: { automaticActivityDetection: vadConfig },
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice || DEFAULT_VOICE,
          },
        },
      },
    });
  }

  let clientRef = null;
  let openSeen = false;
  let openTimestamp = null;
  const callbacks = {
    onopen: () => {
      openSeen = true;
      openTimestamp = Date.now();
      console.log(`${geminiPrefix} connected`, {
        model: resolvedModel,
        endpoint: baseUrl || 'default',
        connectedAt: new Date(openTimestamp).toISOString(),
      });
      if (clientRef) {
        clientRef.markConnected(openTimestamp);
        clientRef.markReady();
      }
    },
    onmessage: (msg) => {
      if (!clientRef && DEBUG_GEMINI_EVENTS) {
        console.log(`${geminiPrefix} message received before client init`);
      }
      clientRef?.handleMessage(msg);
    },
    onerror: (err) => {
      console.error(`${geminiPrefix} error event`, { message: err?.message, stack: err?.stack });
      clientRef?.handleWsError(err);
      clientRef?.emit('error', err);
    },
    onclose: (code, reason) => {
      if (clientRef) {
        clientRef.handleClose(code, reason);
      } else {
        console.log(`${geminiPrefix}[close] socket closed`, {
          code,
          reason: normalizeCloseReason(reason),
        });
      }
    },
  };

  const session = await ai.live.connect({
    model: resolvedModel,
    callbacks,
    config: {
      systemInstruction: {
        role: 'system',
        parts: [{ text: instructions || '' }],
      },
      responseModalities: [Modality.AUDIO],
      tools: toolDeclarations.length ? [{ functionDeclarations: toolDeclarations }] : undefined,
      realtimeInputConfig: {
        automaticActivityDetection: vadConfig,
      },
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice || DEFAULT_VOICE,
          },
        },
      },
    },
  });

  clientRef = new GeminiLiveClient(session, {
    audioMimeType: inputMimeType,
    greetingText,
    traceId,
    model: resolvedModel,
    endpoint: baseUrl || 'default',
    voiceName: voice || DEFAULT_VOICE,
    callSid: callSid || null,
  });

  if (openSeen) {
    clientRef.markConnected(openTimestamp || Date.now());
    clientRef.markReady();
  }

  return clientRef;
}
