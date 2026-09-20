/**
 * Matching GPS ↔ adresse connue.
 * Réutilisable dans BnB Cleaner : passer la liste d'adresses
 * depuis Supabase au lieu d'IndexedDB.
 */

import { haversine } from './geo.js';

const DEFAULT_RADIUS_M = 50;
const HOME_RADIUS_M = 80;

export class AddressMatcher {
  constructor() {
    this.addresses = [];
    this.homeCoords = null;
  }

  setAddresses(addresses) {
    this.addresses = addresses.filter(a => a.lat && a.lon);
  }

  setHome(coords) {
    this.homeCoords = coords;
  }

  match(lat, lon, radiusM = DEFAULT_RADIUS_M) {
    let closest = null;
    let minDist = Infinity;

    for (const addr of this.addresses) {
      const dist = haversine(lat, lon, addr.lat, addr.lon);
      if (dist < radiusM && dist < minDist) {
        closest = addr;
        minDist = dist;
      }
    }

    return closest ? { address: closest, distance: minDist } : null;
  }

  isHome(lat, lon) {
    if (!this.homeCoords) return false;
    return haversine(lat, lon, this.homeCoords.lat, this.homeCoords.lon) < HOME_RADIUS_M;
  }

  classify(lat, lon) {
    if (this.isHome(lat, lon)) return { type: 'home', address: null };
    const match = this.match(lat, lon);
    if (match) return { type: 'client', address: match.address };
    return { type: 'personal', address: null };
  }
}
