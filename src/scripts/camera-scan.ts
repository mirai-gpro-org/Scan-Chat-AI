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

/**
 * 並列分割パイプライン:
 *   1. 撮影 → フル画像 dataURL
 *   2. POST /api/scan-layout で領域 (regions) を検出
 *   3. クライアントで各領域を canvas で切り出し
 *   4. POST /api/scan を全領域分 並列に投げる
 *   5. 結果をマージ
 *
 * これで 1 撮影あたりの体感時間が 1/N (N = 領域数) に縮み、
 * 同時にユーザー確認の単位 = 領域になる。
 */

/** /api/scan-layout が返す領域メタ */
export interface RegionMeta {
  id: string;
  label: string;
  /** 後続転記 AI 向けのタスクヒント（layout LLM が生成） */
  task?: string;
  /** 元画像座標系での 0-1000 正規化 bbox [ymin, xmin, ymax, xmax] */
  bbox: [number, number, number, number];
}

/** /api/scan が領域ごとに返す圧縮スキーマの items[] */
export interface RegionItem {
  /** cols と同順の値配列 */
  r: string[];
  /** クロップ後画像内での bbox (0-1000) */
  b: [number, number, number, number];
  /** 信頼度: high / low */
  c: 'h' | 'l';
  /** 種別: printed / handwritten */
  k: 'p' | 'w';
  /** 赤丸・下線等の強調 (true 時のみ) */
  x?: boolean;
}

/** /api/scan が領域ごとに返す表外メモ */
export interface RegionNote {
  t: string;
  b?: [number, number, number, number];
  c?: 'h' | 'l';
}

/** 1 領域分の完成データ (メタ + 転記結果) */
export interface RegionResult extends RegionMeta {
  /** 切り出した画像 (UI 表示・再撮影用) */
  croppedImage?: string;
  cols?: string[];
  items?: RegionItem[];
  notes?: RegionNote[];
  /** その領域の生 raw / finishReason / エラー */
  raw?: string;
  finishReason?: string;
  error?: string;
}

export interface AnalyzeResult {
  regions: RegionResult[];
  /** フル画像 (UI 表示用) */
  fullImage?: string;
  /** レイアウト検出フェーズの raw (デバッグ用) */
  layoutRaw?: string;
}

// 旧 ScanItem は AR detect モードでまだ使われるので残す
export interface ScanItem {
  label: string;
  value: string;
  bbox: [number, number, number, number];
  confidence: 'high' | 'low';
  kind: 'printed' | 'handwritten';
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
    // 転記用の高解像度版（クロップ後にこれをサーバへ送る）
    const fullImage = grabFrame({ maxEdge: 1500, quality: 0.78 });
    if (!fullImage) {
      setStatus('まだ映像が取得できていません');
      return;
    }
    // レイアウト検出用の軽量版（領域の位置検出だけなので低解像度で十分）
    // → 司令塔 LLM への送信が軽くなり Phase 1 が高速化する
    const layoutImage = grabFrame({ maxEdge: 1000, quality: 0.7 });

    setState('busy');

    try {
      // ===== Phase 1: レイアウト検出 =====
      setStatus('🗺️ レイアウト検出中…');
      const layoutFetch = await fetch('/api/scan-layout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: layoutImage ?? fullImage }),
      });
      const layoutData = await readJsonResponse(layoutFetch);
      if (!layoutFetch.ok || !layoutData) {
        const msg = formatError('レイアウト検出エラー', layoutFetch.status, layoutData);
        setStatus(msg);
        refs.onError?.(msg);
        setState(stream ? 'running' : 'idle');
        return;
      }
      const regions: RegionMeta[] = Array.isArray(layoutData.json?.regions)
        ? layoutData.json.regions
        : [];
      if (regions.length === 0) {
        const msg = '領域が検出されませんでした。撮影し直してください。';
        setStatus(msg);
        refs.onError?.(msg);
        setState(stream ? 'running' : 'idle');
        return;
      }

      // ===== Phase 2: 各領域をクライアントでクロップ =====
      setStatus(`✂️ ${regions.length} 領域に分割中…`);
      const cropped = await Promise.all(
        regions.map((region) => cropFromDataUrl(fullImage, region.bbox)),
      );

