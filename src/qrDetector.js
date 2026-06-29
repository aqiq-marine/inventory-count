import * as ort from 'onnxruntime-web/webgpu';
import { BrowserQRCodeReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

const ZXING_HINTS = new Map([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]],
  [DecodeHintType.TRY_HARDER, true],
]);

const MODEL_URL = new URL('../model/best.onnx', import.meta.url).href;
const MODEL_INPUT_SIZE = 640;
const MODEL_CONFIDENCE_THRESHOLD = 0.2;
const MODEL_NMS_THRESHOLD = 0.45;
const MAX_MODEL_CANDIDATES = 8;
const DEFAULT_PADDING = 20;

if (ort.env?.wasm) {
  ort.env.wasm.numThreads = Math.max(1, Math.min(2, navigator.hardwareConcurrency || 1));
  ort.env.wasm.simd = true;
}

export class QrDetector {
  constructor(options = {}) {
    this.videoElement = options.videoElement;
    this.reader = new BrowserQRCodeReader(ZXING_HINTS);
    this.modelSessionPromise = null;
    this.frameCanvas = document.createElement('canvas');
    this.frameContext = this.frameCanvas.getContext('2d', { willReadFrequently: true });
    this.cropCanvas = document.createElement('canvas');
    this.cropContext = this.cropCanvas.getContext('2d', { willReadFrequently: true });
    this.modelCanvas = document.createElement('canvas');
    this.modelCanvas.width = MODEL_INPUT_SIZE;
    this.modelCanvas.height = MODEL_INPUT_SIZE;
    this.modelContext = this.modelCanvas.getContext('2d', { willReadFrequently: true });
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

  async scanCurrentFrame(options = {}) {
    if (!this.videoElement || this.videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return null;
    }

    const totalStart = performance.now();
    const width = this.videoElement.videoWidth;
    const height = this.videoElement.videoHeight;
    if (!width || !height) {
      return null;
    }

    const frameCopyStart = performance.now();
    this.frameCanvas.width = width;
    this.frameCanvas.height = height;
    this.frameContext.drawImage(this.videoElement, 0, 0, width, height);
    const frameCopyMs = performance.now() - frameCopyStart;

    const candidateStart = performance.now();
    const candidateResult = await this.collectCandidates(this.frameCanvas, options);
    const candidateMs = performance.now() - candidateStart;

    const decodeStart = performance.now();
    const detections = await decodeCandidates({
      frameCanvas: this.frameCanvas,
      candidates: candidateResult.candidates,
      reader: this.reader,
      cropCanvas: this.cropCanvas,
      cropContext: this.cropContext,
    });
    const decodeMs = performance.now() - decodeStart;
    const totalMs = performance.now() - totalStart;

    return {
      frameCanvas: this.frameCanvas,
      width,
      height,
      detections,
      timings: {
        totalMs,
        frameCopyMs,
        candidateMs,
        decodeMs,
        modelMs: candidateResult.timings.modelMs,
        modelPreprocessMs: candidateResult.timings.modelPreprocessMs,
        modelInferenceMs: candidateResult.timings.modelInferenceMs,
        modelParseMs: candidateResult.timings.modelParseMs,
        nativeMs: candidateResult.timings.nativeMs,
        fallbackMs: candidateResult.timings.fallbackMs,
      },
    };
  }

  async scanCanvas(canvas, options = {}) {
    const width = canvas.width;
    const height = canvas.height;
    if (!width || !height) {
      return [];
    }

    const candidateResult = await this.collectCandidates(canvas, options);
    return decodeCandidates({
      frameCanvas: canvas,
      candidates: candidateResult.candidates,
      reader: this.reader,
      cropCanvas: this.cropCanvas,
      cropContext: this.cropContext,
    });
  }

  async collectCandidates(canvas, options = {}) {
    const useModel = Boolean(options.useModel);
    const timings = {
      modelMs: 0,
      modelPreprocessMs: 0,
      modelInferenceMs: 0,
      modelParseMs: 0,
      nativeMs: 0,
      fallbackMs: 0,
    };

    if (useModel) {
      const modelStart = performance.now();
      const modelResult = await detectModelCandidates(this, canvas);
      timings.modelMs = performance.now() - modelStart;
      timings.modelPreprocessMs = modelResult.timings.preprocessMs;
      timings.modelInferenceMs = modelResult.timings.inferenceMs;
      timings.modelParseMs = modelResult.timings.parseMs;

      const modelCandidates = modelResult.candidates;
      if (modelCandidates.length) {
        return { candidates: modelCandidates, timings };
      }
    }

    const fallbackStart = performance.now();
    const fallbackCandidates = buildGridCandidates(canvas.width, canvas.height);
    timings.fallbackMs = performance.now() - fallbackStart;
    return { candidates: fallbackCandidates, timings };
  }

  async ensureModelSession() {
    if (!this.modelSessionPromise) {
      this.modelSessionPromise = this.createModelSession();
    }

    return this.modelSessionPromise;
  }

  async createModelSession() {
    const sessionOptions = {
      graphOptimizationLevel: 'all',
    };

    try {
      const providerOptions = typeof navigator !== 'undefined' && navigator.gpu
        ? ['webgpu', 'wasm']
        : ['wasm'];
      return await ort.InferenceSession.create(MODEL_URL, {
        ...sessionOptions,
        executionProviders: providerOptions,
      });
    } catch (error) {
      if (typeof navigator !== 'undefined' && navigator.gpu) {
        return ort.InferenceSession.create(MODEL_URL, {
          ...sessionOptions,
          executionProviders: ['wasm'],
        });
      }

      this.modelSessionPromise = null;
      throw error;
    }
  }
}

async function detectModelCandidates(detector, canvas) {
  if (!detector) {
    return { candidates: [], timings: { preprocessMs: 0, inferenceMs: 0, parseMs: 0 } };
  }

  try {
    const session = await detector.ensureModelSession();
    const inputName = session.inputNames[0];
    const preprocessStart = performance.now();
    const { tensor: inputTensor, letterbox } = createModelInputTensor(
      canvas,
      detector.modelCanvas,
      detector.modelContext,
    );
    const preprocessMs = performance.now() - preprocessStart;
    const inferenceStart = performance.now();
    const outputs = await session.run({ [inputName]: inputTensor });
    const inferenceMs = performance.now() - inferenceStart;
    const output = outputs[session.outputNames[0]] ?? outputs[Object.keys(outputs)[0]];
    if (!output) {
      return { candidates: [], timings: { preprocessMs, inferenceMs, parseMs: 0 } };
    }

    const parseStart = performance.now();
    const candidates = parseModelOutput(output, canvas.width, canvas.height, letterbox);
    const parseMs = performance.now() - parseStart;
    return {
      candidates,
      timings: {
        preprocessMs,
        inferenceMs,
        parseMs,
      },
    };
  } catch {
    return { candidates: [], timings: { preprocessMs: 0, inferenceMs: 0, parseMs: 0 } };
  }
}

function createModelInputTensor(sourceCanvas, targetCanvas, targetContext) {
  const sourceWidth = sourceCanvas.width;
  const sourceHeight = sourceCanvas.height;
  const targetWidth = targetCanvas.width;
  const targetHeight = targetCanvas.height;
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const resizedWidth = Math.max(1, Math.round(sourceWidth * scale));
  const resizedHeight = Math.max(1, Math.round(sourceHeight * scale));
  const padX = Math.floor((targetWidth - resizedWidth) / 2);
  const padY = Math.floor((targetHeight - resizedHeight) / 2);

  targetContext.save();
  targetContext.fillStyle = 'rgb(114, 114, 114)';
  targetContext.fillRect(0, 0, targetWidth, targetHeight);
  targetContext.imageSmoothingEnabled = true;
  targetContext.drawImage(sourceCanvas, 0, 0, sourceWidth, sourceHeight, padX, padY, resizedWidth, resizedHeight);
  targetContext.restore();

  const imageData = targetContext.getImageData(0, 0, targetWidth, targetHeight).data;
  const data = new Float32Array(3 * targetWidth * targetHeight);
  const area = targetWidth * targetHeight;

  for (let pixel = 0; pixel < area; pixel += 1) {
    const index = pixel * 4;
    data[pixel] = imageData[index] / 255;
    data[area + pixel] = imageData[index + 1] / 255;
    data[area * 2 + pixel] = imageData[index + 2] / 255;
  }

  const tensor = new ort.Tensor('float32', data, [1, 3, targetHeight, targetWidth]);
  const letterbox = {
    scale,
    padX,
    padY,
    inputWidth: targetWidth,
    inputHeight: targetHeight,
  };

  return { tensor, letterbox };
}

function parseModelOutput(output, sourceWidth, sourceHeight, letterbox) {
  const { rows, cols, rowMajor } = normalizePredictionShape(output.dims, output.data.length);
  if (!rows || !cols || cols < 5) {
    return [];
  }

  const tensorData = output.data;
  const candidates = [];
  const maxColumns = cols;
  const classCount = 1;

  for (let row = 0; row < rows; row += 1) {
    const offset = rowMajor ? row * cols : row;
    const readValue = (column) => (rowMajor ? tensorData[offset + column] : tensorData[offset + column * rows]);
    const cx = readValue(0);
    const cy = readValue(1);
    const width = readValue(2);
    const height = readValue(3);

    if (![cx, cy, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
      continue;
    }

    let score = 0;
    if (cols === 5) {
      score = readValue(4);
    } else if (cols === 6 && classCount === 1) {
      score = readValue(4) * readValue(5);
    } else if (cols > 5) {
      score = readMaxClassScore(readValue, 4, maxColumns);
    }

    if (!Number.isFinite(score) || score < MODEL_CONFIDENCE_THRESHOLD) {
      continue;
    }

    const bounds = convertModelBoxToBounds(
      { cx, cy, width, height },
      sourceWidth,
      sourceHeight,
      letterbox,
    );

    if (!bounds || bounds.width < 12 || bounds.height < 12) {
      continue;
    }

    candidates.push({
      points: boundsToQuad(bounds),
      bounds: inflateBounds(bounds, DEFAULT_PADDING, sourceWidth, sourceHeight),
      score,
      source: 'model',
    });
  }

  return nonMaxSuppress(candidates, MODEL_NMS_THRESHOLD)
    .slice(0, MAX_MODEL_CANDIDATES)
    .map((candidate) => ({
      points: candidate.points,
      bounds: candidate.bounds,
      source: candidate.source,
    }));
}

function normalizePredictionShape(dims, dataLength) {
  if (!Array.isArray(dims) || !dims.length) {
    return { rows: 0, cols: 0, rowMajor: true };
  }

  if (dims.length === 2) {
    return { rows: dims[0], cols: dims[1], rowMajor: true };
  }

  if (dims.length === 3 && dims[0] === 1) {
    if (dims[1] < dims[2]) {
      return { rows: dims[2], cols: dims[1], rowMajor: false };
    }

    return { rows: dims[1], cols: dims[2], rowMajor: true };
  }

  if (dims.length === 1) {
    const cols = 5;
    return { rows: Math.floor(dataLength / cols), cols, rowMajor: true };
  }

  return { rows: 0, cols: 0, rowMajor: true };
}

function readMaxClassScore(readValue, startColumn, endColumn) {
  let maxScore = 0;
  for (let column = startColumn; column < endColumn; column += 1) {
    const value = readValue(column);
    if (Number.isFinite(value) && value > maxScore) {
      maxScore = value;
    }
  }

  return maxScore;
}

function convertModelBoxToBounds(box, sourceWidth, sourceHeight, letterbox) {
  const inputWidth = letterbox?.inputWidth ?? MODEL_INPUT_SIZE;
  const inputHeight = letterbox?.inputHeight ?? MODEL_INPUT_SIZE;
  const scale = letterbox?.scale ?? Math.min(inputWidth / sourceWidth, inputHeight / sourceHeight);
  const padX = letterbox?.padX ?? (inputWidth - sourceWidth * scale) / 2;
  const padY = letterbox?.padY ?? (inputHeight - sourceHeight * scale) / 2;
  const normalized = Math.max(box.cx, box.cy, box.width, box.height) <= 2;
  const multiplierX = normalized ? inputWidth : 1;
  const multiplierY = normalized ? inputHeight : 1;
  const centerX = box.cx * multiplierX;
  const centerY = box.cy * multiplierY;
  const boxWidth = box.width * multiplierX;
  const boxHeight = box.height * multiplierY;

  const x = (centerX - boxWidth / 2 - padX) / scale;
  const y = (centerY - boxHeight / 2 - padY) / scale;
  const width = boxWidth / scale;
  const height = boxHeight / scale;

  return clampBounds(
    {
      x,
      y,
      width,
      height,
    },
    sourceWidth,
    sourceHeight,
  );
}

function clampBounds(bounds, maxWidth, maxHeight) {
  const x = Math.max(0, Math.min(maxWidth - 1, bounds.x));
  const y = Math.max(0, Math.min(maxHeight - 1, bounds.y));
  const width = Math.max(1, Math.min(maxWidth - x, bounds.width));
  const height = Math.max(1, Math.min(maxHeight - y, bounds.height));
  return { x, y, width, height };
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
          bounds: inflateBounds(pointsToBounds(points), DEFAULT_PADDING, canvas.width, canvas.height),
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

    const decodeStart = performance.now();
    let result = null;
    try {
      result = reader.decodeFromCanvas(crop.canvas);
    } catch {
      continue;
    }
    const decodeMs = performance.now() - decodeStart;

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
      decodeMs,
      source: candidate.source,
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

function nonMaxSuppress(candidates, iouThreshold) {
  const remaining = [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const selected = [];

  while (remaining.length) {
    const current = remaining.shift();
    selected.push(current);
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (intersectionOverUnion(current.bounds, remaining[index].bounds) >= iouThreshold) {
        remaining.splice(index, 1);
      }
    }
  }

  return selected;
}

function intersectionOverUnion(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersectionWidth = Math.max(0, right - left);
  const intersectionHeight = Math.max(0, bottom - top);
  const intersectionArea = intersectionWidth * intersectionHeight;
  const unionArea = a.width * a.height + b.width * b.height - intersectionArea;

  if (unionArea <= 0) {
    return 0;
  }

  return intersectionArea / unionArea;
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
