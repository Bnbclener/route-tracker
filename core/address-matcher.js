/**
 * Matching GPS ↔ adresse connue.
 * Réutilisable dans BnB Cleaner : passer la liste d'adresses
 * depuis Supabase au lieu d'IndexedDB.
 *
 * Plusieurs logements peuvent partager un immeuble (même point GPS) :
 * classify() renvoie alors tous les candidats. Le GPS seul ne peut pas
 * trancher ; on privilégie les logements prévus ce jour-là (setPreferred).
 */

import { haversine } from './geo.js';

const DEFAULT_RADIUS_M = 50;
const HOME_RADIUS_M = 80;

export class AddressMatcher {
  constructor() {
    this.addresses = [];
    this.homeCoords = null;
    this.preferredIds = new Set();
  }

  setAddresses(addresses) {
    this.addresses = addresses.filter(a => Number.isFinite(a.lat) && Number.isFinite(a.lon));
  }

  setHome(coords) {
    this.homeCoords = coords;
  }

  setPreferred(ids) {
    this.preferredIds = new Set(ids || []);
  }

  matchAll(lat, lon, radiusM = DEFAULT_RADIUS_M) {
    const found = [];
    for (const addr of this.addresses) {
      const distance = haversine(lat, lon, addr.lat, addr.lon);
      if (distance < radiusM) found.push({ address: addr, distance });
    }
    return found.sort((a, b) => a.distance - b.distance);
  }

  match(lat, lon, radiusM = DEFAULT_RADIUS_M) {
    const all = this.matchAll(lat, lon, radiusM);
    return all.length ? all[0] : null;
  }

  isHome(lat, lon) {
    if (!this.homeCoords) return false;
    return haversine(lat, lon, this.homeCoords.lat, this.homeCoords.lon) < HOME_RADIUS_M;
  }

  classify(lat, lon) {
    if (this.isHome(lat, lon)) return { type: 'home', address: null, candidates: [] };

    const all = this.matchAll(lat, lon);
    if (all.length === 0) return { type: 'personal', address: null, candidates: [] };

    let pool = all;
    if (this.preferredIds.size > 0) {
      const preferred = all.filter(m => this.preferredIds.has(m.address.id));
      if (preferred.length > 0) pool = preferred;
    }

    return {
      type: 'client',
      address: pool[0].address,
      candidates: pool.map(m => m.address)
    };
  }
}
