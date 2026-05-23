/**
 * getUserMedia でカメラを起動し、撮影確定時にフル解析を 1 回だけ実行する。
 *
 * 旧仕様の AR 連続検知（DETECT モード）は API クォータを浪費するため廃止。
 * 撮影後の認識結果は呼び出し側（scan.astro）が撮影画像の上に SVG オーバーレイ
 * （ピン + bbox）として描画する。
 */

export interface ScanItem {
  no?: string;
  label: string;
  label_detail?: string;
  value: string;
  flag?: 'H' | 'L' | '';
  unit?: string;
  ref_low?: string;
  ref_high?: string;
  marked?: boolean;
  bbox: [number, number, number, number]; // [ymin, xmin, ymax, xmax] 0-1000 で正規化
  confidence: 'high' | 'low';
  kind: 'printed' | 'handwritten';
}

export interface AnalyzeResult {
  items?: ScanItem[];
  raw?: string;
  finishReason?: string;
  model?: string;
}

export type ScanState = 'idle' | 'running' | 'busy';

export interface CameraRefs {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement; // 撮影用（非表示）
  status: HTMLElement;
  hint?: HTMLInputElement | null;
  shotBtn?: HTMLButtonElement;
  onStateChange?: (state: ScanState) => void;
  onCapture?: (dataUrl: string) => void;
  onStreamProgress?: (progress: { totalLen: number }) => void;
  onAnalyze?: (result: AnalyzeResult) => void;
  onError?: (message: string) => void;
}

interface StreamEvent {
  type: 'start' | 'chunk' | 'done' | 'error';
  model?: string;
  text?: string;
  totalLen?: number;
  raw?: string;
  json?: AnalyzeResult;
  finishReason?: string;
  error?: string;
  detail?: string;
  status?: number;
}

export interface CameraScanController {
  start: () => Promise<void>;
  stop: () => void;
  capture: (opts?: CaptureOptions) => Promise<void>;
  isRunning: () => boolean;
}

export interface CaptureOptions {
  /** 指定すると「この項目だけ拡大撮影」モードのプロンプトを送る */
  focusLabel?: string;
}

