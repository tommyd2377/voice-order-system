import { EventEmitter } from 'events';
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

class GeminiLiveClient extends EventEmitter {
  constructor(session, { audioMimeType = DEFAULT_AUDIO_MIME_TYPE, greetingText } = {}) {
    super();
    this.session = session;
    this.audioMimeType = audioMimeType || DEFAULT_AUDIO_MIME_TYPE;
    this.textBuffer = '';
    this.greetingText = greetingText;
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
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

  handleMessage(message) {
    const { serverContent, toolCall, voiceActivityDetectionSignal } = message;

    if (voiceActivityDetectionSignal?.vadSignalType === VadSignalType.VAD_SIGNAL_TYPE_SOS) {
      this.emit('user.start');
    }

    if (serverContent?.inputTranscription?.text) {
      const transcriptText = serverContent.inputTranscription.text;
      if (serverContent.inputTranscription.finished && transcriptText) {
        this.emit('transcript.completed', { text: transcriptText });
      }
    }

    if (serverContent?.outputTranscription?.text) {
      this.textBuffer += serverContent.outputTranscription.text;
      this.emit('text.delta', { text: serverContent.outputTranscription.text });
    }

    if (serverContent?.modelTurn?.parts?.length) {
      for (const part of serverContent.modelTurn.parts) {
        if (part.text) {
          this.textBuffer += part.text;
          this.emit('text.delta', { text: part.text });
        }

        if (part.inlineData?.data && part.inlineData?.mimeType?.startsWith('audio/')) {
          const audioChunk = this.transformOutputAudio(part.inlineData);
          if (audioChunk) {
            this.emit('audio.delta', { chunk: audioChunk });
          }
        }

        if (part.functionCall) {
          const argsJsonString = JSON.stringify(part.functionCall.args || {});
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
        this.emit('tool.call', {
          name: fnCall.name || 'unknown',
          callId: fnCall.id || null,
          argumentsJsonString: argsJsonString,
        });
      }
    }

    if (serverContent?.interrupted) {
      this.emit('response.interrupted');
    }

    if (serverContent?.turnComplete || serverContent?.generationComplete) {
      if (this.textBuffer.trim()) {
        this.emit('text.done', { text: this.textBuffer.trim() });
      }
      this.textBuffer = '';
      this.emit('response.complete');
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
  model = DEFAULT_MODEL,
  endpoint = process.env.GEMINI_LIVE_ENDPOINT,
} = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[Gemini] GEMINI_API_KEY missing; cannot connect to Gemini Live.');
    return null;
  }

  const clientOptions = {
    apiKey,
  };

  const baseUrl = normalizeBaseUrl(endpoint);
  if (baseUrl) {
    clientOptions.httpOptions = { baseUrl };
  }

  const ai = new GoogleGenAI(clientOptions);

  const toolDeclarations = Array.isArray(tools) ? tools : [];

  let clientRef = null;
  let openSeen = false;
  const callbacks = {
    onopen: () => {
      console.log('[Gemini] connected');
      if (clientRef) {
        clientRef.markReady();
      } else {
        openSeen = true;
      }
    },
    onmessage: (msg) => {
      clientRef?.handleMessage(msg);
    },
    onerror: (err) => {
      console.error('[Gemini] error event', err);
      clientRef?.emit('error', err);
    },
    onclose: () => {
      console.log('[Gemini] session closed');
      clientRef?.emit('close');
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
        automaticActivityDetection: {
          startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
          endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
          prefixPaddingMs: 120,
          silenceDurationMs: 150,
        },
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
  });

  if (openSeen) {
    clientRef.markReady();
  }

  return clientRef;
}
