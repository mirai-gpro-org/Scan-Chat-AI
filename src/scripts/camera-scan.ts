/**
 * カメラ起動 → 撮影 → サーバ送信（バイナリ Blob）→ NDJSON ストリーム受信。
 *
 * - base64 は一切使わない。撮影画像は canvas.toBlob() で Blob として保持し、
 *   multipart/form-data でサーバへバイナリ直送する。
 * - サーバは Files API 経由で Gemini に画像を渡し、応答は NDJSON で
 *   1 chunk ずつ流す（Vercel のレスポンスバッファ詰まりを回避）。
 * - AR 連続検知は撤廃済み。capture() 1 発のみ。
 */

/** 1 領域分のデータ (LLM の出力 JSON 内の各 region) */
export interface RegionResult {
  id: string;
  label: string;
  kind?: 'table' | 'notes';
  /** kind=table のとき */
  cols?: string[];
  rows?: string[][];
  uncertain_rows?: number[];
  /** kind=notes のとき */
  text?: string;
  error?: string;
}

export interface AnalyzeResult {
  regions: RegionResult[];
  /** 表示用フル画像 URL (objectURL, dataURL ではない) */
  fullImage?: string;
  raw?: string;
  finishReason?: string;
}

export type ScanState = 'idle' | 'running' | 'busy';

export interface CameraRefs {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  status: HTMLElement;
  hint?: HTMLInputElement | null;
  shotBtn?: HTMLButtonElement;
  onStateChange?: (state: ScanState) => void;
  /** 撮影直後の画像 URL（objectURL）を結果ページに渡す用 */
  onCapture?: (objectUrl: string) => void;
  /** NDJSON ストリームの進捗 (文字数) */
  onStreamProgress?: (totalLen: number) => void;
  onAnalyze?: (result: AnalyzeResult) => void;
  onError?: (message: string) => void;
}

export interface CameraScanController {
  start: () => Promise<void>;
  stop: () => void;
  capture: () => Promise<void>;
  isRunning: () => boolean;
}

export function initCameraScan(refs: CameraRefs): CameraScanController {
  let stream: MediaStream | null = null;

  refs.shotBtn?.addEventListener('click', capture);

  setState('idle');

  async function start(): Promise<void> {
    if (stream) return;
    setStatus('カメラを起動中…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1500 } },
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

  async function capture(): Promise<void> {
    if (!stream) return;
    const blob = await grabFrameBlob({ maxEdge: 1500, quality: 0.78 });
    if (!blob) {
      setStatus('まだ映像が取得できていません');
      return;
    }
    // 表示用 URL は objectURL（base64 ではない）
    const previewUrl = URL.createObjectURL(blob);
    refs.onCapture?.(previewUrl);

    setState('busy');
    setStatus('📤 アップロード中…');

    const userHint = refs.hint?.value?.trim() || '';
    const formData = new FormData();
    formData.append('image', blob, 'scan.jpg');
    formData.append('mode', 'analyze');
    if (userHint) formData.append('hint', userHint);

    try {
      // multipart/form-data として送信（Content-Type はブラウザが boundary 付きで自動設定）
      const res = await fetch('/api/scan', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok || !res.body) {
        const msg = await readErrorMessage(res);
        setStatus(msg);
        refs.onError?.(msg);
        setState(stream ? 'running' : 'idle');
        return;
      }

      // NDJSON ストリーム受信
      const holder: {
        regions: RegionResult[];
        raw?: string;
        finishReason?: string;
        err?: string;
      } = { regions: [] };

      await readNdjsonStream(res, (ev) => {
        if (ev.type === 'start') {
          setStatus('🤖 解析中…');
        } else if (ev.type === 'chunk') {
          const len = ev.totalLen ?? 0;
          setStatus(`📝 読み取り中… ${len.toLocaleString()} 文字`);
          refs.onStreamProgress?.(len);
        } else if (ev.type === 'done') {
          const json = ev.json as { regions?: RegionResult[] } | null;
          holder.regions = Array.isArray(json?.regions) ? json.regions : [];
          holder.raw = ev.raw;
          holder.finishReason = ev.finishReason;
        } else if (ev.type === 'error') {
          holder.err = `${ev.error ?? '不明'}\n${
            ev.detail ? summarizeGoogleError(ev.detail) : ''
          }`.trim();
        }
      });

      if (holder.err) {
        setStatus(`解析エラー: ${holder.err}`);
        refs.onError?.(`解析エラー: ${holder.err}`);
        setState(stream ? 'running' : 'idle');
        return;
      }
      if (holder.regions.length === 0) {
        const msg = '領域が検出されませんでした。撮影し直してください。';
        setStatus(msg);
        refs.onError?.(msg);
        setState(stream ? 'running' : 'idle');
        return;
      }

      const totalItems = holder.regions.reduce((sum, r) => sum + (r.rows?.length ?? 0), 0);
      const result: AnalyzeResult = {
        regions: holder.regions,
        fullImage: previewUrl,
        raw: holder.raw,
        finishReason: holder.finishReason,
      };
      setState(stream ? 'running' : 'idle');
      setStatus(
        totalItems
          ? `${holder.regions.length} 領域 / ${totalItems} 項目を読み取りました`
          : '解析が完了しました',
      );
      refs.onAnalyze?.(result);
    } catch (err) {
      const msg = `通信エラー: ${String(err)}`;
      setStatus(msg);
      refs.onError?.(msg);
      setState(stream ? 'running' : 'idle');
    }
  }

  /**
   * video から canvas にコピーして JPEG Blob として返す。
   * dataURL 経由しないので base64 化が一切発生しない。
   */
  async function grabFrameBlob(opts: { maxEdge: number; quality: number }): Promise<Blob | null> {
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
    return new Promise<Blob | null>((resolve) => {
      refs.canvas.toBlob((b) => resolve(b), 'image/jpeg', opts.quality);
    });
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

// ============================================================
// ストリーム受信 (NDJSON)
// ============================================================

interface StreamEvent {
  type: 'start' | 'chunk' | 'done' | 'error';
  text?: string;
  totalLen?: number;
  raw?: string;
  json?: unknown;
  finishReason?: string;
  error?: string;
  detail?: string;
  status?: number;
  model?: string;
}

async function readNdjsonStream(
  res: Response,
  onEvent: (ev: StreamEvent) => void,
): Promise<void> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as StreamEvent);
      } catch {
        // 部分行や JSON でない行は無視（次の chunk で揃う想定）
      }
    }
  }
  // 残った buf の処理
  if (buf.trim()) {
    try {
      onEvent(JSON.parse(buf.trim()) as StreamEvent);
    } catch {
      /* ignore */
    }
  }
}

/**
 * non-stream エラーレスポンスからメッセージを抽出。
 * Vercel のタイムアウト等で JSON でない場合は raw テキスト先頭を使う。
 */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const data = JSON.parse(text) as { error?: unknown; detail?: string };
      const err =
        typeof data.error === 'string'
          ? data.error
          : data.error
            ? JSON.stringify(data.error)
            : text.slice(0, 200);
      const detail = data.detail ? `\n${summarizeGoogleError(data.detail)}` : '';
      return `解析エラー (${res.status}): ${err}${detail}`;
    } catch {
      return `解析エラー (${res.status}): ${text.slice(0, 200) || '不明'}`;
    }
  } catch {
    return `解析エラー (${res.status})`;
  }
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
