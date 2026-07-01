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
          <div id="resolutionInfo" class="resolution-info">
            <span>Video: -</span>
            <span>Canvas: 640x480px</span>
          </div>
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
          <button id="debugModeButton" class="tab-button" type="button" role="tab">
            デバッグ
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

        <section id="debugPanel" class="panel is-hidden" aria-label="デバッグ">
          <div class="panel__head">
            <h2>デバッグモード</h2>
          </div>
          <p class="lede" style="font-size: 0.86rem; margin-top: 8px; margin-bottom: 16px; color: var(--muted); line-height: 1.4;">
            画像をアップロードして、YOLOv8n領域検出とZXingデコードを実行します。
          </p>
          <div style="display: grid; gap: 12px; margin-bottom: 16px;">
            <label class="secondary-button" style="text-align: center; display: block; cursor: pointer; border: 1px dashed var(--accent); padding: 14px 18px; border-radius: var(--radius-md);">
              画像を選択
              <input type="file" id="debugImageInput" accept="image/*" style="display: none;" />
            </label>
            <div id="debugFileName" style="font-size: 0.86rem; color: var(--accent); word-break: break-all; text-align: center; display: none;"></div>
            <div style="display: flex; gap: 8px; align-items: center; justify-content: space-between; background: rgba(5, 13, 22, 0.5); padding: 10px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border);">
              <span style="font-size: 0.9rem;">YOLOモデルを使用:</span>
              <input type="checkbox" id="debugUseModel" checked style="width: 20px; height: 20px; cursor: pointer; accent-color: var(--accent);" />
            </div>
            <button id="runDebugButton" class="primary-button" type="button" disabled style="width: 100%; border-radius: var(--radius-md); padding: 14px;">検出実行</button>
          </div>
          <h3>検出結果サマリー</h3>
          <div class="summary-grid" style="margin-bottom: 16px;">
            <div class="summary-tile">
              <span class="summary-tile__label">検出候補</span>
              <strong id="debugCandidatesCount">0</strong>
            </div>
            <div class="summary-tile">
              <span class="summary-tile__label">デコード成功</span>
              <strong id="debugDecodedCount">0</strong>
            </div>
          </div>
          <h3>詳細ログ / タイミング</h3>
          <pre id="debugTimingBreakdown" class="json-preview" style="min-height: 150px; font-size: 0.76rem;">タイミング情報: -</pre>
          <h3>検出データ (JSON)</h3>
          <pre id="debugResultJson" class="json-preview" style="min-height: 150px; font-size: 0.76rem;">{}</pre>
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
const debugModeButton = document.querySelector('#debugModeButton');
const livePanel = document.querySelector('#livePanel');
const listPanel = document.querySelector('#listPanel');
const debugPanel = document.querySelector('#debugPanel');
const inventoryList = document.querySelector('#inventoryList');
const jsonPreview = document.querySelector('#jsonPreview');
const timingBreakdown = document.querySelector('#timingBreakdown');
const countValue = document.querySelector('#countValue');
const fpsValue = document.querySelector('#fpsValue');
const listCount = document.querySelector('#listCount');
const resolutionInfo = document.querySelector('#resolutionInfo');
const stage = document.querySelector('.stage');

const debugImageInput = document.querySelector('#debugImageInput');
const debugFileName = document.querySelector('#debugFileName');
const debugUseModel = document.querySelector('#debugUseModel');
const runDebugButton = document.querySelector('#runDebugButton');
const debugCandidatesCount = document.querySelector('#debugCandidatesCount');
const debugDecodedCount = document.querySelector('#debugDecodedCount');
const debugTimingBreakdown = document.querySelector('#debugTimingBreakdown');
const debugResultJson = document.querySelector('#debugResultJson');

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
debugModeButton.addEventListener('click', () => setMode('debug'));

let uploadedImage = null;
const debugImageCanvas = document.createElement('canvas');
const debugImageContext = debugImageCanvas.getContext('2d');

debugImageInput.addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) {
    return;
  }

  debugFileName.textContent = `選択中: ${file.name}`;
  debugFileName.style.display = 'block';
  
  const reader = new FileReader();
  reader.onload = (e) => {
    uploadedImage = new Image();
    uploadedImage.onload = () => {
      // Draw image to helper canvas
      debugImageCanvas.width = uploadedImage.naturalWidth;
      debugImageCanvas.height = uploadedImage.naturalHeight;
      debugImageContext.drawImage(uploadedImage, 0, 0);

      // Render image directly on previewCanvas
      previewCanvas.width = uploadedImage.naturalWidth;
      previewCanvas.height = uploadedImage.naturalHeight;
      const previewContext = previewCanvas.getContext('2d');
      previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      previewContext.drawImage(uploadedImage, 0, 0);

      canvasHint.classList.add('is-hidden');
      runDebugButton.removeAttribute('disabled');
      renderStatus(status, '画像がロードされました。検出実行を押してください。', 'ready');
      updateResolutionDisplay();

      // Auto run detection
      runDebugDetection();
    };
    uploadedImage.src = e.target.result;
  };
  reader.readAsDataURL(file);
});

runDebugButton.addEventListener('click', () => {
  runDebugDetection();
});

