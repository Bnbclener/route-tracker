/**
 * Adaptateur Traccar.
 *
 * Traccar = tuyau GPS uniquement. L'appli Traccar Client (iPhone/Android)
 * envoie les positions au serveur ; ici on lit les rapports « stops » et
 * « trips » déjà calculés côté serveur, puis on les convertit en tournée
 * au format Route Tracker. Aucune donnée n'est inventée : chaque arrêt
 * vient d'un rapport Traccar horodaté.
 *
 * Authentification : token API (recommandé, à générer dans Traccar →
 * Compte → Token) ou identifiants en Basic Auth.
 *
 * Réutilisable dans BnB Cleaner (fetch standard, zéro dépendance).
 */

export const DEFAULT_TRACCAR_SERVER = 'https://demo.traccar.org';

export class TraccarClient {
  constructor({ serverUrl = DEFAULT_TRACCAR_SERVER, token = null, email = null, password = null } = {}) {
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.token = token || null;
    this.email = email || null;
    this.password = password || null;
  }

  hasCredentials() {
    return Boolean(this.token || (this.email && this.password));
  }

  _headers() {
    const headers = { Accept: 'application/json' };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    } else if (this.email && this.password) {
      headers.Authorization = 'Basic ' + btoa(unescape(encodeURIComponent(`${this.email}:${this.password}`)));
    }
    return headers;
  }

  async _get(path, params = {}) {
    const url = new URL(`${this.serverUrl}/api${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value == null) continue;
      if (Array.isArray(value)) value.forEach(v => url.searchParams.append(key, v));
      else url.searchParams.set(key, value);
    }

    let res;
    try {
      res = await fetch(url.toString(), { headers: this._headers() });
    } catch (e) {
      throw new Error(`Connexion impossible à ${this.serverUrl} (réseau ou CORS bloqué par le serveur)`);
    }

    if (res.status === 401) throw new Error('Traccar : identifiants ou token refusés (401)');
    if (res.status === 403) throw new Error('Traccar : accès interdit (403)');
    if (!res.ok) throw new Error(`Traccar : erreur ${res.status}`);
    return res.json();
  }

  getDevices() {
    return this._get('/devices');
  }

  getTrips(deviceId, fromIso, toIso) {
    return this._get('/reports/trips', { deviceId, from: fromIso, to: toIso });
  }

  getStops(deviceId, fromIso, toIso) {
    return this._get('/reports/stops', { deviceId, from: fromIso, to: toIso });
  }

  getPositions(deviceId, fromIso, toIso) {
    return this._get('/positions', { deviceId, from: fromIso, to: toIso });
  }
}

/** Bornes ISO (UTC) d'une journée locale 'YYYY-MM-DD'. */
export function dayRange(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d, 23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function importKey(deviceId, dateStr) {
  return `traccar_${deviceId}_${dateStr}`;
}

/**
 * Convertit les rapports Traccar d'une journée en tournée Route Tracker.
 * classify(lat, lon) → { type: 'client'|'home'|'personal', address }
 */
export function buildTourFromTraccar({ dateStr, deviceId, deviceName, stops, trips }, classify) {
  const sortedStops = [...stops].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));

  const tourStops = sortedStops.map(s => {
    const arrivalTime = Date.parse(s.startTime);
    const departureTime = Date.parse(s.endTime);
    const lat = s.latitude;
    const lon = s.longitude;
    const classified = classify(lat, lon);
    return {
      lat,
      lon,
      arrivalTime,
      departureTime,
      duration: typeof s.duration === 'number' ? s.duration : departureTime - arrivalTime,
      type: classified.type,
      address: classified.address,
      traccarAddress: s.address || null,
      traccarKey: `${s.deviceId}_${s.startTime}`
    };
  });

  const tripStarts = trips.map(t => Date.parse(t.startTime)).filter(Number.isFinite);
  const tripEnds = trips.map(t => Date.parse(t.endTime)).filter(Number.isFinite);
  const stopStarts = tourStops.map(s => s.arrivalTime);
  const stopEnds = tourStops.map(s => s.departureTime);

  const allStarts = [...tripStarts, ...stopStarts];
  const allEnds = [...tripEnds, ...stopEnds];
  if (allStarts.length === 0) return null;

  const startTime = Math.min(...allStarts);
  const endTime = Math.max(...allEnds);
  const distanceM = trips.reduce((sum, t) => sum + (t.distance || 0), 0);

  return {
    date: new Date(startTime).toISOString(),
    startTime,
    endTime,
    totalDuration: endTime - startTime,
    stops: tourStops,
    status: 'complete',
    source: 'traccar',
    importKey: importKey(deviceId, dateStr),
    deviceId,
    deviceName: deviceName || null,
    distanceM,
    tripCount: trips.length
  };
}
