/**
 * Moteur d'apprentissage des tournées.
 *
 * Apprend :
 * - Durées de trajet entre paires d'adresses (DIRECTIONNEL : A->B ≠ B->A)
 * - Temps sur site par logement (taille, zone, prestataire)
 * - Pénalités de route (commentaires : "Marx Dormoy bouchée")
 * - Corrections manuelles (pèsent plus lourd que les données GPS)
 * - Parcours fréquents
 *
 * Réutilisable dans BnB Cleaner.
 */

const TIME_SLOTS = ['morning', 'midday', 'afternoon', 'evening'];
const ALPHA = 0.3;
const MANUAL_ALPHA = 0.6;

function getTimeSlot(timestamp) {
  const h = new Date(timestamp).getHours();
  if (h < 10) return 'morning';
  if (h < 13) return 'midday';
  if (h < 17) return 'afternoon';
  return 'evening';
}

function getDayGroup(timestamp) {
  const day = new Date(timestamp).getDay();
  if (day === 0 || day === 6) return 'weekend';
  if (day === 1) return 'monday';
  if (day === 5) return 'friday';
  return 'midweek';
}

function makeKey(fromId, toId) {
  return `${fromId}__${toId}`;
}

function stopId(stop) {
  if (stop.type === 'home') return 'home';
  if (stop.address) return stop.address.id || stop.address.name;
  return null;
}

function summarize(entries) {
  const count = entries.reduce((sum, e) => sum + (e.count || 0), 0);
  const avg = entries.reduce((sum, e) => sum + e.avg, 0) / entries.length;
  const source = entries.some(e => e.manual) ? 'manual' : 'measured';
  return { avg, count, source };
}

export class RouteLearner {
  constructor() {
    this.travelTimes = {};
    this.siteTimes = {};
    this.routeFrequency = {};
    this.routeNotes = {};
    this.addressMeta = {};
  }

  exportModel() {
    return {
      travelTimes: this.travelTimes,
      siteTimes: this.siteTimes,
      routeFrequency: this.routeFrequency,
      routeNotes: this.routeNotes,
      addressMeta: this.addressMeta
    };
  }

  importModel(data) {
    if (data.travelTimes) this.travelTimes = data.travelTimes;
    if (data.siteTimes) this.siteTimes = data.siteTimes;
    if (data.routeFrequency) this.routeFrequency = data.routeFrequency;
    if (data.routeNotes) this.routeNotes = data.routeNotes;
    if (data.addressMeta) this.addressMeta = data.addressMeta;
  }

  // ---- MÉTADONNÉES LOGEMENT ----

  setAddressMeta(addressId, meta) {
    if (!this.addressMeta[addressId]) {
      this.addressMeta[addressId] = {};
    }
    Object.assign(this.addressMeta[addressId], meta);
  }

  getAddressMeta(addressId) {
    return this.addressMeta[addressId] || null;
  }

  // ---- COMMENTAIRES / NOTES SUR LES TRAJETS ----

  addRouteNote(fromId, toId, note) {
    const key = makeKey(fromId, toId);
    if (!this.routeNotes[key]) {
      this.routeNotes[key] = [];
    }
    this.routeNotes[key].push({
      text: note,
      date: Date.now(),
      penalty: this.detectPenalty(note)
    });
  }

  getRouteNotes(fromId, toId) {
    return this.routeNotes[makeKey(fromId, toId)] || [];
  }

  detectPenalty(note) {
    const lower = note.toLowerCase();
    const heavyWords = ['bouchée', 'bouchee', 'embouteillage', 'embouteillée', 'bloquée',
      'bloquee', 'toujours', 'galère', 'galere', 'éviter', 'eviter', 'horrible',
      'impraticable', 'travaux', 'fermée', 'fermee', 'dangereux', 'lent', 'très long',
      'tres long', 'interminable', 'pénible', 'penible'];
    const mediumWords = ['long', 'chargée', 'chargee', 'dense', 'ralenti', 'ralentissement',
      'attention', 'détour', 'detour'];
    const lightWords = ['ok', 'bien', 'fluide', 'rapide', 'facile', 'parfait', 'nickel', 'ras'];

    for (const w of lightWords) {
      if (lower.includes(w)) return -0.1;
    }
    for (const w of heavyWords) {
      if (lower.includes(w)) return 0.5;
    }
    for (const w of mediumWords) {
      if (lower.includes(w)) return 0.25;
    }
    return 0;
  }

  getRoutePenalty(fromId, toId) {
    const notes = this.routeNotes[makeKey(fromId, toId)];
    if (!notes || notes.length === 0) return 0;
    const recent = notes.slice(-5);
    const avgPenalty = recent.reduce((sum, n) => sum + n.penalty, 0) / recent.length;
    return avgPenalty;
  }

