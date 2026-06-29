import './style.css';
import { InventoryStore } from './inventory.js';
import { QrDetector } from './qrDetector.js';
import { drawFrame, renderInventoryList, renderStatus } from './renderer.js';

const app = document.querySelector('#app');


app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="topbar__copy">
        <p class="eyebrow">QR棚卸プロトタイプ</p>
        <h1>Camera-based QR inventory</h1>
        <p class="lede">
          カメラ映像を canvas に描画し、複数の QR を同時に検出して座標付きで記録します。
        </p>
      </div>
      <div class="topbar__actions">
        <button id="cameraToggle" class="primary-button" type="button">カメラを起動</button>
        <button id="exportButton" class="secondary-button" type="button">JSON を export</button>
      </div>
    </header>

    <main class="workspace">
      <section class="stage-card">
        <div class="stage-card__header">
          <div>
            <h2>検出 canvas</h2>
            <p>元画像の上に QR 領域を polygon で重ねています。</p>
          </div>
          <div id="status" class="status status--neutral">カメラ待機中</div>
        </div>

        <div class="stage">
          <video id="cameraVideo" class="camera-video" playsinline muted></video>
          <canvas id="previewCanvas" class="preview-canvas" aria-label="QR検出結果のcanvas"></canvas>
          <div id="canvasHint" class="canvas-hint">
            <strong>Start camera</strong>
            <span>通常は zxing で検出します。画面をクリック/タップするとモデル矩形選択を実行します。</span>
          </div>
        </div>
      </section>

      <aside class="sidebar">
        <div class="sidebar__tabs" role="tablist" aria-label="閲覧モード">
          <button id="liveModeButton" class="tab-button is-active" type="button" role="tab">
            ライブ
          </button>
          <button id="listModeButton" class="tab-button" type="button" role="tab">
            一覧
          </button>
        </div>

        <section id="livePanel" class="panel">
          <h2>検出サマリー</h2>
          <div class="summary-grid">
            <div class="summary-tile">
              <span class="summary-tile__label">検出済み</span>
              <strong id="countValue">0</strong>
            </div>
            <div class="summary-tile">
              <span class="summary-tile__label">重複排除</span>
              <strong>ON</strong>
            </div>
            <div class="summary-tile">
              <span class="summary-tile__label">検出FPS</span>
              <strong id="fpsValue">-</strong>
            </div>
          </div>
          <pre id="timingBreakdown" class="json-preview">timing: -</pre>
          <pre id="jsonPreview" class="json-preview">{}</pre>
        </section>

        <section id="listPanel" class="panel is-hidden" aria-label="検出済みQR一覧">
          <div class="panel__head">
            <h2>検出済みQR一覧</h2>
            <span id="listCount" class="panel__count">0件</span>
          </div>
          <ul id="inventoryList" class="inventory-list"></ul>
        </section>
      </aside>
    </main>
  </div>
