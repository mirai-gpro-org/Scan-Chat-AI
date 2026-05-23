/**
 * getUserMedia でカメラを起動し、AR ハイライト（連続検知）と
 * 撮影確定時のフル解析の 2 つを担う。
 *
 * 提案書 機能1:
 *  - AR リアルタイム・ハイライト: 確信度が高い項目は緑、手書きや低信頼は黄。
 *  - デジタル・オーバーレイ: 撮影確定後、画像の真上に構造化値を半透明で重ねる。
 *
 * UI 統合は呼び出し側に委ねるため、状態変化と解析結果はコールバックで通知する。
 */

export interface ScanItem {
  label: string;
  value: string;
  bbox: [number, number, number, number]; // [ymin, xmin, ymax, xmax] 0-1000 で正規化
  confidence: 'high' | 'low';
  kind: 'printed' | 'handwritten';
}

export interface AnalyzeResult {
  observations?: string[];
  regions?: string[];
  follow_up_questions?: string[];
  items?: ScanItem[];
  priority_flags?: string[];
  urgent?: boolean;
  raw?: string;
  finishReason?: string;
}

export type ScanState = 'idle' | 'running' | 'busy';

export interface CameraRefs {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement; // 撮影用（非表示）
  overlay: HTMLCanvasElement; // ライブ video の上に重ねる検知枠用
  detectToggle: HTMLInputElement;
  status: HTMLElement;
  hint?: HTMLInputElement | null;
  shotBtn?: HTMLButtonElement;
  onStateChange?: (state: ScanState) => void;
  onAnalyze?: (result: AnalyzeResult) => void;
  onError?: (message: string) => void;
}

export interface CameraScanController {
  start: () => Promise<void>;
  stop: () => void;
  capture: () => Promise<void>;
  clearOverlay: () => void;
  isRunning: () => boolean;
}

const DETECT_INTERVAL_MS = 1800; // AR 連続検知の間隔（APIコスト抑制）
const DETECT_JPEG_QUALITY = 0.6;
const DETECT_MAX_EDGE = 720; // 検知用は縮小して送る

