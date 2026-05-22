/**
 * getUserMedia でカメラを起動し、AR ハイライト（連続検知）と
 * 撮影確定時のフル解析の 2 つを担う。
 *
 * 提案書 機能1:
 *  - AR リアルタイム・ハイライト: 確信度が高い項目は緑、手書きや低信頼は黄。
 *  - デジタル・オーバーレイ: 撮影確定後、画像の真上に構造化値を半透明で重ねる。
 */

export interface ScanItem {
  label: string;
  value: string;
  bbox: [number, number, number, number]; // [ymin, xmin, ymax, xmax] 0-1000 で正規化
  confidence: 'high' | 'low';
  kind: 'printed' | 'handwritten';
}

interface CameraRefs {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement; // 撮影用（非表示）
  overlay: HTMLCanvasElement; // ライブ video の上に重ねる検知枠用
  startBtn: HTMLButtonElement;
  shotBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  detectToggle: HTMLInputElement;
  status: HTMLElement;
  result: HTMLElement;
  hint: HTMLInputElement | null;
}

const DETECT_INTERVAL_MS = 1800; // AR 連続検知の間隔（APIコスト抑制）
const DETECT_JPEG_QUALITY = 0.6;
const DETECT_MAX_EDGE = 720; // 検知用は縮小して送る

export function initCameraScan(refs: CameraRefs): void {
  let stream: MediaStream | null = null;
  let detectTimer: number | null = null;
  let detectBusy = false;
  let lastItems: ScanItem[] = [];

  refs.startBtn.addEventListener('click', start);
  refs.stopBtn.addEventListener('click', stop);
  refs.shotBtn.addEventListener('click', capture);
  refs.detectToggle.addEventListener('change', () => {
    if (refs.detectToggle.checked && stream) startDetectLoop();
    else stopDetectLoop();
  });
  refs.video.addEventListener('loadedmetadata', syncOverlaySize);
  window.addEventListener('resize', syncOverlaySize);

  setControls('idle');

  async function start(): Promise<void> {
    setStatus('カメラを起動中…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      });
      refs.video.srcObject = stream;
      await refs.video.play();
      syncOverlaySize();
      setControls('running');
      setStatus('カメラ起動中。AR 検知を ON にすると連続スキャンを開始します。');
      if (refs.detectToggle.checked) startDetectLoop();
    } catch (err) {
      setControls('idle');
      setStatus(`カメラを起動できませんでした: ${String(err)}`);
    }
  }

  function stop(): void {
    stopDetectLoop();
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    refs.video.srcObject = null;
    clearOverlay();
    lastItems = [];
    setControls('idle');
    setStatus('停止中。');
  }

  function startDetectLoop(): void {
    if (detectTimer !== null) return;
    setStatus('AR 検知 ON: 連続スキャン中…');
    const tick = async (): Promise<void> => {
      if (!stream || detectBusy) return scheduleNext();
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
    };
    const scheduleNext = (): void => {
      if (detectTimer === null) return;
      detectTimer = window.setTimeout(tick, DETECT_INTERVAL_MS);
    };
    detectTimer = window.setTimeout(tick, 100);
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
      setStatus('まだ映像が取得できていません。');
      return;
    }

    setControls('busy');
    setStatus('Gemini Vision に送信中…');
    refs.result.textContent = '';

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, mode: 'analyze', hint: refs.hint?.value ?? '' }),
      });
      const data = (await res.json()) as {
        raw?: string;
        json?: { items?: ScanItem[] } & Record<string, unknown>;
        error?: string;
      };
      if (!res.ok) {
        setStatus(`解析エラー (${res.status}): ${data.error ?? '不明'}`);
        return;
      }
      const items = data.json?.items ?? [];
      lastItems = items;
      drawDigitalOverlay(items);
      refs.result.textContent = JSON.stringify(data.json ?? data.raw ?? data, null, 2);
      setStatus(items.length ? `解析完了：${items.length} 項目` : '解析完了。');
    } catch (err) {
      setStatus(`通信エラー: ${String(err)}`);
    } finally {
      setControls(stream ? 'running' : 'idle');
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
      const fontSize = Math.max(12, Math.min(20, w / Math.max(8, text.length)) * 1.2) * window.devicePixelRatio;
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

  function setControls(state: 'idle' | 'running' | 'busy'): void {
    refs.startBtn.disabled = state !== 'idle';
    refs.stopBtn.disabled = state === 'idle';
    refs.shotBtn.disabled = state !== 'running';
    refs.detectToggle.disabled = state === 'idle' || state === 'busy';
  }

  function setStatus(text: string): void {
    refs.status.textContent = text;
  }
}
