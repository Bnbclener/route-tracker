/**
 * Point d'entrée du noyau Route Tracker.
 * Importer dans BnB Cleaner :
 *   import { AddressMatcher, RouteLearner, RouteOptimizer, TraccarClient } from './core';
 */

export { haversine, isWithinRadius, centroid } from './geo.js';
export { StopDetector, detectStopsFromTrack } from './stop-detector.js';
export { detectFileKind, parseGPX, parseTraccarPositions, buildTourFromFile } from './file-import.js';
export { AddressMatcher } from './address-matcher.js';
export { RouteLearner } from './learner.js';
export { RouteOptimizer } from './optimizer.js';
export { StorageAdapter, IndexedDBAdapter } from './storage-adapter.js';
export { TraccarClient, DEFAULT_TRACCAR_SERVER, dayRange, importKey, buildTourFromTraccar } from './traccar-adapter.js';