export function initCameraScan(refs: CameraRefs): CameraScanController {
  let stream: MediaStream | null = null;
  let detectTimer: number | null = null;
  let detectBusy = false;
  let lastItems: ScanItem[] = [];

  refs.shotBtn?.addEventListener('click', capture);
  refs.detectToggle.addEventListener('change', () => {
    if (refs.detectToggle.checked && stream) startDetectLoop();
    else stopDetectLoop();
  });
  refs.video.addEventListener('loadedmetadata', syncOverlaySize);
  window.addEventListener('resize', syncOverlaySize);

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
      syncOverlaySize();
      setState('running');
      setStatus('用紙が枠に収まるようにかざしてください');
      if (refs.detectToggle.checked) startDetectLoop();
    } catch (err) {
      setState('idle');
      const msg = describeMediaError(err);
      setStatus(msg);
      refs.onError?.(msg);
    }
  }

  function stop(): void {
    stopDetectLoop();
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    refs.video.srcObject = null;
    clearOverlay();
    lastItems = [];
    setState('idle');
    setStatus('停止中');
  }

  function startDetectLoop(): void {
    if (detectTimer !== null) return;
    detectTimer = window.setTimeout(tick, 100);
  }

  async function tick(): Promise<void> {
    if (!stream || detectBusy) {
      scheduleNext();
      return;
    }
    detectBusy = true;
    try {
      const dataUrl = grabFrame({ maxEdge: DETECT_MAX_EDGE, quality: DETECT_JPEG_QUALITY });
      if (!dataUrl) return;
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, mode: 'detect' }),
      });
      const data = (await res.json()) as { json?: { items?: ScanItem[] }; error?: string };
      if (res.ok && data.json?.items) {
        lastItems = data.json.items;
        drawLiveOverlay(lastItems);
      }
    } catch {
      // 一過性の失敗は次フレームで取り戻す
    } finally {
      detectBusy = false;
      scheduleNext();
    }
  }

  function scheduleNext(): void {
    if (detectTimer === null) return;
    detectTimer = window.setTimeout(tick, DETECT_INTERVAL_MS);
  }

  function stopDetectLoop(): void {
    if (detectTimer !== null) {
      window.clearTimeout(detectTimer);
      detectTimer = null;
    }
    clearOverlay();
  }

  async function capture(): Promise<void> {
    if (!stream) return;
    const dataUrl = grabFrame({ maxEdge: 1280, quality: 0.85 });
    if (!dataUrl) {
      setStatus('まだ映像が取得できていません');
      return;
    }

    setState('busy');
    setStatus('AI が解析しています…');

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          image: dataUrl,
          mode: 'analyze',
          hint: refs.hint?.value?.trim() || '',
        }),
      });
      const data = (await res.json()) as {
        raw?: string;
        json?: AnalyzeResult;
        error?: string;
        detail?: string;
        finishReason?: string;
      };
      if (!res.ok) {
        const msg = `解析エラー (${res.status}): ${data.error ?? '不明'}${
          data.detail ? `\n${summarizeGoogleError(data.detail)}` : ''
        }`;
        setStatus(msg);
        refs.onError?.(msg);
        setState(stream ? 'running' : 'idle');
        return;
      }
      const result: AnalyzeResult = {
        ...(data.json ?? {}),
        raw: data.raw,
        finishReason: data.finishReason,
      };
      if (result.items?.length) {
        lastItems = result.items;
        drawDigitalOverlay(result.items);
      }
      setState(stream ? 'running' : 'idle');
      setStatus(result.items?.length ? `${result.items.length} 項目を読み取りました` : '解析が完了しました');
      refs.onAnalyze?.(result);
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

  function syncOverlaySize(): void {
    const rect = refs.video.getBoundingClientRect();
    refs.overlay.width = Math.max(1, Math.round(rect.width * window.devicePixelRatio));
    refs.overlay.height = Math.max(1, Math.round(rect.height * window.devicePixelRatio));
    drawLiveOverlay(lastItems);
  }

  function clearOverlay(): void {
    const ctx = refs.overlay.getContext('2d');
    ctx?.clearRect(0, 0, refs.overlay.width, refs.overlay.height);
  }

  /** 連続検知用：bbox 枠のみ薄く描画（緑=高信頼, 黄=低信頼/手書き） */
  function drawLiveOverlay(items: ScanItem[]): void {
    const ctx = refs.overlay.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, refs.overlay.width, refs.overlay.height);
    items.forEach((it) => {
      const { x, y, w, h } = bboxToCanvas(it.bbox);
      const low = it.confidence === 'low' || it.kind === 'handwritten';
      ctx.lineWidth = 3 * window.devicePixelRatio;
      ctx.strokeStyle = low ? 'rgba(245, 200, 50, 0.95)' : 'rgba(34, 197, 94, 0.95)';
      ctx.fillStyle = low ? 'rgba(245, 200, 50, 0.18)' : 'rgba(34, 197, 94, 0.18)';
      roundRect(ctx, x, y, w, h, 8 * window.devicePixelRatio);
      ctx.fill();
      ctx.stroke();
    });
  }

  /** 撮影確定後：bbox 枠 + 半透明テキストオーバーレイで結果を可視化 */
  function drawDigitalOverlay(items: ScanItem[]): void {
    const ctx = refs.overlay.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, refs.overlay.width, refs.overlay.height);
    items.forEach((it) => {
      const { x, y, w, h } = bboxToCanvas(it.bbox);
      const low = it.confidence === 'low' || it.kind === 'handwritten';
      ctx.lineWidth = 3 * window.devicePixelRatio;
      ctx.strokeStyle = low ? 'rgba(245, 200, 50, 0.95)' : 'rgba(34, 197, 94, 0.95)';
      ctx.fillStyle = low ? 'rgba(245, 200, 50, 0.20)' : 'rgba(34, 197, 94, 0.20)';
      roundRect(ctx, x, y, w, h, 8 * window.devicePixelRatio);
      ctx.fill();
      ctx.stroke();

      const text = it.value ? `${it.label}: ${it.value}` : `${it.label} (要確認)`;
      const fontSize =
        Math.max(12, Math.min(20, w / Math.max(8, text.length)) * 1.2) * window.devicePixelRatio;
      ctx.font = `${fontSize}px system-ui, -apple-system, sans-serif`;
      const padding = 6 * window.devicePixelRatio;
      const metrics = ctx.measureText(text);
      const tw = metrics.width + padding * 2;
      const th = fontSize + padding * 1.4;
      const tx = x;
      const ty = Math.max(0, y - th - 4 * window.devicePixelRatio);
      ctx.fillStyle = low ? 'rgba(180, 130, 0, 0.92)' : 'rgba(20, 120, 60, 0.92)';
      roundRect(ctx, tx, ty, tw, th, 6 * window.devicePixelRatio);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.98)';
      ctx.fillText(text, tx + padding, ty + fontSize + padding * 0.2);
    });
  }

  function bboxToCanvas(bbox: [number, number, number, number]): {
    x: number;
    y: number;
    w: number;
    h: number;
  } {
    const [ymin, xmin, ymax, xmax] = bbox;
    const W = refs.overlay.width;
    const H = refs.overlay.height;
    const x = (xmin / 1000) * W;
    const y = (ymin / 1000) * H;
    const w = ((xmax - xmin) / 1000) * W;
    const h = ((ymax - ymin) / 1000) * H;
    return { x, y, w, h };
  }

  function roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function setState(state: ScanState): void {
    if (refs.shotBtn) refs.shotBtn.disabled = state !== 'running';
    refs.detectToggle.disabled = state === 'idle' || state === 'busy';
    refs.onStateChange?.(state);
  }

  function setStatus(text: string): void {
    refs.status.textContent = text;
  }

  function describeMediaError(err: unknown): string {
    const name = (err as { name?: string })?.name ?? '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'カメラへのアクセスが許可されていません。ブラウザの設定から許可してください。';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'カメラが見つかりませんでした。';
    }
    if (name === 'NotReadableError') {
      return 'カメラを他のアプリが使用中です。';
    }
    return `カメラを起動できませんでした: ${String(err)}`;
  }

  return {
    start,
    stop,
    capture,
    clearOverlay,
    isRunning: () => stream !== null,
  };
}

/**
 * Google Generative Language API のエラーレスポンス本文から
 * 人間が読みやすい 1 行サマリを作る。
 * 期待される形:
 *   {"error":{"code":429,"message":"...","status":"RESOURCE_EXHAUSTED",
 *             "details":[{"@type":".../QuotaFailure","violations":[{"quotaMetric":"...","quotaId":"..."}]}]}}
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
