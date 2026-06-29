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
            <span>QRコードが見えるようにかざしてください。</span>
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

  const now = performance.now();
  if (now - scanTimer < 500) {
    return;
  }
  scanTimer = now;

  scanInFlight = true;
  try {
    const frame = await detector.scanCurrentFrame();
    if (!frame) {
      return;
    }

    drawFrame(previewCanvas, frame.frameCanvas, frame.detections, {
      labelFormatter: (detection) => detection.id,
    });

    const addedRecords = inventory.addDetections(frame.detections);
    if (addedRecords.length) {
      renderStatus(status, `${inventory.getCount()}件のQRを検出しました。`, 'ready');
    } else if (!inventory.getCount()) {
      renderStatus(status, 'QRを検出中です。', 'neutral');
    }

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
}

refreshPanels();
