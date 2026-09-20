/**
 * Optimiseur de tournée.
 *
 * Règle absolue : aucun temps inventé.
 * - Un trajet ou un temps sur place n'est affiché que s'il vient de données
 *   réelles (mesures GPS, saisie manuelle, ou surface saisie par l'utilisateur).
 * - Sans donnée, la valeur est null et l'interface affiche « ? ».
 * - La distance à vol d'oiseau sert uniquement à ORDONNER les adresses
 *   inconnues (plus proche d'abord), jamais à produire une durée.
 *
 * Réutilisable dans BnB Cleaner.
 */

import { haversine } from './geo.js';

function idOf(addr) {
  return addr.id || addr.name;
}

export class RouteOptimizer {
  constructor(learner) {
    this.learner = learner;
  }

  /**
   * options.startId     : identifiant du point de départ ('home' par défaut, null = aucun)
   * options.startCoords : { lat, lon } du départ, sert à l'ordre géographique de repli
   * options.departureTime : timestamp de départ
   */
  optimize(addresses, options = {}) {
    const {
      startId = 'home',
      startCoords = null,
      departureTime = Date.now()
    } = options;

    if (addresses.length === 0) {
      return this.buildResult([], startId, departureTime);
    }

    const nnRoute = this.nearestNeighbor(addresses, startId, startCoords, departureTime);
    const histRoute = this.tryHistoricalRoute(addresses);

    let chosen = nnRoute;
    let basis = 'nearest';
    if (histRoute) {
      const histCost = this.routeCost(histRoute, startId, departureTime);
      const nnCost = this.routeCost(nnRoute, startId, departureTime);
      const histBetter =
        histCost.unknown < nnCost.unknown ||
        (histCost.unknown === nnCost.unknown && histCost.knownMs <= nnCost.knownMs);
      if (histBetter) {
        chosen = histRoute;
        basis = 'historical';
      }
    }

    const result = this.buildResult(chosen, startId, departureTime);
    result.basis = basis;
    return result;
  }

  nearestNeighbor(addresses, startId, startCoords, timestamp) {
    const remaining = [...addresses];
    const route = [];
    let prevId = startId;
    let prevCoords = startCoords;
    let time = timestamp;

    while (remaining.length > 0) {
      let bestIdx = -1;
      let bestMs = Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const info = this.learner.getTravelInfo(prevId, idOf(remaining[i]), time);
        if (info && info.ms < bestMs) {
          bestMs = info.ms;
          bestIdx = i;
        }
      }

      let knownLeg = bestIdx !== -1;
      if (!knownLeg) {
        bestIdx = 0;
        if (prevCoords) {
          let bestDist = Infinity;
          for (let i = 0; i < remaining.length; i++) {
            const d = haversine(prevCoords.lat, prevCoords.lon, remaining[i].lat, remaining[i].lon);
            if (d < bestDist) {
              bestDist = d;
              bestIdx = i;
            }
          }
        }
      }

      const chosen = remaining.splice(bestIdx, 1)[0];
      route.push(chosen);

      if (knownLeg) {
        time += bestMs;
        const site = this.learner.getSiteInfo(idOf(chosen), time);
        if (site) time += site.ms;
      }

      prevId = idOf(chosen);
      prevCoords = { lat: chosen.lat, lon: chosen.lon };
    }

    return route;
  }

  tryHistoricalRoute(addresses) {
    const ids = addresses.map(idOf);
    const order = this.learner.getMostFrequentRoute(ids);
    if (!order) return null;

    const byId = {};
    for (const addr of addresses) byId[idOf(addr)] = addr;

    const route = order.map(id => byId[id]).filter(Boolean);
    return route.length === addresses.length ? route : null;
  }

  routeCost(route, startId, timestamp) {
    let knownMs = 0;
    let unknown = 0;
    let time = timestamp;
    let prevId = startId;

    for (const addr of route) {
      const id = idOf(addr);
      const travel = prevId != null ? this.learner.getTravelInfo(prevId, id, time) : { ms: 0 };
      if (travel) {
        knownMs += travel.ms;
        time += travel.ms;
      } else {
        unknown++;
      }
      const site = this.learner.getSiteInfo(id, time);
      if (site) {
        knownMs += site.ms;
        time += site.ms;
      } else {
        unknown++;
      }
      prevId = id;
    }

    if (startId != null && route.length > 0) {
      const back = this.learner.getTravelInfo(idOf(route[route.length - 1]), startId, time);
      if (back) knownMs += back.ms; else unknown++;
    }

    return { knownMs, unknown };
  }

  buildResult(route, startId, departureTime) {
    const steps = [];
    let time = departureTime;
    let chainKnown = true;
    let unknownCount = 0;
    let prevId = startId;

    for (const addr of route) {
      const id = idOf(addr);

      let travel;
      if (prevId == null) {
        travel = { ms: 0, source: 'start', count: 0, penalty: 0 };
      } else {
        travel = this.learner.getTravelInfo(prevId, id, time);
      }

      let arrival = null;
      if (travel && chainKnown) {
        time += travel.ms;
        arrival = time;
      } else {
        chainKnown = false;
        if (!travel) unknownCount++;
      }

      const site = this.learner.getSiteInfo(id, arrival || time);
      let departure = null;
      if (site && chainKnown) {
        time += site.ms;
        departure = time;
      } else {
        chainKnown = false;
        if (!site) unknownCount++;
      }

      steps.push({
        address: addr,
        fromId: prevId,
        travelTimeMs: travel ? travel.ms : null,
        travelSource: travel ? travel.source : 'unknown',
        travelCount: travel ? travel.count : 0,
        travelPenalty: travel ? travel.penalty || 0 : 0,
        estimatedArrival: arrival ? new Date(arrival) : null,
        estimatedDuration: site ? site.ms : null,
        siteSource: site ? site.source : 'unknown',
        siteCount: site ? site.count : 0,
        estimatedDeparture: departure ? new Date(departure) : null
      });

      prevId = id;
    }

    let returnTravel = null;
    if (startId != null && route.length > 0) {
      const back = this.learner.getTravelInfo(idOf(route[route.length - 1]), startId, time);
      if (back) {
        returnTravel = { ms: back.ms, source: back.source, count: back.count };
        if (chainKnown) time += back.ms;
      } else {
        unknownCount++;
        chainKnown = false;
      }
    }

    return {
      route,
      steps,
      returnTravel,
      complete: chainKnown,
      unknownCount,
      totalTimeMs: chainKnown ? time - departureTime : null,
      estimatedEnd: chainKnown ? new Date(time) : null,
      stepsCount: route.length
    };
  }
}