  deleteRouteNote(fromId, toId, index) {
    const key = makeKey(fromId, toId);
    if (this.routeNotes[key] && this.routeNotes[key][index] !== undefined) {
      this.routeNotes[key].splice(index, 1);
      if (this.routeNotes[key].length === 0) delete this.routeNotes[key];
    }
  }

  // ---- CORRECTIONS MANUELLES ----

  manualCorrectTravel(fromId, toId, durationMs, timestamp = Date.now()) {
    const slot = getTimeSlot(timestamp);
    const day = getDayGroup(timestamp);
    const key = `${makeKey(fromId, toId)}__${day}__${slot}`;

    if (!this.travelTimes[key]) {
      this.travelTimes[key] = { avg: durationMs, count: 1, min: durationMs, max: durationMs, manual: true };
    } else {
      const entry = this.travelTimes[key];
      entry.avg = MANUAL_ALPHA * durationMs + (1 - MANUAL_ALPHA) * entry.avg;
      entry.count++;
      entry.min = Math.min(entry.min, durationMs);
      entry.max = Math.max(entry.max, durationMs);
      entry.manual = true;
    }
  }

  manualCorrectSiteTime(addressId, durationMs, timestamp = Date.now()) {
    const slot = getTimeSlot(timestamp);
    const day = getDayGroup(timestamp);
    const key = `${addressId}__${day}__${slot}`;

    if (!this.siteTimes[key]) {
      this.siteTimes[key] = { avg: durationMs, count: 1, lastUpdate: Date.now(), manual: true };
    } else {
      const entry = this.siteTimes[key];
      entry.avg = MANUAL_ALPHA * durationMs + (1 - MANUAL_ALPHA) * entry.avg;
      entry.count++;
      entry.lastUpdate = Date.now();
      entry.manual = true;
    }
  }

  // ---- APPRENTISSAGE AUTOMATIQUE ----

  learnFromTour(tour) {
    if (!tour.stops || tour.stops.length < 1) return;

    const manual = tour.source === 'manuel';
    const sequence = tour.stops.filter(s => (s.type === 'client' && s.address) || s.type === 'home');
    const clientStops = sequence.filter(s => s.type === 'client');

    for (const stop of clientStops) {
      if (manual) {
        if (stop.duration > 0) {
          this.manualCorrectSiteTime(stopId(stop), stop.duration, stop.arrivalTime);
        }
      } else if (!stop.ambiguousWith) {
        // Plusieurs logements dans le même immeuble : le GPS ne dit pas lequel, durée non apprise.
        this.learnSiteTime(stop);
      }
    }

    for (let i = 0; i < sequence.length - 1; i++) {
      const from = sequence[i];
      const to = sequence[i + 1];
      if (from.type === 'home' && to.type === 'home') continue;
      if (manual) {
        const travelMs = to.arrivalTime - from.departureTime;
        if (travelMs > 0) {
          this.manualCorrectTravel(stopId(from), stopId(to), travelMs, from.departureTime);
        }
      } else {
        this.learnTravelTime(from, to);
      }
    }

    this.learnRouteOrder(clientStops);
  }

  learnSiteTime(stop) {
    if (!stop.address || !stop.duration) return;
    const id = stop.address.id || stop.address.name;
    const slot = getTimeSlot(stop.arrivalTime);
    const day = getDayGroup(stop.arrivalTime);
    const key = `${id}__${day}__${slot}`;

    if (!this.siteTimes[key]) {
      this.siteTimes[key] = { avg: stop.duration, count: 1, lastUpdate: Date.now() };
    } else {
      const entry = this.siteTimes[key];
      const alpha = entry.manual ? ALPHA * 0.5 : ALPHA;
      entry.avg = alpha * stop.duration + (1 - alpha) * entry.avg;
      entry.count++;
      entry.lastUpdate = Date.now();
    }
  }

  learnTravelTime(fromStop, toStop) {
    if (!fromStop.departureTime || !toStop.arrivalTime) return;

    const fromId = stopId(fromStop);
    const toId = stopId(toStop);
    if (!fromId || !toId) return;
    const travelMs = toStop.arrivalTime - fromStop.departureTime;

    if (travelMs <= 0 || travelMs > 3 * 3600000) return;

    const slot = getTimeSlot(fromStop.departureTime);
    const day = getDayGroup(fromStop.departureTime);
    const key = `${makeKey(fromId, toId)}__${day}__${slot}`;

    if (!this.travelTimes[key]) {
      this.travelTimes[key] = { avg: travelMs, count: 1, min: travelMs, max: travelMs };
    } else {
      const entry = this.travelTimes[key];
      const alpha = entry.manual ? ALPHA * 0.5 : ALPHA;
      entry.avg = alpha * travelMs + (1 - alpha) * entry.avg;
      entry.count++;
      entry.min = Math.min(entry.min, travelMs);
      entry.max = Math.max(entry.max, travelMs);
    }
  }

