/**
 * Import de fichiers de trace — sans serveur.
 *
 * Formats acceptés :
 * - GPX (<trkpt lat lon><time>) : Open GPX Tracker (iOS), GPS Logger (Android), export Traccar…
 * - JSON de positions Traccar (GET /api/positions) : latitude, longitude, fixTime
 * - JSON d'arrêts Traccar (GET /api/reports/stops) : startTime, endTime, latitude, longitude
 *
 * Les arrêts sont recalculés depuis les points réels (detectStopsFromTrack)
 * ou repris tels quels s'ils viennent déjà d'un rapport. Rien n'est inventé.
 *
 * parseGPX utilise DOMParser (navigateur). Côté serveur, fournir un parseur XML équivalent.
 */

import { detectStopsFromTrack } from './stop-detector.js';

export function detectFileKind(text) {
  const head = text.slice(0, 2000).trimStart();
  if (head.startsWith('<') && /<gpx[\s>]/i.test(head)) return 'gpx';
  if (head.startsWith('[') || head.startsWith('{')) {
    if (/"startTime"\s*:/.test(head) && /"endTime"\s*:/.test(head)) return 'traccar-stops';
    if (/"latitude"\s*:/.test(head) && /"(fixTime|deviceTime|serverTime)"\s*:/.test(head)) return 'traccar-positions';
    if (/"lat"\s*:/.test(head) && /"timestamp"\s*:/.test(head)) return 'positions';
  }
  return null;
}

export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('GPX illisible');
  const points = [];
  doc.querySelectorAll('trkpt, wpt').forEach(node => {
    const lat = parseFloat(node.getAttribute('lat'));
    const lon = parseFloat(node.getAttribute('lon'));
    const timeNode = node.getElementsByTagName('time')[0];
    const timestamp = timeNode ? Date.parse(timeNode.textContent.trim()) : NaN;
    if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(timestamp)) {
      points.push({ lat, lon, timestamp });
    }
  });
  return points;
}

export function parseTraccarPositions(json) {
  const arr = Array.isArray(json) ? json : [];
  return arr.map(p => ({
    lat: p.latitude,
    lon: p.longitude,
    timestamp: Date.parse(p.fixTime || p.deviceTime || p.serverTime)
  })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.timestamp));
}

export function parsePlainPositions(json) {
  const arr = Array.isArray(json) ? json : [];
  return arr.map(p => ({ lat: p.lat, lon: p.lon, timestamp: p.timestamp }))
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.timestamp));
}

function tourFromStops(rawStops, classify, meta) {
  const sorted = [...rawStops].sort((a, b) => a.arrivalTime - b.arrivalTime);
  const stops = sorted.map(s => {
    const c = classify(s.lat, s.lon);
    return {
      lat: s.lat,
      lon: s.lon,
      arrivalTime: s.arrivalTime,
      departureTime: s.departureTime,
      duration: s.duration,
      type: c.type,
      address: c.address,
      traccarAddress: s.traccarAddress || null
    };
  });

  const startTime = meta.startTime ?? (stops.length ? stops[0].arrivalTime : null);
  const endTime = meta.endTime ?? (stops.length ? stops[stops.length - 1].departureTime : null);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;

  return {
    date: new Date(startTime).toISOString(),
    startTime,
    endTime,
    totalDuration: endTime - startTime,
    stops,
    status: 'complete',
    source: 'fichier',
    fileKind: meta.kind,
    fileName: meta.fileName || null,
    pointCount: meta.pointCount || 0,
    importKey: `file_${meta.kind}_${startTime}_${endTime}_${meta.pointCount || stops.length}`
  };
}

/**
 * Convertit le contenu d'un fichier en tournée Route Tracker.
 * classify(lat, lon) → { type, address }
 * Retourne { tour, kind, pointCount } ou lève une erreur explicite.
 */
export function buildTourFromFile(text, classify, { fileName = null, stopConfig = {} } = {}) {
  const kind = detectFileKind(text);
  if (!kind) throw new Error('Format non reconnu : attendu GPX ou JSON Traccar (positions ou arrêts)');

  if (kind === 'traccar-stops') {
    const json = JSON.parse(text);
    const rawStops = (Array.isArray(json) ? json : []).map(s => {
      const arrivalTime = Date.parse(s.startTime);
      const departureTime = Date.parse(s.endTime);
      return {
        lat: s.latitude,
        lon: s.longitude,
        arrivalTime,
        departureTime,
        duration: typeof s.duration === 'number' ? s.duration : departureTime - arrivalTime,
        traccarAddress: s.address || null
      };
    }).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.arrivalTime) && Number.isFinite(s.departureTime));
    if (rawStops.length === 0) throw new Error('Aucun arrêt dans ce fichier');
    const tour = tourFromStops(rawStops, classify, { kind, fileName, pointCount: rawStops.length });
    return { tour, kind, pointCount: rawStops.length, stopCount: rawStops.length };
  }

  let positions;
  if (kind === 'gpx') positions = parseGPX(text);
  else if (kind === 'traccar-positions') positions = parseTraccarPositions(JSON.parse(text));
  else positions = parsePlainPositions(JSON.parse(text));

  if (positions.length < 3) throw new Error(`Trop peu de points horodatés (${positions.length})`);

  const rawStops = detectStopsFromTrack(positions, stopConfig);
  const sorted = [...positions].sort((a, b) => a.timestamp - b.timestamp);
  const tour = tourFromStops(rawStops, classify, {
    kind,
    fileName,
    pointCount: positions.length,
    startTime: sorted[0].timestamp,
    endTime: sorted[sorted.length - 1].timestamp
  });
  return { tour, kind, pointCount: positions.length, stopCount: rawStops.length };
}
