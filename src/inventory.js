export class InventoryStore {
  constructor() {
    this.records = new Map();
  }

  addDetection(detection) {
    const id = normalizeId(detection?.id);
    if (!id) {
      return null;
    }

    const timestamp = detection.timestamp ?? Date.now();
    const nextRecord = {
      id,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      seenCount: 1,
      points: Array.isArray(detection.points) ? detection.points.map(clonePoint) : [],
      frameWidth: detection.frameWidth ?? null,
      frameHeight: detection.frameHeight ?? null,
    };

    const current = this.records.get(id);
    if (current) {
      nextRecord.firstSeenAt = current.firstSeenAt;
      nextRecord.seenCount = current.seenCount + 1;
      nextRecord.points = nextRecord.points.length ? nextRecord.points : current.points;
      nextRecord.frameWidth = nextRecord.frameWidth ?? current.frameWidth;
      nextRecord.frameHeight = nextRecord.frameHeight ?? current.frameHeight;
    }

    this.records.set(id, nextRecord);
    return nextRecord;
  }

  addDetections(detections) {
    const added = [];
    for (const detection of detections) {
      const record = this.addDetection(detection);
      if (record) {
        added.push(record);
      }
    }
    return added;
  }

  getCount() {
    return this.records.size;
  }

  has(id) {
    return this.records.has(normalizeId(id));
  }

  getIdList() {
    return this.getRecords().map((record) => record.id);
  }

  getRecords() {
    return Array.from(this.records.values()).sort((a, b) => {
      return a.firstSeenAt - b.firstSeenAt || a.id.localeCompare(b.id);
    });
  }

  clear() {
    this.records.clear();
  }

  toJSON() {
    return {
      generatedAt: new Date().toISOString(),
      total: this.getCount(),
      ids: this.getRecords().map((record) => ({
        id: record.id,
        firstSeenAt: new Date(record.firstSeenAt).toISOString(),
        lastSeenAt: new Date(record.lastSeenAt).toISOString(),
        seenCount: record.seenCount,
        points: record.points,
        frameWidth: record.frameWidth,
        frameHeight: record.frameHeight,
      })),
    };
  }

  exportJSON(space = 2) {
    return JSON.stringify(this.toJSON(), null, space);
  }
}

function normalizeId(value) {
  return String(value ?? '').trim();
}

function clonePoint(point) {
  return {
    x: Number(point?.x ?? 0),
    y: Number(point?.y ?? 0),
  };
}