  learnRouteOrder(clientStops) {
    if (clientStops.length < 2) return;
    const ids = clientStops.map(s => s.address.id || s.address.name);
    const key = ids.join(',');

    if (!this.routeFrequency[key]) {
      this.routeFrequency[key] = { count: 1, lastUsed: Date.now() };
    } else {
      this.routeFrequency[key].count++;
      this.routeFrequency[key].lastUsed = Date.now();
    }
  }

  // ---- PRÉDICTIONS ----

  /**
   * Retourne { ms, source: 'measured'|'manual', count, precision: 'exact'|'day'|'any', penalty }
   * ou null si aucune donnée réelle n'existe pour ce trajet.
   */
  getTravelInfo(fromId, toId, timestamp = Date.now()) {
    if (fromId == null || toId == null) return null;
    const slot = getTimeSlot(timestamp);
    const day = getDayGroup(timestamp);
    const base = makeKey(fromId, toId);
    let entries = null;
    let precision = null;

    const exact = this.travelTimes[`${base}__${day}__${slot}`];
    if (exact) {
      entries = [exact];
      precision = 'exact';
    } else {
      const sameDay = TIME_SLOTS.map(s => this.travelTimes[`${base}__${day}__${s}`]).filter(Boolean);
      if (sameDay.length) {
        entries = sameDay;
        precision = 'day';
      } else {
        const any = Object.keys(this.travelTimes)
          .filter(k => k.startsWith(`${base}__`))
          .map(k => this.travelTimes[k]);
        if (any.length) {
          entries = any;
          precision = 'any';
        }
      }
    }

    if (!entries) return null;

    const { avg, count, source } = summarize(entries);
    const penalty = this.getRoutePenalty(fromId, toId);
    return { ms: avg * (1 + penalty), source, count, precision, penalty };
  }

  getExpectedTravelTime(fromId, toId, timestamp = Date.now()) {
    const info = this.getTravelInfo(fromId, toId, timestamp);
    return info ? info.ms : null;
  }

  /**
   * Retourne { ms, source: 'measured'|'manual'|'surface', count } ou null.
   * 'surface' = dérivé de la surface saisie par l'utilisateur (1,2 min/m², min 30 min).
   */
  getSiteInfo(addressId, timestamp = Date.now()) {
    if (addressId == null) return null;
    const slot = getTimeSlot(timestamp);
    const day = getDayGroup(timestamp);

    const exact = this.siteTimes[`${addressId}__${day}__${slot}`];
    if (exact) {
      const { avg, count, source } = summarize([exact]);
      return { ms: avg, source, count, precision: 'exact' };
    }

    const any = Object.keys(this.siteTimes)
      .filter(k => k.startsWith(`${addressId}__`))
      .map(k => this.siteTimes[k]);
    if (any.length) {
      const { avg, count, source } = summarize(any);
      return { ms: avg, source, count, precision: 'any' };
    }

    const meta = this.addressMeta[addressId];
    if (meta && meta.sizeM2) {
      return { ms: Math.max(30, meta.sizeM2 * 1.2) * 60000, source: 'surface', count: 0, precision: 'none' };
    }

    return null;
  }

  getExpectedSiteTime(addressId, timestamp = Date.now()) {
    const info = this.getSiteInfo(addressId, timestamp);
    return info ? info.ms : null;
  }

  getMostFrequentRoute(addressIds) {
    const idSet = new Set(addressIds.map(String));
    let best = null;
    let bestCount = 0;

    for (const [key, val] of Object.entries(this.routeFrequency)) {
      const routeIds = new Set(key.split(','));
      if (routeIds.size === idSet.size && [...idSet].every(id => routeIds.has(id))) {
        if (val.count > bestCount) {
          best = key.split(',');
          bestCount = val.count;
        }
      }
    }

    return best;
  }

  getStats() {
    const noteCount = Object.values(this.routeNotes).reduce((sum, n) => sum + n.length, 0);
    const metaCount = Object.keys(this.addressMeta).length;
    return {
      travelPairs: Object.keys(this.travelTimes).length,
      siteEntries: Object.keys(this.siteTimes).length,
      routePatterns: Object.keys(this.routeFrequency).length,
      routeNotes: noteCount,
      addressProfiles: metaCount
    };
  }
}