async function runDebugDetection() {
  if (!uploadedImage) {
    return;
  }

  const useModel = debugUseModel.checked;
  renderStatus(status, 'モデル検出を実行中...', 'ready');
  runDebugButton.setAttribute('disabled', 'true');

  try {
    const result = await detector.scanCanvas(debugImageCanvas, { useModel });
    if (!result) {
      renderStatus(status, '画像スキャンに失敗しました。', 'error');
      return;
    }

    // Redraw image and overlays
    drawFrame(previewCanvas, debugImageCanvas, result.overlayDetections, {
      labelFormatter: (detection) => detection.label ?? detection.id,
    });
    updateResolutionDisplay();

    // Update counts
    debugCandidatesCount.textContent = String(result.candidates.length);
    debugDecodedCount.textContent = String(result.detections.length);

    // Update timings
    const timingLines = [
      `合計時間: ${formatMs(result.timings.totalMs)}`,
      `候補選定: ${formatMs(result.timings.candidateMs)}`,
      `  モデル処理: ${formatMs(result.timings.modelMs)}`,
      `    前処理: ${formatMs(result.timings.modelPreprocessMs)}`,
      `    推論: ${formatMs(result.timings.modelInferenceMs)}`,
      `    パース: ${formatMs(result.timings.modelParseMs)}`,
      `  ネイティブ検出: ${formatMs(result.timings.nativeMs)}`,
      `  フォールバック格子: ${formatMs(result.timings.fallbackMs)}`,
      `zxingデコード: ${formatMs(result.timings.decodeMs)}`,
    ];
    debugTimingBreakdown.textContent = timingLines.join('\n');

    // Update result json
    debugResultJson.textContent = JSON.stringify({
      candidates: result.candidates.map(c => ({
        source: c.source,
        score: c.score,
        bounds: c.bounds,
      })),
      detections: result.detections.map(d => ({
        id: d.id,
        source: d.source,
        score: d.score,
        decodeMs: d.decodeMs,
      }))
    }, null, 2);

    renderStatus(status, `デバッグ検出完了。候補数: ${result.candidates.length}、成功数: ${result.detections.length}`, 'ready');
  } catch (error) {
    renderStatus(status, `検出エラー: ${error.message}`, 'error');
    debugResultJson.textContent = JSON.stringify({ error: error.message }, null, 2);
  } finally {
    runDebugButton.removeAttribute('disabled');
  }
}

function setMode(nextMode) {
  mode = nextMode;
  const isLive = mode === 'live';
  const isList = mode === 'list';
  const isDebug = mode === 'debug';

  liveModeButton.classList.toggle('is-active', isLive);
  listModeButton.classList.toggle('is-active', isList);
  debugModeButton.classList.toggle('is-active', isDebug);

  livePanel.classList.toggle('is-hidden', !isLive);
  listPanel.classList.toggle('is-hidden', !isList);
  debugPanel.classList.toggle('is-hidden', !isDebug);

  if (isDebug) {
    if (detector.isRunning()) {
      stopCamera();
    }
    // Set hint for debug mode
    canvasHint.innerHTML = `
      <strong>Debug Mode</strong>
      <span>右側のパネルからデバッグ用の画像をアップロードして「検出実行」ボタンを押してください。</span>
    `;
    canvasHint.classList.remove('is-hidden');
    // Clear canvas or show uploaded image if exists
    const context = previewCanvas.getContext('2d');
    if (uploadedImage) {
      previewCanvas.width = uploadedImage.naturalWidth;
      previewCanvas.height = uploadedImage.naturalHeight;
      context.drawImage(uploadedImage, 0, 0);
      canvasHint.classList.add('is-hidden');
    } else {
      previewCanvas.width = 640;
      previewCanvas.height = 480;
      context.fillStyle = '#09111a';
      context.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    }
  } else {
    // Restore default hint
    canvasHint.innerHTML = `
      <strong>Start camera</strong>
      <span>通常は zxing で検出します。画面をクリック/タップするとモデル矩形選択を実行します。</span>
    `;
    if (detector.isRunning()) {
      canvasHint.classList.add('is-hidden');
    } else {
      canvasHint.classList.remove('is-hidden');
      const context = previewCanvas.getContext('2d');
      previewCanvas.width = 640;
      previewCanvas.height = 480;
      context.fillStyle = '#09111a';
      context.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    }
  }
  updateResolutionDisplay();
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
    updateResolutionDisplay();
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
  updateResolutionDisplay();
}

function updateResolutionDisplay() {
  if (!resolutionInfo) return;

  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  const canvasWidth = previewCanvas.width;
  const canvasHeight = previewCanvas.height;

  const videoText = detector.isRunning() && videoWidth && videoHeight 
    ? `${videoWidth}x${videoHeight}px` 
    : '-';
  
  const canvasText = canvasWidth && canvasHeight 
    ? `${canvasWidth}x${canvasHeight}px` 
    : '-';

  resolutionInfo.innerHTML = `
    <span>Video: ${videoText}</span>
    <span>Canvas: ${canvasText}</span>
  `;

  if (stage && canvasWidth && canvasHeight) {
    stage.style.aspectRatio = `${canvasWidth} / ${canvasHeight}`;
  }
}

function formatMs(value) {
  return `${Number(value ?? 0).toFixed(1)}ms`;
}

refreshPanels();
updateResolutionDisplay();
