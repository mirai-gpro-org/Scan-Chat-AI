/**
 * カメラ起動 → 撮影 → /api/scan に画像を 1 枚まるごと POST → Markdown 受信。
 *
 * - 画像は分割しない。canvas からそのまま 1 枚を JPEG dataURL 化して送る。
 * - サーバ応答は { markdown, finishReason } の JSON。下流診断 AI も Markdown
 *   をそのまま消費するため、H2 + bbox HTML コメントで領域メタを埋め込む。
 */

/** 1 領域分のデータ (Markdown を parse した結果) */
export interface RegionResult {
  /** 領域ラベル (H2 見出し) */
  label: string;
  /** 正規化 bbox [ymin, xmin, ymax, xmax] (0.0-1.0)。HTML コメントから抽出。 */
  bbox?: [number, number, number, number];
  /** 領域内の Markdown 本文 (見出し直下〜次の H2 までのテキスト) */
  body: string;
}

export interface AnalyzeResult {
  /** 全体の生 Markdown (下流診断 AI へ渡す形) */
  markdown: string;
  /** 領域ごとに切り分けたメタデータ + 本文 (UI 表示用) */
  regions: RegionResult[];
  /** 表示用フル画像 URL (objectURL) */
  fullImage?: string;
  /** Gemini finishReason */
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
    const frame = await grabFrameDataUrl({ maxEdge: 2400, quality: 0.92 });
    if (!frame) {
      setStatus('まだ映像が取得できていません');
      return;
    }
    refs.onCapture?.(frame.dataUrl);

    setState('busy');
    setStatus('🔬 AI が紙面を精密読解中… (精度優先モード)');

    const userHint = refs.hint?.value?.trim() || '';

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: frame.dataUrl, hint: userHint || undefined }),
      });
      if (!res.ok) {
        const msg = await readErrorMessage(res);
        setStatus(msg);
        refs.onError?.(msg);
        setState(stream ? 'running' : 'idle');
        return;
      }
      const data = (await res.json()) as {
        markdown?: string;
        finishReason?: string;
      };
      const markdown = stripMarkdownCodeFence(String(data.markdown ?? ''));
      if (!markdown.trim()) {
        const reason = data.finishReason ?? 'UNKNOWN';
        const msg = `内容が検出されませんでした (finishReason: ${reason})`;
        setStatus(msg);
        refs.onError?.(msg);
        setState(stream ? 'running' : 'idle');
        return;
      }

      const regions = parseMarkdownRegions(markdown);
      const totalRows = regions.reduce(
        (sum, r) => sum + countTableRows(r.body),
        0,
      );
      const result: AnalyzeResult = {
        markdown,
        regions,
        fullImage: frame.dataUrl,
        finishReason: data.finishReason,
      };
      setState(stream ? 'running' : 'idle');
      setStatus(
        totalRows
          ? `${regions.length} 領域 / ${totalRows} 行を読み取りました`
          : `${regions.length} 領域を読み取りました`,
      );
      refs.onAnalyze?.(result);
    } catch (err) {
      const msg = `通信エラー: ${String(err)}`;
      setStatus(msg);
      refs.onError?.(msg);
      setState(stream ? 'running' : 'idle');
    }
  }

  async function grabFrameDataUrl(opts: {
    maxEdge: number;
    quality: number;
  }): Promise<{ dataUrl: string } | null> {
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
    const dataUrl = refs.canvas.toDataURL('image/jpeg', opts.quality);
    return { dataUrl };
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
// Markdown パース: H2 (## ラベル) で領域に切り分け、HTML コメント
// から bbox を抽出する。
// ============================================================

const HEADING_REGEX = /^##\s+(.+?)\s*$/;
const BBOX_COMMENT_REGEX = /<!--\s*bbox\s*:\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*-->/i;

export function parseMarkdownRegions(md: string): RegionResult[] {
  const lines = md.split('\n');
  const regions: RegionResult[] = [];
  let current: { label: string; bodyLines: string[]; bbox?: [number, number, number, number] } | null = null;
  for (const line of lines) {
    const h = HEADING_REGEX.exec(line);
    if (h) {
      if (current) regions.push(finalize(current));
      current = { label: h[1].trim(), bodyLines: [] };
      continue;
    }
    if (current) {
      const b = BBOX_COMMENT_REGEX.exec(line);
      if (b && !current.bbox) {
        current.bbox = [
          clamp01(parseFloat(b[1])),
          clamp01(parseFloat(b[2])),
          clamp01(parseFloat(b[3])),
          clamp01(parseFloat(b[4])),
        ];
        // bbox コメント行は body には含めない
        continue;
      }
      current.bodyLines.push(line);
    }
  }
  if (current) regions.push(finalize(current));
  return regions;
}

function finalize(c: {
  label: string;
  bodyLines: string[];
  bbox?: [number, number, number, number];
}): RegionResult {
  return {
    label: c.label,
    bbox: c.bbox,
    body: c.bodyLines.join('\n').trim(),
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** GFM テーブル本文の行数を雑にカウント (区切り行 `|---|` を除く) */
function countTableRows(body: string): number {
  let count = 0;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    // ヘッダ/区切り行を除外
    if (/^\|\s*-+/.test(trimmed) || /^\|\s*:?-+/.test(trimmed)) continue;
    count++;
  }
  // 最初の 1 行は表ヘッダなので 1 引く
  return Math.max(0, count - 1);
}

/** モデルが \`\`\`markdown ... \`\`\` で全体を包んできた場合に剥がす */
function stripMarkdownCodeFence(text: string): string {
  const t = text.trim();
  const m = /^```(?:markdown|md)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(t);
  return m ? m[1].trim() : t;
}

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
