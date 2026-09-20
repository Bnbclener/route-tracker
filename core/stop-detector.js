/**
 * Détection d'arrêts à partir d'un flux de positions GPS.
 * Indépendant du framework — réutilisable dans BnB Cleaner.
 *
 * Principe : si toutes les positions des N dernières secondes
 * restent dans un rayon donné, c'est un arrêt.
 */

import { haversine, centroid } from './geo.js';

const DEFAULTS = {
  stopRadiusM: 50,
  stopDurationMs: 3 * 60 * 1000,
  departureRadiusM: 60,
  bufferMaxSize: 60
};

export class StopDetector {
  constructor(config = {}) {
    this.config = { ...DEFAULTS, ...config };
    this.buffer = [];
    this.currentStop = null;
    this.onStopStart = null;
    this.onStopEnd = null;
  }

  reset() {
    this.buffer = [];
    this.currentStop = null;
  }

  feed(position) {
    const { lat, lon, timestamp } = position;

    if (this.currentStop) {
      const dist = haversine(lat, lon, this.currentStop.lat, this.currentStop.lon);
      if (dist > this.config.departureRadiusM) {
        const stop = this.finalize(timestamp);
        if (this.onStopEnd) this.onStopEnd(stop);
        return { event: 'departure', stop };
      }
      return { event: 'still_stopped', stop: this.currentStop };
    }

    this.buffer.push({ lat, lon, timestamp });
    if (this.buffer.length > this.config.bufferMaxSize) {
      this.buffer.shift();
    }

    return this.evaluate();
  }

  evaluate() {
    if (this.buffer.length < 3) return { event: 'moving' };

    const recent = this.buffer.slice(-(this.config.bufferMaxSize / 2));
    if (recent.length < 3) return { event: 'moving' };

    const first = recent[0];
    const last = recent[recent.length - 1];
    const elapsed = last.timestamp - first.timestamp;

    if (elapsed < this.config.stopDurationMs) return { event: 'moving' };

    const center = centroid(recent);
    const allNear = recent.every(
      p => haversine(p.lat, p.lon, center.lat, center.lon) < this.config.stopRadiusM
    );

    if (!allNear) return { event: 'moving' };

    this.currentStop = {
      lat: center.lat,
      lon: center.lon,
      arrivalTime: first.timestamp
    };
    this.buffer = [];

    if (this.onStopStart) this.onStopStart(this.currentStop);
    return { event: 'stop_detected', stop: this.currentStop };
  }

  finalize(atTimestamp = Date.now()) {
    if (!this.currentStop) return null;
    const stop = {
      ...this.currentStop,
      departureTime: atTimestamp,
      duration: atTimestamp - this.currentStop.arrivalTime
    };
    this.currentStop = null;
    this.buffer = [];
    return stop;
  }

  getState() {
    return {
      isInStop: !!this.currentStop,
      currentStop: this.currentStop,
      bufferSize: this.buffer.length
    };
  }
}

/**
 * Détection d'arrêts sur une trace complète (GPX, export de positions).
 * positions : [{ lat, lon, timestamp }] — triées ou non.
 * Un arrêt = suite de points restant dans stopRadiusM pendant ≥ stopDurationMs.
 * Retourne [{ lat, lon, arrivalTime, departureTime, duration, pointCount }].
 */
export function detectStopsFromTrack(positions, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const pts = positions
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  const stops = [];
  let i = 0;

  while (i < pts.length) {
    let j = i;
    let sumLat = pts[i].lat;
    let sumLon = pts[i].lon;
    let count = 1;
    let cLat = pts[i].lat;
    let cLon = pts[i].lon;

    while (j + 1 < pts.length) {
      const next = pts[j + 1];
      if (haversine(next.lat, next.lon, cLat, cLon) > cfg.stopRadiusM) break;
      j++;
      sumLat += next.lat;
      sumLon += next.lon;
      count++;
      cLat = sumLat / count;
      cLon = sumLon / count;
    }

    const span = pts[j].timestamp - pts[i].timestamp;
    if (span >= cfg.stopDurationMs) {
      const departureTime = j + 1 < pts.length ? pts[j + 1].timestamp : pts[j].timestamp;
      stops.push({
        lat: cLat,
        lon: cLon,
        arrivalTime: pts[i].timestamp,
        departureTime,
        duration: departureTime - pts[i].timestamp,
        pointCount: count
      });
      i = j + 1;
    } else {
      i++;
    }
  }

  return stops;
}
