/**
 * Live API audio I/O:
 * - Input:  mic (browser native rate) → downsample → 16kHz Int16 mono → Uint8Array
 * - Output: server 24kHz PCM mono → AudioBuffer 連結再生
 *
 * iPhone Safari 互換のため ScriptProcessorNode を使用（AudioWorklet は別ファイル必要で煩雑）。
 * half-duplex: AI 発話中は送信停止（バックチャンネル / 音響エコー防止）。
 */

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const PROCESS_BUFFER_SIZE = 4096;
// AI 発話終了後、mic 送信を再開するまでの cooldown
// (speaker の余韻と echo 経路の遅延を吸収する)
const AI_SPEAKING_COOLDOWN_MS = 900;

export type AudioChunkHandler = (base64Pcm16: string) => void;

export class LiveAudioManager {
  private inputCtx: AudioContext | null = null;
  private outputCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private nextPlaybackTime = 0;
  private playingSources = new Set<AudioBufferSourceNode>();
  private isAiSpeaking = false;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private onChunk: AudioChunkHandler = () => {};

  /** ユーザー操作（クリック等）の同期文脈で呼ぶこと（iOS の autoplay 制限対策） */
  async start(onChunk: AudioChunkHandler): Promise<void> {
    this.onChunk = onChunk;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.inputCtx = new AudioContext();
    this.outputCtx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    await this.inputCtx.resume();
    await this.outputCtx.resume();
    this.nextPlaybackTime = this.outputCtx.currentTime;

    this.source = this.inputCtx.createMediaStreamSource(this.stream);
    this.processor = this.inputCtx.createScriptProcessor(PROCESS_BUFFER_SIZE, 1, 1);
    this.processor.onaudioprocess = (ev) => this.handleAudioProcess(ev);
    this.source.connect(this.processor);
    // ScriptProcessor は destination に繋がないと発火しないブラウザがあるため、
    // 無音 Gain ノード経由で接続（実音は流さない）
    const silentGain = this.inputCtx.createGain();
    silentGain.gain.value = 0;
    this.processor.connect(silentGain);
    silentGain.connect(this.inputCtx.destination);
  }

  stop(): void {
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
    } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    try {
      this.inputCtx?.close();
    } catch {}
    try {
      this.outputCtx?.close();
    } catch {}
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.inputCtx = null;
    this.outputCtx = null;
    this.nextPlaybackTime = 0;
    this.isAiSpeaking = false;
    this.playingSources.clear();
  }

  /** サーバから受信した base64 PCM (24kHz, 16-bit signed) を再生キューに積む */
  playPcm(base64: string): void {
    if (!this.outputCtx) return;
    const bytes = base64ToBytes(base64);
    if (bytes.byteLength < 2) return;
    const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    const buf = this.outputCtx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    buf.copyToChannel(float32, 0);
    const src = this.outputCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.outputCtx.destination);
    const start = Math.max(this.nextPlaybackTime, this.outputCtx.currentTime);
    src.start(start);
    this.nextPlaybackTime = start + buf.duration;
    this.isAiSpeaking = true;
    // 新しい音声 chunk が来たら cooldown timer をキャンセル（後で再スケジュール）
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.playingSources.add(src);
    src.onended = () => {
      this.playingSources.delete(src);
      // 全 chunk が再生終了した場合 → cooldown 後に isAiSpeaking を解除
      if (this.playingSources.size === 0) {
        this.scheduleCooldown();
      }
    };
  }

  /** 割り込み: 残り再生を即停止 */
  flushPlayback(): void {
    if (!this.outputCtx) return;
    this.playingSources.forEach((s) => {
      try {
        s.stop();
        s.disconnect();
      } catch {}
    });
    this.playingSources.clear();
    this.nextPlaybackTime = this.outputCtx.currentTime;
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.isAiSpeaking = false;
  }

  /**
   * 外部 (controller) から turn 単位で AI 発話状態を上書きする。
   * - true: 直ちに mic 入力を遮断
   * - false: cooldown 後に mic 入力を再開
   */
  setAiSpeaking(state: boolean): void {
    if (state) {
      this.isAiSpeaking = true;
      if (this.cooldownTimer !== null) {
        clearTimeout(this.cooldownTimer);
        this.cooldownTimer = null;
      }
    } else {
      this.scheduleCooldown();
    }
  }

  private scheduleCooldown(): void {
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
    }
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      // 再生キューが空のままなら本当に解除
      if (this.playingSources.size === 0) {
        this.isAiSpeaking = false;
      }
    }, AI_SPEAKING_COOLDOWN_MS);
  }

  private handleAudioProcess(ev: AudioProcessingEvent): void {
    if (!this.inputCtx) return;
    if (this.isAiSpeaking) return;
    const input = ev.inputBuffer.getChannelData(0);
    const ratio = this.inputCtx.sampleRate / INPUT_SAMPLE_RATE;
    const outLen = Math.floor(input.length / ratio);
    if (outLen <= 0) return;
    const int16 = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const s = input[Math.floor(i * ratio)];
      int16[i] = Math.max(-1, Math.min(1, s)) * 32767;
    }
    this.onChunk(bytesToBase64(new Uint8Array(int16.buffer)));
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  // 大きすぎる Uint8Array で String.fromCharCode(...arr) は stack overflow するので分割
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(bin);
}