`;

const cameraButton = document.querySelector('#cameraToggle');
const exportButton = document.querySelector('#exportButton');
const video = document.querySelector('#cameraVideo');
const previewCanvas = document.querySelector('#previewCanvas');
const status = document.querySelector('#status');
const canvasHint = document.querySelector('#canvasHint');
const liveModeButton = document.querySelector('#liveModeButton');
const listModeButton = document.querySelector('#listModeButton');
const livePanel = document.querySelector('#livePanel');
const listPanel = document.querySelector('#listPanel');
const inventoryList = document.querySelector('#inventoryList');
const jsonPreview = document.querySelector('#jsonPreview');
const timingBreakdown = document.querySelector('#timingBreakdown');
const countValue = document.querySelector('#countValue');
const fpsValue = document.querySelector('#fpsValue');
const listCount = document.querySelector('#listCount');

const inventory = new InventoryStore();
const detector = new QrDetector({ videoElement: video });

let mode = 'live';
let scanning = false;
let scanInFlight = false;
let scanTimer = 0;
let animationFrameId = 0;
let lastScanEndTime = 0;
let fpsEma = 0;
let modelScanRequested = false;
let persistentModelOverlays = new Map();
const MODEL_OVERLAY_TTL_MS = 3000;

previewCanvas.addEventListener('pointerup', () => {
  if (!detector.isRunning()) {
    return;
  }

  modelScanRequested = true;
  renderStatus(status, 'モデル矩形選択を実行中です。', 'ready');
});

cameraButton.addEventListener('click', async () => {
  if (detector.isRunning()) {
    stopCamera();
    return;
  }

  try {
    await detector.startCamera();
    scanning = true;
    cameraButton.textContent = 'カメラを停止';
    canvasHint.classList.add('is-hidden');
    renderStatus(status, 'カメラ起動済み。QRをフレームに入れてください。', 'ready');
    loop();
  } catch (error) {
    renderStatus(status, `カメラを開始できません: ${error.message}`, 'error');
  }
});

exportButton.addEventListener('click', () => {
  const json = inventory.exportJSON();
  jsonPreview.textContent = json;

  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'qr-inventory.json';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
});

liveModeButton.addEventListener('click', () => setMode('live'));
listModeButton.addEventListener('click', () => setMode('list'));

function setMode(nextMode) {
  mode = nextMode;
  const isLive = mode === 'live';

  liveModeButton.classList.toggle('is-active', isLive);
  listModeButton.classList.toggle('is-active', !isLive);
  livePanel.classList.toggle('is-hidden', !isLive);
  listPanel.classList.toggle('is-hidden', isLive);
}

async function loop() {
  if (!scanning) {
    return;
  }

  animationFrameId = window.requestAnimationFrame(loop);
  if (scanInFlight) {
    return;
  }

  const useModel = modelScanRequested;
  const now = performance.now();
  if (!useModel && now - scanTimer < 100) {
    return;
  }
  scanTimer = now;
  modelScanRequested = false;

  scanInFlight = true;
  try {
    const scanStart = performance.now();
    const frame = await detector.scanCurrentFrame({ useModel });
    if (!frame) {
      return;
    }

    const now = performance.now();
    updatePersistentModelOverlays(frame.overlayDetections ?? [], now);

    const drawStart = performance.now();
    drawFrame(previewCanvas, frame.frameCanvas, getVisibleOverlayDetections(frame.overlayDetections ?? []), {
      labelFormatter: (detection) => detection.label ?? detection.id,
    });
    const drawMs = performance.now() - drawStart;

    const addedRecords = inventory.addDetections(frame.detections);
    if (addedRecords.length) {
      renderStatus(status, `${inventory.getCount()}件のQRを検出しました。`, 'ready');
    } else if (!inventory.getCount()) {
      renderStatus(status, 'QRを検出中です。', 'neutral');
    }

    updateTimingPanel(frame.timings, drawMs, performance.now() - scanStart);
    updateFpsMeter();
    refreshPanels();
  } finally {
    scanInFlight = false;
    lastScanEndTime = performance.now();
  }
}

function updateFpsMeter() {
  const now = performance.now();
  if (lastScanEndTime > 0) {
    const deltaMs = now - lastScanEndTime;
    if (deltaMs > 0) {
      const instantFps = 1000 / deltaMs;
      fpsEma = fpsEma ? fpsEma * 0.85 + instantFps * 0.15 : instantFps;
    }
  }

  fpsValue.textContent = fpsEma > 0 ? `${fpsEma.toFixed(1)} fps` : '-';
}

function updateTimingPanel(timings, drawMs, totalMs) {
  if (!timings) {
    timingBreakdown.textContent = 'timing: -';
    return;
  }

  const lines = [
    `total: ${formatMs(totalMs)}`,
    `frame copy: ${formatMs(timings.frameCopyMs)}`,
    `candidate select: ${formatMs(timings.candidateMs)}`,
    `model total: ${formatMs(timings.modelMs)}`,
    `  preprocess: ${formatMs(timings.modelPreprocessMs)}`,
    `  inference: ${formatMs(timings.modelInferenceMs)}`,
    `  parse: ${formatMs(timings.modelParseMs)}`,
    `native detect: ${formatMs(timings.nativeMs)}`,
    `fallback grid: ${formatMs(timings.fallbackMs)}`,
    `zxing decode: ${formatMs(timings.decodeMs)}`,
    `draw overlay: ${formatMs(drawMs)}`,
  ];

  timingBreakdown.textContent = lines.join('\n');
  console.table({
    totalMs,
    ...timings,
    drawMs,
  });
}

function updatePersistentModelOverlays(detections, now) {
  purgeExpiredModelOverlays(now);

  for (const detection of detections) {
    if (detection?.source !== 'model') {
      continue;
    }

    const key = getOverlayKey(detection);
    persistentModelOverlays.set(key, {
      detection,
      expiresAt: now + MODEL_OVERLAY_TTL_MS,
    });
  }
}

function getVisibleOverlayDetections(currentDetections) {
  const now = performance.now();
  purgeExpiredModelOverlays(now);

  const overlays = [];
  const seenKeys = new Set();

  for (const detection of currentDetections) {
    const key = getOverlayKey(detection);
    seenKeys.add(key);
    overlays.push(detection);
  }

  for (const { detection } of persistentModelOverlays.values()) {
    const key = getOverlayKey(detection);
    if (seenKeys.has(key)) {
      continue;
    }

    overlays.push(detection);
  }

  return overlays;
}

function purgeExpiredModelOverlays(now) {
  for (const [key, entry] of persistentModelOverlays.entries()) {
    if (entry.expiresAt <= now) {
      persistentModelOverlays.delete(key);
    }
  }
}

function getOverlayKey(detection) {
  const label = detection.label ?? detection.id ?? 'qr';
  const points = Array.isArray(detection.points)
    ? detection.points
        .map((point) => `${Math.round(point.x)}:${Math.round(point.y)}`)
        .join('|')
    : '';
  return `${detection.source ?? 'unknown'}:${label}:${points}`;
}

function refreshPanels() {
  const records = inventory.getRecords();
  countValue.textContent = String(records.length);
  listCount.textContent = `${records.length}件`;
  jsonPreview.textContent = inventory.exportJSON();
  renderInventoryList(inventoryList, records);
}

function stopCamera() {
  detector.stopCamera();
  scanning = false;
  cancelAnimationFrame(animationFrameId);
  cameraButton.textContent = 'カメラを起動';
  canvasHint.classList.remove('is-hidden');
  renderStatus(status, 'カメラ待機中', 'neutral');
  timingBreakdown.textContent = 'timing: -';
  persistentModelOverlays = new Map();
}

function formatMs(value) {
  return `${Number(value ?? 0).toFixed(1)}ms`;
}

refreshPanels();
