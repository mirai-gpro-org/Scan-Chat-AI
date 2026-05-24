/**
 * カメラ起動 → 撮影 → サーバ送信（バイナリ Blob）→ Markdown ストリーム受信。
 *
 * - base64 は一切使わない。撮影画像は canvas.toBlob() で Blob として保持し、
 *   multipart/form-data でサーバへバイナリ直送する。
 * - サーバは Files API 経由で Gemini に画像を渡し、応答は **Markdown** で
 *   1 chunk ずつ NDJSON で流す（Vercel のレスポンスバッファ詰まりを回避）。
 * - 下流の診断 AI も Markdown のまま消費する設計のため、JSON 強制を完全撤廃。
 *   AR 風オーバーレイ用の bbox は Markdown 内に HTML コメントで埋め込む。
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
    const previewUrl = URL.createObjectURL(blob);
    refs.onCapture?.(previewUrl);

    setState('busy');
    setStatus('📤 アップロード中…');

    const userHint = refs.hint?.value?.trim() || '';
    const formData = new FormData();
    formData.append('image', blob, 'scan.jpg');
    if (userHint) formData.append('hint', userHint);

    try {
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

      const holder: {
        markdown: string;
        finishReason?: string;
        err?: string;
      } = { markdown: '' };

      await readNdjsonStream(res, (ev) => {
        if (ev.type === 'start') {
          setStatus('📤 サーバ受信 → アップロード中…');
        } else if (ev.type === 'uploaded') {
          setStatus('🤖 AI 解析中…');
        } else if (ev.type === 'chunk') {
          const len = ev.totalLen ?? 0;
          setStatus(`📝 読み取り中… ${len.toLocaleString()} 文字`);
          refs.onStreamProgress?.(len);
        } else if (ev.type === 'done') {
          holder.markdown = String(ev.markdown ?? '');
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
      const markdown = stripMarkdownCodeFence(holder.markdown);
      if (!markdown.trim()) {
        const msg = '内容が検出されませんでした。撮影し直してください。';
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
        fullImage: previewUrl,
        finishReason: holder.finishReason,
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

// ============================================================
// ストリーム受信 (NDJSON)
// ============================================================

interface StreamEvent {
  type: 'start' | 'uploaded' | 'chunk' | 'done' | 'error';
  text?: string;
  totalLen?: number;
  markdown?: string;
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
        /* ignore partial / non-JSON lines */
      }
    }
  }
  if (buf.trim()) {
    try {
      onEvent(JSON.parse(buf.trim()) as StreamEvent);
    } catch {
      /* ignore */
    }
  }
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
