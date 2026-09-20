/**
 * Module géographique réutilisable.
 * Aucune dépendance — importable dans BnB Cleaner tel quel.
 */

const EARTH_RADIUS_M = 6371000;
const DEG_TO_RAD = Math.PI / 180;

export function toRad(deg) {
  return deg * DEG_TO_RAD;
}

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function isWithinRadius(lat1, lon1, lat2, lon2, radiusM) {
  return haversine(lat1, lon1, lat2, lon2) <= radiusM;
}

export function centroid(points) {
  if (!points.length) return null;
  const sum = points.reduce(
    (acc, p) => ({ lat: acc.lat + p.lat, lon: acc.lon + p.lon }),
    { lat: 0, lon: 0 }
  );
  return { lat: sum.lat / points.length, lon: sum.lon / points.length };
}
