/**
 * getUserMedia でカメラを起動し、静止フレームを /api/scan に送って結果を表示。
 * AR ハイライト等の演出は次フェーズ。
 */

interface CameraRefs {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  startBtn: HTMLButtonElement;
  shotBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  status: HTMLElement;
  result: HTMLElement;
  hint: HTMLInputElement | null;
}

export function initCameraScan(refs: CameraRefs): void {
  let stream: MediaStream | null = null;

  refs.startBtn.addEventListener('click', start);
  refs.stopBtn.addEventListener('click', stop);
  refs.shotBtn.addEventListener('click', capture);

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
      setControls('running');
      setStatus('カメラ起動中。撮影ボタンで解析します。');
    } catch (err) {
      setControls('idle');
      setStatus(`カメラを起動できませんでした: ${String(err)}`);
    }
  }

  function stop(): void {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    refs.video.srcObject = null;
    setControls('idle');
    setStatus('停止中。');
  }

  async function capture(): Promise<void> {
    if (!stream) return;
    const w = refs.video.videoWidth;
    const h = refs.video.videoHeight;
    if (!w || !h) {
      setStatus('まだ映像が取得できていません。');
      return;
    }
    refs.canvas.width = w;
    refs.canvas.height = h;
    const ctx = refs.canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(refs.video, 0, 0, w, h);
    const dataUrl = refs.canvas.toDataURL('image/jpeg', 0.85);

    setControls('busy');
    setStatus('Gemini Vision に送信中…');
    refs.result.textContent = '';

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, hint: refs.hint?.value ?? '' }),
      });
      const data = (await res.json()) as { raw?: string; json?: unknown; error?: string };
      if (!res.ok) {
        setStatus(`解析エラー (${res.status}): ${data.error ?? '不明'}`);
        return;
      }
      refs.result.textContent = JSON.stringify(data.json ?? data.raw ?? data, null, 2);
      setStatus('解析完了。');
    } catch (err) {
      setStatus(`通信エラー: ${String(err)}`);
    } finally {
      setControls(stream ? 'running' : 'idle');
    }
  }

  function setControls(state: 'idle' | 'running' | 'busy'): void {
    refs.startBtn.disabled = state !== 'idle';
    refs.stopBtn.disabled = state === 'idle';
    refs.shotBtn.disabled = state !== 'running';
  }

  function setStatus(text: string): void {
    refs.status.textContent = text;
  }
}
