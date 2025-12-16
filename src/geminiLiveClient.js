import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import {
  EndSensitivity,
  GoogleGenAI,
  Modality,
  StartSensitivity,
  VadSignalType,
} from '@google/genai';

const DEFAULT_AUDIO_MIME_TYPE = 'audio/pcm;rate=8000';
const DEFAULT_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-live-2.5-flash-preview';
const DEFAULT_VOICE = process.env.GEMINI_LIVE_VOICE || 'Puck';
const DEBUG_GEMINI_EVENTS = process.env.DEBUG_GEMINI_EVENTS === 'true';
const DEBUG_GEMINI_SESSION = process.env.DEBUG_GEMINI_SESSION !== 'false';
const DEBUG_AUDIO_STATS = process.env.DEBUG_AUDIO_STATS !== 'false';

function parseSampleRate(mimeType) {
  if (!mimeType) return null;
  const match = String(mimeType).match(/rate=([0-9]+)/i);
  if (match && match[1]) {
    const rate = Number(match[1]);
    if (!Number.isNaN(rate) && rate > 0) return rate;
  }
  return null;
}

function pcmuToPcm16(muLawBuffer) {
  const pcmBuffer = Buffer.alloc(muLawBuffer.length * 2);
  for (let i = 0; i < muLawBuffer.length; i += 1) {
    const mu = ~muLawBuffer[i] & 0xff;
    const sign = mu & 0x80;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    if (sign) sample = -sample;
    pcmBuffer.writeInt16LE(sample, i * 2);
  }
  return pcmBuffer;
}

function linearToMuLawSample(sample) {
  const BIAS = 0x84;
  const MAX = 32635;
  let clamped = Math.min(Math.max(sample, -MAX), MAX);
  const sign = clamped < 0 ? 0x80 : 0x00;
  if (clamped < 0) {
    clamped = -clamped;
  }
  clamped += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (clamped & expMask) === 0 && exponent > 0; exponent -= 1) {
    expMask >>= 1;
  }

  const mantissa = (clamped >> (exponent === 0 ? 0 : exponent - 3)) & 0x0f;
  const muLawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return muLawByte;
}

function pcm16ToPcmu(pcmBuffer, inputSampleRate = 8000) {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, sampleCount);
  const step = Math.max(1, Math.round(inputSampleRate / 8000));
  const output = Buffer.alloc(Math.ceil(sampleCount / step));

  let outIdx = 0;
  for (let i = 0; i < samples.length; i += step) {
    const muSample = linearToMuLawSample(samples[i]);
    output[outIdx] = muSample;
    outIdx += 1;
  }

  return outIdx === output.length ? output : output.slice(0, outIdx);
}

function normalizeBaseUrl(rawBaseUrl) {
  if (!rawBaseUrl) return undefined;
  return rawBaseUrl.endsWith('/') ? rawBaseUrl.slice(0, -1) : rawBaseUrl;
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

class GeminiLiveClient extends EventEmitter {
  constructor(
    session,
    {
      audioMimeType = DEFAULT_AUDIO_MIME_TYPE,
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
    this.audioMimeType = audioMimeType || DEFAULT_AUDIO_MIME_TYPE;
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
    this.lastEventType = 'none';
    this.sessionInitSent = true;
    this.sessionAcked = false;
    this.connectedAtMs = null;
    this.closedAtMs = null;
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

  markConnected(ts = Date.now()) {
    this.connectedAtMs = ts;
    if (this.debugSession) {
      this.log('log', '[session] WebSocket open', {
        connectedAt: new Date(ts).toISOString(),
        model: this.model,
        endpoint: this.endpoint || 'default',
        audioInput: this.audioMimeType,
        audioOutput: 'audio/pcmu;rate=8000',
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

  handleMessage(rawMessage) {
    let message = rawMessage;
    try {
      if (typeof rawMessage === 'string') {
        message = JSON.parse(rawMessage);
      } else if (rawMessage?.data && typeof rawMessage.data === 'string') {
        message = JSON.parse(rawMessage.data);
      }
    } catch (err) {
      this.log('warn', '[event=parse-error] Failed to parse Gemini message', { error: err?.message });
      return;
    }

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
          const audioChunk = this.transformOutputAudio(part.inlineData);
          if (audioChunk) {
            this.receivedAudioDeltas += 1;
            this.receivedAudioBytes += base64Bytes(audioChunk);
            if (this.debugAudioStats) {
              this.log('log', '[event=audio.delta]', {
                deltaIndex: this.receivedAudioDeltas,
                bytes: base64Bytes(audioChunk),
              });
            }
            this.emit('audio.delta', { chunk: audioChunk });
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
  }

  transformOutputAudio(inlineData) {
    try {
      const { data, mimeType } = inlineData;
      if (!data) return null;

      if (mimeType && mimeType.toLowerCase().includes('pcmu')) {
        return data;
      }

      const sampleRate = parseSampleRate(mimeType) || 8000;
      const pcmBuffer = Buffer.from(data, 'base64');
      const pcmuBuffer = pcm16ToPcmu(pcmBuffer, sampleRate);
      return pcmuBuffer.toString('base64');
    } catch (err) {
      console.error('[Gemini] Failed to transform output audio', err);
      return null;
    }
  }

  async sendAudioChunk(base64Pcmu) {
    if (!base64Pcmu) return;
    try {
      await this.ready;
      const muLawBuffer = Buffer.from(base64Pcmu, 'base64');
      this.sentAudioFrames += 1;
      this.sentAudioBytes += muLawBuffer.length;
      if (this.debugAudioStats) {
        this.log('log', '[audio] sending chunk', {
          frame: this.sentAudioFrames,
          bytes: muLawBuffer.length,
        });
      }
      const pcmBuffer = pcmuToPcm16(muLawBuffer);
      this.session.sendRealtimeInput({
        audio: {
          data: pcmBuffer.toString('base64'),
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
  model = DEFAULT_MODEL,
  endpoint = process.env.GEMINI_LIVE_ENDPOINT,
} = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[Gemini] GEMINI_API_KEY missing; cannot connect to Gemini Live.');
    return null;
  }

  const traceId = callTraceId || callSid || randomUUID();
  const geminiPrefix = `[Gemini][trace=${traceId}]`;
  const clientOptions = {
    apiKey,
  };

  const baseUrl = normalizeBaseUrl(endpoint);
  if (baseUrl) {
    clientOptions.httpOptions = { baseUrl };
  }

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
      model,
      endpoint: baseUrl || 'default',
      voice: voice || DEFAULT_VOICE,
      audioInputMimeType: audioFormat || DEFAULT_AUDIO_MIME_TYPE,
      audioOutputMimeType: 'audio/pcmu;rate=8000',
      instructionsLength: instructionText.length,
      instructionsPreview: previewText(instructionText),
      toolNames: toolDeclarations.map((t) => t.name || 'unknown'),
      vadConfig,
      restaurantId: restaurantId || null,
      callSid: callSid || null,
      traceId,
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
        model,
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
    model,
    callbacks,
    config: {
      systemInstruction: {
        role: 'system',
        parts: [{ text: instructions || '' }],
      },
      responseModalities: [Modality.AUDIO, Modality.TEXT],
      tools: toolDeclarations.length ? [{ functionDeclarations: toolDeclarations }] : undefined,
      realtimeInputConfig: {
        automaticActivityDetection: vadConfig,
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
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
    audioMimeType: audioFormat || DEFAULT_AUDIO_MIME_TYPE,
    greetingText,
    traceId,
    model,
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