      // ===== Phase 3: 並列で /api/scan に投げる =====
      setStatus(`⚡ ${regions.length} 領域を並列解析中…`);
      const userHint = refs.hint?.value?.trim() || '';
      const transcriptions = await Promise.all(
        regions.map(async (region, i): Promise<RegionResult> => {
          // 司令塔 LLM が生成した task ヒントを per-region prompt に組み込む。
          // task が無ければ label を fallback として使う。
          const taskHint = region.task?.trim() || region.label;
          const hintParts = [`領域「${region.label}」の転記: ${taskHint}`];
          if (userHint) hintParts.push(userHint);
          try {
            const res = await fetch('/api/scan', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                image: cropped[i],
                mode: 'analyze',
                hint: hintParts.join('\n'),
              }),
            });
            const data = await readJsonResponse(res);
            if (!res.ok || !data) {
              return {
                ...region,
                croppedImage: cropped[i],
                error: formatError('転記エラー', res.status, data),
              };
            }
            return {
              ...region,
              croppedImage: cropped[i],
              cols: data.json?.cols,
              items: data.json?.items,
              notes: data.json?.notes,
              raw: typeof data.raw === 'string' ? data.raw : undefined,
              finishReason:
                typeof data.finishReason === 'string' ? data.finishReason : undefined,
            };
          } catch (err) {
            return {
              ...region,
              croppedImage: cropped[i],
              error: `通信エラー: ${String(err)}`,
            };
          }
        }),
      );

      // ===== Phase 4: マージして UI へ =====
      const totalItems = transcriptions.reduce((sum, r) => sum + (r.items?.length ?? 0), 0);
      const result: AnalyzeResult = {
        regions: transcriptions,
        fullImage,
        layoutRaw: typeof layoutData.raw === 'string' ? layoutData.raw : undefined,
      };
      setState(stream ? 'running' : 'idle');
      setStatus(
        totalItems
          ? `${transcriptions.length} 領域 / ${totalItems} 項目を読み取りました`
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

/**
 * dataURL の画像を、0-1000 正規化された bbox 領域だけ切り出して
 * 新しい dataURL を返す。並列分割パイプライン Phase 2 で使用。
 */
async function cropFromDataUrl(
  dataUrl: string,
  bbox: [number, number, number, number],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = (): void => {
      const [ymin, xmin, ymax, xmax] = bbox;
      const sx = Math.max(0, (xmin / 1000) * img.naturalWidth);
      const sy = Math.max(0, (ymin / 1000) * img.naturalHeight);
      const sw = Math.min(img.naturalWidth - sx, ((xmax - xmin) / 1000) * img.naturalWidth);
      const sh = Math.min(img.naturalHeight - sy, ((ymax - ymin) / 1000) * img.naturalHeight);
      if (sw <= 0 || sh <= 0) {
        reject(new Error('invalid bbox dimensions'));
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(sw);
      canvas.height = Math.round(sh);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('canvas context unavailable'));
        return;
      }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = (): void => reject(new Error('image load failed'));
    img.src = dataUrl;
  });
}

/**
 * fetch のレスポンスを安全に JSON として読む。
 * Vercel タイムアウト等で body が JSON でない場合は { error: <truncated text> } を返す。
 */
interface ScanResponseBody {
  raw?: unknown;
  json?: {
    cols?: string[];
    items?: RegionItem[];
    notes?: RegionNote[];
    regions?: RegionMeta[];
  };
  error?: unknown;
  detail?: string;
  finishReason?: unknown;
}

async function readJsonResponse(res: Response): Promise<ScanResponseBody | null> {
  try {
    const text = await res.text();
    try {
      return JSON.parse(text) as ScanResponseBody;
    } catch {
      return { error: text.slice(0, 500) };
    }
  } catch {
    return null;
  }
}

function formatError(prefix: string, status: number, data: ScanResponseBody | null): string {
  const errorText =
    typeof data?.error === 'string'
      ? data.error
      : data?.error
        ? JSON.stringify(data.error).slice(0, 300)
        : '不明';
  const detail = data?.detail ? `\n${summarizeGoogleError(data.detail)}` : '';
  return `${prefix} (${status}): ${errorText}${detail}`;
}