export function initCameraScan(refs: CameraRefs): CameraScanController {
  let stream: MediaStream | null = null;

  // shot ボタンの click は scan.astro 側で focusLabel を判断するため、
  // ここでは登録しない（呼び出し側が controller.capture(...) を直接叩く）。

  setState('idle');

  async function start(): Promise<void> {
    if (stream) return;
    setStatus('カメラを起動中…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      });
      refs.video.srcObject = stream;
      await refs.video.play();
      setState('running');
      setStatus('用紙が枠に収まるようにかざしてください');
    } catch (err) {
      setState('idle');
      const msg = describeMediaError(err);
      setStatus(msg);
      refs.onError?.(msg);
    }
  }

  function stop(): void {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    refs.video.srcObject = null;
    setState('idle');
    setStatus('停止中');
  }

  async function capture(opts?: CaptureOptions): Promise<void> {
    if (!stream) return;
    const dataUrl = grabFrame({ maxEdge: 1280, quality: 0.85 });
    if (!dataUrl) {
      setStatus('まだ映像が取得できていません');
      return;
    }

    setState('busy');
    setStatus(opts?.focusLabel ? `「${opts.focusLabel}」を再解析中…` : 'AI が解析しています…');
    refs.onCapture?.(dataUrl);

    // フォーカス再撮影モードでは、その項目に集中するよう AI に指示
    const focusHint = opts?.focusLabel
      ? `これは「${opts.focusLabel}」という検査項目だけを画面いっぱいに拡大して再撮影した画像です。この 1 項目（または周辺の関連項目）の値を、結果列の値として正確に転記してください。`
      : '';
    const userHint = refs.hint?.value?.trim() || '';
    const hint = focusHint || userHint || undefined;

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          image: dataUrl,
          mode: 'analyze',
          hint,
        }),
      });
      if (!res.ok || !res.body) {
        const text = await res.text();
        const data = safeJson(text) as
          | { error?: string; detail?: string }
          | null;
        const msg = `解析エラー (${res.status}): ${data?.error ?? text}${
          data?.detail ? `\n${summarizeGoogleError(data.detail)}` : ''
        }`;
        setStatus(msg);
        refs.onError?.(msg);
        setState(stream ? 'running' : 'idle');
        return;
      }

      // NDJSON ストリームを 1 行ずつ処理。
      // TS の制御フロー解析が closure 内の代入で narrow を更新しない仕様回避のため、
      // mutable な holder オブジェクトで結果を集約する。
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const holder: {
        result: AnalyzeResult | null;
        err: { msg: string } | null;
        totalLen: number;
      } = { result: null, err: null, totalLen: 0 };
      let buf = '';

      const pump = async (): Promise<void> => {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = safeJson(line) as StreamEvent | null;
          if (!ev) continue;
          if (ev.type === 'start') {
            setStatus(`📥 ${ev.model ?? ''} 接続`);
          } else if (ev.type === 'chunk') {
            holder.totalLen = ev.totalLen ?? holder.totalLen + (ev.text?.length ?? 0);
            setStatus(`📝 読み取り中… ${holder.totalLen.toLocaleString()} 文字`);
            refs.onStreamProgress?.({ totalLen: holder.totalLen });
          } else if (ev.type === 'done') {
            holder.result = {
              ...(ev.json ?? {}),
              raw: ev.raw,
              finishReason: ev.finishReason,
            };
          } else if (ev.type === 'error') {
            const detail = ev.detail ? `\n${summarizeGoogleError(ev.detail)}` : '';
            holder.err = {
              msg: `解析エラー (${ev.status ?? '?'}): ${ev.error ?? '不明'}${detail}`,
            };
          }
        }
        await pump();
      };
      await pump();

      if (holder.err) {
        setStatus(holder.err.msg);
        refs.onError?.(holder.err.msg);
        setState(stream ? 'running' : 'idle');
        return;
      }
      const finalResult = holder.result;
      if (!finalResult) {
        const msg = '解析エラー: 応答が完了しませんでした';
        setStatus(msg);
        refs.onError?.(msg);
        setState(stream ? 'running' : 'idle');
        return;
      }
      setState(stream ? 'running' : 'idle');
      setStatus(
        finalResult.items?.length
          ? `${finalResult.items.length} 項目を読み取りました`
          : '解析が完了しました',
      );
      refs.onAnalyze?.(finalResult);
    } catch (err) {
      const msg = `通信エラー: ${String(err)}`;
      setStatus(msg);
      refs.onError?.(msg);
      setState(stream ? 'running' : 'idle');
    }
  }

  function grabFrame(opts: { maxEdge: number; quality: number }): string | null {
    const vw = refs.video.videoWidth;
    const vh = refs.video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(1, opts.maxEdge / Math.max(vw, vh));
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    refs.canvas.width = w;
    refs.canvas.height = h;
    const ctx = refs.canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(refs.video, 0, 0, w, h);
    return refs.canvas.toDataURL('image/jpeg', opts.quality);
  }

  function setStatus(text: string): void {
    refs.status.textContent = text;
  }

  function setState(state: ScanState): void {
    if (refs.shotBtn) refs.shotBtn.disabled = state !== 'running';
    refs.onStateChange?.(state);
  }

  return {
    start,
    stop,
    capture,
    isRunning: () => stream !== null,
  };
}

function describeMediaError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  switch (err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'カメラへのアクセスが拒否されました。設定からカメラ許可をご確認ください。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'カメラが見つかりません。デバイスの設定をご確認ください。';
    case 'NotReadableError':
      return 'カメラが他のアプリで使用中の可能性があります。';
    default:
      return `カメラの起動に失敗しました: ${err.message || err.name}`;
  }
}

/**
 * Google Generative Language API のエラーレスポンス本文から
 * 人間が読みやすい 1 行サマリを作る。
 */
function summarizeGoogleError(detail: string): string {
  try {
    const obj = JSON.parse(detail) as {
      error?: {
        status?: string;
        message?: string;
        details?: Array<{
          '@type'?: string;
          violations?: Array<{ quotaMetric?: string; quotaId?: string }>;
          retryDelay?: string;
        }>;
      };
    };
    const e = obj.error;
    if (!e) return detail.slice(0, 300);
    const parts: string[] = [];
    if (e.status) parts.push(e.status);
    if (e.message) parts.push(e.message);
    const quota = e.details?.find((d) => d.violations?.length)?.violations?.[0];
    if (quota?.quotaMetric) parts.push(`metric: ${quota.quotaMetric}`);
    if (quota?.quotaId) parts.push(`id: ${quota.quotaId}`);
    const retry = e.details?.find((d) => d.retryDelay)?.retryDelay;
    if (retry) parts.push(`retry in ${retry}`);
    return parts.join(' / ');
  } catch {
    return detail.slice(0, 300);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
