export function drawFrame(canvas, sourceCanvas, detections, options = {}) {
  const context = canvas.getContext('2d');
  if (!context || !sourceCanvas) {
    return;
  }

  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  canvas.width = width;
  canvas.height = height;

  context.clearRect(0, 0, width, height);
  context.drawImage(sourceCanvas, 0, 0, width, height);

  drawOverlay(context, detections, options);
}

export function renderInventoryList(container, records, options = {}) {
  const selectedId = options.selectedId ?? null;

  if (!records.length) {
    container.innerHTML = `
      <li class="empty-state">
        <strong>まだ検出がありません</strong>
        <span>カメラを起動してQRコードをフレーム内に入れてください。</span>
      </li>
    `;
    return;
  }

  container.innerHTML = records
    .map((record) => {
      const isActive = record.id === selectedId ? ' is-active' : '';
      const pointsText = record.points.length
        ? record.points.map((point) => `${round(point.x)}, ${round(point.y)}`).join(' / ')
        : '座標未取得';

      return `
        <li class="inventory-item${isActive}" data-id="${escapeHtml(record.id)}">
          <div class="inventory-item__head">
            <strong>${escapeHtml(record.id)}</strong>
            <span>${record.seenCount}回</span>
          </div>
          <div class="inventory-item__meta">
            <span>初回 ${formatTime(record.firstSeenAt)}</span>
            <span>最終 ${formatTime(record.lastSeenAt)}</span>
          </div>
          <div class="inventory-item__points">${escapeHtml(pointsText)}</div>
        </li>
      `;
    })
    .join('');
}

export function renderStatus(container, message, tone = 'neutral') {
  container.className = `status status--${tone}`;
  container.textContent = message;
}

function drawOverlay(context, detections, options) {
  if (!detections.length) {
    return;
  }

  context.save();
  context.lineWidth = Math.max(2, Math.min(context.canvas.width, context.canvas.height) * 0.004);
  context.font = `600 ${Math.max(12, Math.round(context.canvas.width * 0.018))}px ui-sans-serif, system-ui, sans-serif`;
  context.textBaseline = 'middle';

  detections.forEach((detection, index) => {
    const points = detection.points ?? [];
    if (points.length < 3) {
      return;
    }

    const hue = (index * 61 + 163) % 360;
    const stroke = `hsla(${hue}, 90%, 62%, 0.95)`;
    const fill = `hsla(${hue}, 90%, 62%, 0.18)`;
    const label = options.labelFormatter
      ? options.labelFormatter(detection, index)
      : detection.id;

    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      context.lineTo(points[i].x, points[i].y);
    }
    context.closePath();
    context.fillStyle = fill;
    context.strokeStyle = stroke;
    context.fill();
    context.stroke();

    const anchor = points[0];
    const labelWidth = Math.max(80, context.measureText(label).width + 20);
    const labelHeight = 26;
    const boxX = clamp(anchor.x, 8, context.canvas.width - labelWidth - 8);
    const boxY = clamp(anchor.y - labelHeight - 10, 8, context.canvas.height - labelHeight - 8);

    context.fillStyle = 'rgba(3, 7, 18, 0.82)';
    context.strokeStyle = stroke;
    roundRect(context, boxX, boxY, labelWidth, labelHeight, 10);
    context.fill();
    context.stroke();

    context.fillStyle = '#f8fafc';
    context.fillText(label, boxX + 10, boxY + labelHeight / 2);
  });

  context.restore();
}

function roundRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round(value) {
  return Math.round(value);
}

function formatTime(epochMs) {
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(epochMs));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
