import { BrowserQRCodeReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

const ZXING_HINTS = new Map([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]],
  [DecodeHintType.TRY_HARDER, true],
]);

export class QrDetector {
  constructor(options = {}) {
    this.videoElement = options.videoElement;
    this.reader = new BrowserQRCodeReader(ZXING_HINTS);
    this.nativeDetector = createNativeDetector();
    this.frameCanvas = document.createElement('canvas');
    this.frameContext = this.frameCanvas.getContext('2d', { willReadFrequently: true });
    this.cropCanvas = document.createElement('canvas');
    this.cropContext = this.cropCanvas.getContext('2d', { willReadFrequently: true });
  }

  async startCamera() {
    if (!this.videoElement) {
      throw new Error('videoElement is required');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
      },
      audio: false,
    });

    this.stopCamera();
    this.stream = stream;
    this.videoElement.srcObject = stream;
    this.videoElement.playsInline = true;
    this.videoElement.muted = true;

    await waitForVideoReady(this.videoElement);
    await this.videoElement.play();
    return stream;
  }

  stopCamera() {
    if (this.videoElement) {
      this.videoElement.pause?.();
      this.videoElement.srcObject = null;
    }

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
  }

  isRunning() {
    return Boolean(this.stream);
  }

  async scanCurrentFrame() {
    if (!this.videoElement || this.videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return null;
    }

    const width = this.videoElement.videoWidth;
    const height = this.videoElement.videoHeight;
    if (!width || !height) {
      return null;
    }

    this.frameCanvas.width = width;
    this.frameCanvas.height = height;
    this.frameContext.drawImage(this.videoElement, 0, 0, width, height);

    const nativeCandidates = await detectCandidates(this.nativeDetector, this.frameCanvas);
    const detections = await decodeCandidates({
      frameCanvas: this.frameCanvas,
      candidates: nativeCandidates.length ? nativeCandidates : buildGridCandidates(width, height),
      reader: this.reader,
      cropCanvas: this.cropCanvas,
      cropContext: this.cropContext,
    });

    return {
      frameCanvas: this.frameCanvas,
      width,
      height,
      detections,
    };
  }

  async scanCanvas(canvas) {
    const width = canvas.width;
    const height = canvas.height;
    if (!width || !height) {
      return [];
    }

    const nativeCandidates = await detectCandidates(this.nativeDetector, canvas);
    return decodeCandidates({
      frameCanvas: canvas,
      candidates: nativeCandidates.length ? nativeCandidates : buildGridCandidates(width, height),
      reader: this.reader,
      cropCanvas: this.cropCanvas,
      cropContext: this.cropContext,
    });
  }
}

async function detectCandidates(nativeDetector, canvas) {
  if (!nativeDetector) {
    return [];
  }

  try {
    const results = await nativeDetector.detect(canvas);
    return results
      .map((result) => {
        const points = normalizePoints(result.cornerPoints);
        if (points.length < 3) {
          return null;
        }
        return {
          points,
          bounds: inflateBounds(pointsToBounds(points), 20, canvas.width, canvas.height),
          source: 'native',
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function decodeCandidates({ frameCanvas, candidates, reader, cropCanvas, cropContext }) {
  const detections = [];
  const seenIds = new Set();

  for (const candidate of candidates) {
    const bounds = candidate.bounds ?? pointsToBounds(candidate.points);
    if (!bounds || bounds.width < 12 || bounds.height < 12) {
      continue;
    }

    const crop = cropArea(frameCanvas, cropCanvas, cropContext, bounds);
    if (!crop) {
      continue;
    }

    let result = null;
    try {
      result = reader.decodeFromCanvas(crop.canvas);
    } catch {
      continue;
    }

    if (!result) {
      continue;
    }

    const id = String(result.getText() ?? '').trim();
    if (!id || seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);

    const decodedPoints = normalizePoints(result.getResultPoints());
    const points =
      candidate.points?.length >= 4
        ? candidate.points
        : decodedPoints.length >= 3
          ? resultPointsToQuad(decodedPoints, crop.offsetX, crop.offsetY)
          : boundsToQuad(bounds);

    detections.push({
      id,
      points,
      frameWidth: frameCanvas.width,
      frameHeight: frameCanvas.height,
      timestamp: Date.now(),
    });
  }

  return detections;
}

function cropArea(sourceCanvas, cropCanvas, cropContext, bounds) {
  const x = Math.max(0, Math.floor(bounds.x));
  const y = Math.max(0, Math.floor(bounds.y));
  const width = Math.max(1, Math.min(sourceCanvas.width - x, Math.ceil(bounds.width)));
  const height = Math.max(1, Math.min(sourceCanvas.height - y, Math.ceil(bounds.height)));
  if (width <= 1 || height <= 1) {
    return null;
  }

  cropCanvas.width = width;
  cropCanvas.height = height;
  cropContext.clearRect(0, 0, width, height);
  cropContext.drawImage(sourceCanvas, x, y, width, height, 0, 0, width, height);

  return {
    canvas: cropCanvas,
    offsetX: x,
    offsetY: y,
  };
}

function buildGridCandidates(width, height) {
  const columns = width > 1600 ? 4 : width > 1000 ? 3 : 2;
  const rows = height > 1600 ? 4 : height > 1000 ? 3 : 2;
  const stepX = width / columns;
  const stepY = height / rows;
  const overlapX = stepX * 0.2;
  const overlapY = stepY * 0.2;
  const candidates = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = Math.max(0, Math.floor(column * stepX - overlapX / 2));
      const y = Math.max(0, Math.floor(row * stepY - overlapY / 2));
      const w = Math.min(width - x, Math.ceil(stepX + overlapX));
      const h = Math.min(height - y, Math.ceil(stepY + overlapY));
      candidates.push({
        points: boundsToQuad({ x, y, width: w, height: h }),
        bounds: { x, y, width: w, height: h },
        source: 'grid',
      });
    }
  }

  return candidates;
}

function pointsToBounds(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function inflateBounds(bounds, padding, maxWidth, maxHeight) {
  const x = Math.max(0, Math.floor(bounds.x - padding));
  const y = Math.max(0, Math.floor(bounds.y - padding));
  const width = Math.min(maxWidth - x, Math.ceil(bounds.width + padding * 2));
  const height = Math.min(maxHeight - y, Math.ceil(bounds.height + padding * 2));

  return { x, y, width, height };
}

function boundsToQuad(bounds) {
  return [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ];
}

function resultPointsToQuad(points, offsetX, offsetY) {
  const [bottomLeft, topLeft, topRight] = points;
  const bottomRight = {
    x: topRight.x - topLeft.x + bottomLeft.x,
    y: topRight.y - topLeft.y + bottomLeft.y,
  };

  return [bottomLeft, topLeft, topRight, bottomRight].map((point) => ({
    x: point.x + offsetX,
    y: point.y + offsetY,
  }));
}

function normalizePoints(points) {
  if (!Array.isArray(points)) {
    return [];
  }

  return points
    .map((point) => ({
      x: Number(point?.getX?.() ?? point?.x ?? 0),
      y: Number(point?.getY?.() ?? point?.y ?? 0),
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function createNativeDetector() {
  if (typeof window === 'undefined' || typeof window.BarcodeDetector !== 'function') {
    return null;
  }

  try {
    return new window.BarcodeDetector({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

function waitForVideoReady(video) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };

    const onError = (event) => {
      cleanup();
      reject(event?.error ?? new Error('Unable to start camera'));
    };

    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('error', onError);
    };

    video.addEventListener('loadedmetadata', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}
