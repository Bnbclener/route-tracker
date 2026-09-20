import { AddressMatcher } from './core/address-matcher.js';
import { RouteLearner } from './core/learner.js';
import { RouteOptimizer } from './core/optimizer.js';
import { IndexedDBAdapter } from './core/storage-adapter.js';
import {
  TraccarClient, DEFAULT_TRACCAR_SERVER, dayRange, importKey, buildTourFromTraccar
} from './core/traccar-adapter.js';
import { buildTourFromFile } from './core/file-import.js';

const storage = new IndexedDBAdapter();
const matcher = new AddressMatcher();
const learner = new RouteLearner();
const optimizer = new RouteOptimizer(learner);

let currentView = 'track';
let editingAddressId = null;
let planResult = null;
let exercise = null;

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '?';
  const mins = Math.round(ms / 60000);
  const hrs = Math.floor(mins / 60);
  const m = mins % 60;
  if (hrs > 0) return `${hrs}h${m.toString().padStart(2, '0')}`;
  return `${m} min`;
}

function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

function todayLocal() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function showToast(msg, type = '') {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.className = 'toast visible' + (type ? ' ' + type : '');
  setTimeout(() => toast.classList.remove('visible'), 3500);
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('GPS indisponible'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      err => reject(err),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

const SOURCE_LABELS = {
  measured: 'mesuré',
  manual: 'manuel',
  surface: 'surface',
  unknown: 'inconnu',
  start: 'départ'
};

function tag(source, count) {
  const label = SOURCE_LABELS[source] || source;
  const suffix = source === 'measured' && count > 1 ? ` ×${count}` : '';
  return `<span class="tag ${esc(source)}">${esc(label)}${suffix}</span>`;
}

async function loadContext() {
  const addresses = await storage.getAddresses();
  const home = await storage.getSetting('home');
  matcher.setAddresses(addresses);
  if (home) matcher.setHome(home);
  const savedModel = await storage.getModel();
  if (savedModel) learner.importModel(savedModel);
  return { addresses, home };
}

function switchView(name) {
  currentView = name;
  $$('.view').forEach(v => v.classList.remove('active'));
  $$('.nav-btn').forEach(b => b.classList.remove('active'));
  $(`#view-${name}`).classList.add('active');
  $(`[data-view="${name}"]`).classList.add('active');
  $('#fab-add').style.display = name === 'addresses' ? 'flex' : 'none';

  if (name === 'track') renderDay();
  if (name === 'history') renderHistory();
  if (name === 'addresses') renderAddresses();
  if (name === 'settings') renderSettings();
  if (name === 'plan') renderPlan();
}

function knownOrderKeys(tours) {
  const keys = new Set();
  for (const tour of tours) {
    const clientStops = (tour.stops || []).filter(s => s.type === 'client' && s.address);
    if (clientStops.length >= 2) {
      keys.add(clientStops.map(s => s.address.id || s.address.name).join(','));
    }
  }
  return keys;
}

// ---- JOURNÉE : IMPORT TRACCAR + EXERCICE MANUEL ----

async function renderDay() {
  const { addresses, home } = await loadContext();
  const cfg = await storage.getSetting('traccar');
  const tours = await storage.getTours();
  const container = $('#track-content');
  const configured = cfg && cfg.deviceId && (cfg.token || (cfg.email && cfg.password));

  let html = `<div class="setting-section"><h3>Import Traccar</h3>`;

  if (!configured) {
    html += `
      <div class="notice">
        Le GPS est capturé par l'appli <strong>Traccar Client</strong> sur le téléphone.
        Configurez le serveur, l'identifiant et l'appareil dans <strong>Réglages</strong>, puis revenez ici importer chaque journée.
      </div>
      <div class="section-actions">
        <button class="btn btn-primary" id="btn-go-settings">Configurer Traccar</button>
      </div>`;
  } else {
    html += `
      <div class="info-row">
        <span class="label">Appareil</span>
        <span class="value">${esc(cfg.deviceName || cfg.deviceId)}</span>
      </div>
      <div class="form-group" style="margin-top:12px">
        <label>Journée à importer</label>
        <input id="import-date" type="date" value="${todayLocal()}" max="${todayLocal()}">
      </div>
      <div class="section-actions">
        <button class="btn btn-primary" id="btn-import">Importer la journée</button>
      </div>
      <div id="import-status"></div>`;
  }
  html += `</div>
    <div class="setting-section">
      <h3>Import d'un fichier de trace</h3>
      <div class="notice">
        Sans serveur : une appli qui enregistre la trace GPS sur le téléphone (ex. Open GPX Tracker sur iPhone),
        puis partagez le fichier <strong>.gpx</strong> ici. Accepte aussi les JSON Traccar (positions ou arrêts).
        Les arrêts sont recalculés à partir des points réels (immobile ≥ 3 min dans 50 m).
      </div>
      <label class="file-drop">
        Choisir un fichier .gpx ou .json
        <input id="file-input" type="file" accept=".gpx,.json,application/gpx+xml,application/json,text/xml">
      </label>
      <div id="file-status"></div>
    </div>`;

  if (!home) {
    html += `<div class="notice">Domicile non défini : les arrêts chez vous seront classés « pause perso ». Définissez-le dans Réglages.</div>`;
  }
  if (addresses.length === 0) {
    html += `<div class="notice">Aucun logement enregistré : aucun arrêt ne pourra être reconnu comme client. Ajoutez vos adresses dans l'onglet Adresses.</div>`;
  }

  const orders = knownOrderKeys(tours);
  html += `
    <div class="setting-section">
      <h3>Exercice — saisie manuelle</h3>
      <div class="notice ok">
        L'appli propose un ordre sur vos vraies adresses ; vous saisissez les temps que vous connaissez.
        Rien n'est inventé : une case vide n'apprend rien. Les valeurs saisies comptent comme corrections manuelles.
        ${orders.size >= 3
          ? '<br><strong>3 parcours différents connus</strong> : le prochain exercice propose un ordre inédit pour accélérer l\'apprentissage.'
          : `<br>Parcours différents connus : ${orders.size}/3 avant les mélanges inédits.`}
      </div>
      <div class="section-actions">
        <button class="btn btn-primary" id="btn-exercise" ${addresses.length < 3 ? 'disabled' : ''}>Nouvel exercice</button>
      </div>
      <div id="exercise-area"></div>
    </div>`;

  container.innerHTML = html;

  const goSettings = $('#btn-go-settings');
  if (goSettings) goSettings.addEventListener('click', () => switchView('settings'));
  const importBtn = $('#btn-import');
  if (importBtn) importBtn.addEventListener('click', importDay);
  const exBtn = $('#btn-exercise');
  if (exBtn) exBtn.addEventListener('click', startExercise);
  $('#file-input').addEventListener('change', importFile);

  if (configured) showExistingImport(tours, cfg, $('#import-date').value);
  const dateInput = $('#import-date');
  if (dateInput) dateInput.addEventListener('change', () => showExistingImport(tours, cfg, dateInput.value));
}

function showExistingImport(tours, cfg, dateStr) {
  const status = $('#import-status');
  if (!status) return;
  const key = importKey(cfg.deviceId, dateStr);
  const existing = tours.find(t => t.importKey === key);
  if (!existing) {
    status.innerHTML = '';
    return;
  }
  status.innerHTML = `<div class="notice ok">Journée déjà importée (${existing.stops.length} arrêts). Réimporter remplace l'enregistrement mais l'apprentissage précédent reste.</div>`
    + renderStopsList(existing.stops);
}

function renderStopsList(stops) {
  if (!stops || stops.length === 0) return '';
  let html = '<div class="stop-list">';
  for (const stop of stops) {
    const dotClass = stop.type === 'client' ? 'client' : stop.type === 'home' ? 'home' : 'personal';
    const name = stop.address ? stop.address.name
      : stop.type === 'home' ? 'Domicile'
      : (stop.traccarAddress ? `Pause · ${stop.traccarAddress}` : 'Pause perso');
    html += `
      <div class="stop-item">
        <div class="stop-dot ${dotClass}"></div>
        <div class="stop-info">
          <div class="stop-name">${esc(name)}</div>
          <div class="stop-time">${formatTime(stop.arrivalTime)} — ${formatTime(stop.departureTime)}</div>
        </div>
        <div class="stop-duration">${formatDuration(stop.duration)}</div>
      </div>`;
  }
  return html + '</div>';
}

async function importDay() {
  const cfg = await storage.getSetting('traccar');
  const dateStr = $('#import-date').value;
  const status = $('#import-status');
  const btn = $('#btn-import');
  if (!dateStr) { showToast('Choisissez une date', 'error'); return; }

  btn.disabled = true;
  status.innerHTML = '<div class="notice">Lecture des rapports Traccar…</div>';

  try {
    await loadContext();
    const client = new TraccarClient(cfg);
    const { from, to } = dayRange(dateStr);
    const [stops, trips] = await Promise.all([
      client.getStops(cfg.deviceId, from, to),
      client.getTrips(cfg.deviceId, from, to)
    ]);

    if ((!stops || stops.length === 0) && (!trips || trips.length === 0)) {
      status.innerHTML = '<div class="notice">Aucun arrêt ni trajet enregistré par Traccar ce jour-là. Vérifiez que Traccar Client tournait sur le téléphone.</div>';
      return;
    }

    const tour = buildTourFromTraccar(
      { dateStr, deviceId: cfg.deviceId, deviceName: cfg.deviceName, stops: stops || [], trips: trips || [] },
      (lat, lon) => matcher.classify(lat, lon)
    );

    const tours = await storage.getTours();
    const existing = tours.find(t => t.importKey === tour.importKey);
    if (existing) {
      if (!confirm('Cette journée est déjà importée. Remplacer l\'enregistrement ?')) {
        status.innerHTML = '';
        return;
      }
      await storage.deleteTour(existing.id);
    } else {
      learner.learnFromTour(tour);
      await storage.saveModel(learner.exportModel());
    }

    await storage.addTour(tour);

    const clients = tour.stops.filter(s => s.type === 'client').length;
    const personal = tour.stops.filter(s => s.type === 'personal').length;
    status.innerHTML = `
      <div class="notice ok">
        Importé : ${tour.stops.length} arrêts (${clients} logements, ${personal} pauses),
        ${tour.tripCount} trajets, ${(tour.distanceM / 1000).toFixed(1)} km.
        ${existing ? 'Enregistrement remplacé, apprentissage inchangé.' : 'Apprentissage mis à jour.'}
      </div>` + renderStopsList(tour.stops);
    showToast('Journée importée', 'success');
  } catch (e) {
    status.innerHTML = `
      <div class="notice error">
        ${esc(e.message)}<br><br>
        Si le message parle de CORS : le serveur Traccar refuse les appels depuis le navigateur.
        Plan B sans serveur : exporter la journée depuis Traccar (Rapports → Arrêts → Export) et me la transmettre, on ajoutera l'import de fichier.
      </div>`;
  } finally {
    btn.disabled = false;
  }
}

async function importFile(e) {
  const file = e.target.files && e.target.files[0];
  const status = $('#file-status');
  if (!file) return;

  status.innerHTML = `<div class="notice">Lecture de ${esc(file.name)}…</div>`;
  try {
    await loadContext();
    const text = await file.text();
    const { tour, kind, pointCount, stopCount } = buildTourFromFile(text, (lat, lon) => matcher.classify(lat, lon), { fileName: file.name });
    if (!tour) throw new Error('Impossible de dater cette trace');

    const tours = await storage.getTours();
    const existing = tours.find(t => t.importKey === tour.importKey);
    if (existing) {
      status.innerHTML = '<div class="notice">Ce fichier a déjà été importé (même trace). Rien ajouté.</div>' + renderStopsList(existing.stops);
      return;
    }

    if (stopCount === 0) {
      status.innerHTML = `<div class="notice">${pointCount} points lus, mais aucun arrêt ≥ 3 min détecté. Trace enregistrée sans arrêt, rien appris.</div>`;
    }

    learner.learnFromTour(tour);
    await storage.saveModel(learner.exportModel());
    await storage.addTour(tour);

    const clients = tour.stops.filter(s => s.type === 'client').length;
    const personal = tour.stops.filter(s => s.type === 'personal').length;
    status.innerHTML = `
      <div class="notice ok">
        ${kind === 'gpx' ? 'GPX' : 'JSON Traccar'} · ${pointCount} points · ${stopCount} arrêts
        (${clients} logements, ${personal} pauses) · ${formatDate(tour.date)}.
        ${stopCount ? 'Apprentissage mis à jour.' : ''}
      </div>` + renderStopsList(tour.stops);
    showToast('Fichier importé', 'success');
  } catch (err) {
    status.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  } finally {
    e.target.value = '';
  }
}

// ---- EXERCICE MANUEL ----

async function startExercise() {
  const { addresses, home } = await loadContext();
  if (addresses.length < 3) { showToast('Il faut au moins 3 adresses', 'error'); return; }

  const tours = await storage.getTours();
  const known = knownOrderKeys(tours);
  const count = Math.min(addresses.length, 3 + Math.floor(Math.random() * 3));

  let subset;
  let order;
  let mode;

  if (known.size >= 3) {
    mode = 'inédit';
    let attempts = 0;
    do {
      subset = [...addresses].sort(() => Math.random() - 0.5).slice(0, count);
      order = subset;
      attempts++;
    } while (known.has(order.map(a => a.id || a.name).join(',')) && attempts < 30);
  } else {
    mode = 'proposé';
    subset = [...addresses].sort(() => Math.random() - 0.5).slice(0, count);
    const res = optimizer.optimize(subset, {
      startId: home ? 'home' : null,
      startCoords: home,
      departureTime: Date.now()
    });
    order = res.route;
  }

  exercise = { order, home: home || null, mode };
  renderExerciseForm();
}

function renderExerciseForm() {
  const area = $('#exercise-area');
  const { order, home, mode } = exercise;
  const now = Date.now();

  let html = `
    <div class="notice ${mode === 'inédit' ? '' : 'ok'}">
      Ordre ${mode === 'inédit' ? '<strong>inédit</strong> (mélange jamais fait)' : 'proposé par l\'algorithme'}.
      Remplissez uniquement les temps que vous connaissez réellement.
    </div>
    <div class="form-group">
      <label>Heure de départ ${home ? 'du domicile' : 'du premier logement'}</label>
      <input id="ex-start" type="time" value="08:00">
    </div>
    <div class="stop-list">`;

  let prevId = home ? 'home' : null;
  order.forEach((addr, i) => {
    const id = addr.id || addr.name;
    const travel = prevId ? learner.getTravelInfo(prevId, id, now) : null;
    const site = learner.getSiteInfo(id, now);
    const meta = learner.getAddressMeta(id);
    html += `
      <div class="stop-item" style="flex-wrap:wrap">
        <div style="width:24px;height:24px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">${i + 1}</div>
        <div class="stop-info">
          <div class="stop-name">${esc(addr.name)}${meta && meta.sizeM2 ? ` · ${meta.sizeM2} m²` : ''}</div>
          <div class="stop-time">${esc(addr.address || '')}</div>
        </div>
        <div class="step-inputs">
          ${prevId ? `
          <div>
            <label>Trajet (min) ${travel ? tag(travel.source, travel.count) : tag('unknown')}</label>
            <input type="number" min="1" step="1" inputmode="numeric" data-ex-travel="${i}" value="${travel ? Math.round(travel.ms / 60000) : ''}" placeholder="?">
          </div>` : '<div></div>'}
          <div>
            <label>Sur place (min) ${site ? tag(site.source, site.count) : tag('unknown')}</label>
            <input type="number" min="1" step="1" inputmode="numeric" data-ex-site="${i}" value="${site ? Math.round(site.ms / 60000) : ''}" placeholder="?">
          </div>
        </div>
      </div>`;
    prevId = id;
  });

  if (home) {
    const last = order[order.length - 1];
    const back = learner.getTravelInfo(last.id || last.name, 'home', now);
    html += `
      <div class="stop-item" style="flex-wrap:wrap">
        <div class="stop-dot home"></div>
        <div class="stop-info"><div class="stop-name">Retour domicile</div></div>
        <div class="step-inputs">
          <div>
            <label>Trajet (min) ${back ? tag(back.source, back.count) : tag('unknown')}</label>
            <input type="number" min="1" step="1" inputmode="numeric" id="ex-return" value="${back ? Math.round(back.ms / 60000) : ''}" placeholder="?">
          </div>
          <div></div>
        </div>
      </div>`;
  }

  html += `</div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="btn-ex-cancel">Annuler</button>
      <button class="btn btn-primary" id="btn-ex-save">Enregistrer l'exercice</button>
    </div>`;

  area.innerHTML = html;
  $('#btn-ex-cancel').addEventListener('click', () => { exercise = null; area.innerHTML = ''; });
  $('#btn-ex-save').addEventListener('click', saveExercise);
}

function minutesOf(el) {
  if (!el) return null;
  const v = parseInt(el.value, 10);
  return Number.isFinite(v) && v > 0 ? v * 60000 : null;
}

async function saveExercise() {
  const { order, home } = exercise;
  const [hh, mm] = ($('#ex-start').value || '08:00').split(':').map(Number);
  const start = new Date();
  start.setHours(hh, mm, 0, 0);
  let cursor = start.getTime();

  const stops = [];
  let filled = 0;

  if (home) {
    stops.push({ lat: home.lat, lon: home.lon, arrivalTime: cursor, departureTime: cursor, duration: 0, type: 'home', address: null });
  }

  order.forEach((addr, i) => {
    const travelMs = minutesOf($(`[data-ex-travel="${i}"]`));
    const siteMs = minutesOf($(`[data-ex-site="${i}"]`));
    if (travelMs) { cursor += travelMs; filled++; }
    const arrivalTime = cursor;
    if (siteMs) { cursor += siteMs; filled++; }
    stops.push({
      lat: addr.lat, lon: addr.lon,
      arrivalTime, departureTime: cursor,
      duration: siteMs || 0,
      type: 'client', address: addr
    });
  });

  if (home) {
    const backMs = minutesOf($('#ex-return'));
    if (backMs) {
      cursor += backMs;
      filled++;
      stops.push({ lat: home.lat, lon: home.lon, arrivalTime: cursor, departureTime: cursor, duration: 0, type: 'home', address: null });
    }
  }

  if (filled === 0) { showToast('Aucun temps saisi, rien à apprendre', 'error'); return; }

  const tour = {
    date: start.toISOString(),
    startTime: start.getTime(),
    endTime: cursor,
    totalDuration: cursor - start.getTime(),
    stops,
    status: 'complete',
    source: 'manuel',
    filledFields: filled
  };

  learner.learnFromTour(tour);
  await storage.saveModel(learner.exportModel());
  await storage.addTour(tour);

  exercise = null;
  showToast(`Exercice enregistré — ${filled} temps appris`, 'success');
  renderDay();
}

// ---- PLAN ----

async function renderPlan() {
  const { addresses, home } = await loadContext();
  const container = $('#plan-content');
  const stats = learner.getStats();

  if (addresses.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">🗺️</div>
        <div class="title">Pas encore d'adresses</div>
        <div class="subtitle">Ajoutez des logements dans l'onglet Adresses</div>
      </div>`;
    return;
  }

  planResult = optimizer.optimize(addresses, {
    startId: home ? 'home' : null,
    startCoords: home,
    departureTime: Date.now()
  });

  let html = `
    <div class="setting-section">
      <h3>Données réelles apprises</h3>
      <div class="info-row"><span class="label">Trajets connus</span><span class="value">${stats.travelPairs}</span></div>
      <div class="info-row"><span class="label">Temps sur site</span><span class="value">${stats.siteEntries} mesures</span></div>
      <div class="info-row"><span class="label">Parcours mémorisés</span><span class="value">${stats.routePatterns}</span></div>
      <div class="info-row"><span class="label">Commentaires route</span><span class="value">${stats.routeNotes || 0}</span></div>
    </div>
    <div class="setting-section">
      <h3>Tournée du jour</h3>
      <div class="info-row">
        <span class="label">Ordre</span>
        <span class="value">${planResult.basis === 'historical' ? 'parcours habituel' : 'plus proche connu d\'abord'}</span>
      </div>
      <div class="info-row">
        <span class="label">Durée totale</span>
        <span class="value">${planResult.complete ? formatDuration(planResult.totalTimeMs) : `? · ${planResult.unknownCount} donnée(s) manquante(s)`}</span>
      </div>
      <div class="info-row">
        <span class="label">Fin estimée</span>
        <span class="value">${planResult.estimatedEnd ? formatTime(planResult.estimatedEnd.getTime()) : '—'}</span>
      </div>
    </div>`;

  if (!planResult.complete) {
    html += `<div class="notice">Les « ? » sont des données que l'appli n'a pas encore : importez des journées Traccar ou cliquez une étape pour saisir ce que vous savez.</div>`;
  }

  html += '<div class="stop-list"><h3>Ordre recommandé <span style="font-size:11px;color:var(--text-muted);font-weight:400">(cliquer pour corriger)</span></h3>';

  planResult.steps.forEach((step, i) => {
    const addrId = step.address.id || step.address.name;
    const meta = learner.getAddressMeta(addrId);
    const sizeInfo = meta && meta.sizeM2 ? ` · ${meta.sizeM2} m²` : '';
    const notes = step.fromId ? learner.getRouteNotes(step.fromId, addrId) : [];
    const penaltyTag = step.travelPenalty > 0.3 ? ' ⚠️' : step.travelPenalty > 0 ? ' ⚡' : '';
    const travelText = step.travelSource === 'start'
      ? 'Point de départ'
      : `Trajet ${formatDuration(step.travelTimeMs)} ${tag(step.travelSource, step.travelCount)}${penaltyTag}`;

    html += `
      <div class="stop-item" style="flex-wrap:wrap;cursor:pointer" data-step="${i}">
        <div style="width:24px;height:24px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">${i + 1}</div>
        <div class="stop-info">
          <div class="stop-name">${esc(step.address.name)}${sizeInfo}</div>
          <div class="stop-time">Arrivée ${step.estimatedArrival ? formatTime(step.estimatedArrival.getTime()) : '—'} · ${travelText}</div>
        </div>
        <div class="stop-duration" style="text-align:right">
          ${formatDuration(step.estimatedDuration)}<br>${tag(step.siteSource, step.siteCount)}
        </div>`;

    if (notes.length > 0) {
      html += `<div style="width:100%;padding:6px 0 0 36px">`;
      for (const note of notes) {
        const noteDate = new Date(note.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
        html += `<div style="font-size:11px;color:var(--warning);margin-bottom:2px">💬 ${esc(note.text)} <span style="color:var(--text-muted)">(${noteDate})</span></div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  });

  if (home) {
    const back = planResult.returnTravel;
    html += `
      <div class="stop-item">
        <div class="stop-dot home"></div>
        <div class="stop-info">
          <div class="stop-name">Retour domicile</div>
          <div class="stop-time">Trajet ${back ? formatDuration(back.ms) : '?'} ${back ? tag(back.source, back.count) : tag('unknown')}</div>
        </div>
      </div>`;
  }

  html += `</div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:12px;padding:0 4px;line-height:1.7">
      ${tag('measured')} GPS Traccar · ${tag('manual')} saisi par vous · ${tag('surface')} déduit de la surface (1,2 min/m²) · ${tag('unknown')} aucune donnée<br>
      ⚡ route signalée · ⚠️ route pénalisée par vos commentaires
    </div>`;

  container.innerHTML = html;
  container.querySelectorAll('[data-step]').forEach(el => {
    el.addEventListener('click', () => openStepEditor(parseInt(el.dataset.step, 10)));
  });
}

function openStepEditor(stepIndex) {
  if (!planResult || !planResult.steps[stepIndex]) return;
  const step = planResult.steps[stepIndex];
  const addrId = step.address.id || step.address.name;
  const prevId = step.fromId;
  const meta = learner.getAddressMeta(addrId);
  const notes = prevId ? learner.getRouteNotes(prevId, addrId) : [];
  const prevName = !prevId ? null
    : prevId === 'home' ? 'Domicile'
    : (planResult.steps[stepIndex - 1] ? planResult.steps[stepIndex - 1].address.name : prevId);

  const modal = $('#address-modal');
  const body = $('#modal-body');

  body.innerHTML = `
    <h2>${esc(step.address.name)}</h2>
    ${prevId ? `
    <div class="form-group">
      <label>Trajet depuis ${esc(prevName)} (minutes) — actuel : ${formatDuration(step.travelTimeMs)} ${tag(step.travelSource, step.travelCount)}</label>
      <input id="edit-travel" type="number" min="1" step="1" inputmode="numeric" value="${step.travelTimeMs ? Math.round(step.travelTimeMs / 60000) : ''}" placeholder="Laisser vide si inconnu">
    </div>` : ''}
    <div class="form-group">
      <label>Temps sur place (minutes) — actuel : ${formatDuration(step.estimatedDuration)} ${tag(step.siteSource, step.siteCount)}</label>
      <input id="edit-site" type="number" min="1" step="1" inputmode="numeric" value="${step.estimatedDuration ? Math.round(step.estimatedDuration / 60000) : ''}" placeholder="Laisser vide si inconnu">
    </div>
    <div class="form-group">
      <label>Surface du logement (m²)</label>
      <input id="edit-size" type="number" min="1" step="1" inputmode="numeric" value="${meta && meta.sizeM2 ? meta.sizeM2 : ''}" placeholder="Ex: 45">
    </div>
    <div class="form-group">
      <label>Type de logement</label>
      <input id="edit-type" type="text" value="${esc(meta && meta.type ? meta.type : '')}" placeholder="Ex: T2, studio, duplex">
    </div>
    ${prevId ? `
    <div class="form-group">
      <label>Commentaire sur ce trajet</label>
      <input id="edit-note" type="text" placeholder="Ex: Marx Dormoy toujours bouchée">
    </div>` : ''}
    ${notes.length > 0 ? `
    <div style="margin-bottom:16px">
      <label style="font-size:13px;color:var(--text-muted);display:block;margin-bottom:6px">Commentaires existants</label>
      ${notes.map((n, idx) => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12px">
          <span style="flex:1;color:var(--warning)">💬 ${esc(n.text)}</span>
          <button class="btn-icon danger" style="width:28px;height:28px;font-size:12px" data-del-note="${idx}">✕</button>
        </div>`).join('')}
    </div>` : ''}
    <div class="form-actions">
      <button id="btn-cancel-edit" class="btn btn-secondary">Annuler</button>
      <button id="btn-save-edit" class="btn btn-primary">Enregistrer</button>
    </div>`;

  modal.classList.add('active');

  $('#btn-cancel-edit').addEventListener('click', closeModal);

  $('#btn-save-edit').addEventListener('click', async () => {
    const travelMs = minutesOf($('#edit-travel'));
    const siteMs = minutesOf($('#edit-site'));
    const sizeM2 = parseInt($('#edit-size').value, 10);
    const type = $('#edit-type').value.trim();
    const noteEl = $('#edit-note');
    const noteText = noteEl ? noteEl.value.trim() : '';

    const travelChanged = travelMs && Math.round((step.travelTimeMs || 0) / 60000) !== travelMs / 60000;
    const siteChanged = siteMs && Math.round((step.estimatedDuration || 0) / 60000) !== siteMs / 60000;

    if (prevId && travelChanged) learner.manualCorrectTravel(prevId, addrId, travelMs);
    if (siteChanged) learner.manualCorrectSiteTime(addrId, siteMs);
    if (Number.isFinite(sizeM2) && sizeM2 > 0) learner.setAddressMeta(addrId, { sizeM2 });
    if (type) learner.setAddressMeta(addrId, { type });
    if (prevId && noteText) learner.addRouteNote(prevId, addrId, noteText);

    await storage.saveModel(learner.exportModel());
    closeModal();
    showToast('Corrections enregistrées', 'success');
    renderPlan();
  });

  body.querySelectorAll('[data-del-note]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      learner.deleteRouteNote(prevId, addrId, parseInt(btn.dataset.delNote, 10));
      await storage.saveModel(learner.exportModel());
      showToast('Commentaire supprimé');
      openStepEditor(stepIndex);
    });
  });
}

function closeModal() {
  $('#address-modal').classList.remove('active');
  editingAddressId = null;
}

// ---- ADDRESSES ----

async function renderAddresses() {
  const { addresses, home } = await loadContext();
  const container = $('#address-list');

  if (addresses.length === 0 && !home) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">📍</div>
        <div class="title">Aucune adresse</div>
        <div class="subtitle">Ajoutez vos logements clients avec le bouton +</div>
      </div>`;
    return;
  }

  let html = '';
  if (home) {
    html += `
      <div class="address-card">
        <div class="icon home-icon">🏠</div>
        <div class="address-details">
          <div class="address-name">Domicile</div>
          <div class="address-text">${home.lat.toFixed(5)}, ${home.lon.toFixed(5)}</div>
        </div>
      </div>`;
  }

  for (const addr of addresses) {
    const meta = learner.getAddressMeta(addr.id || addr.name);
    const extra = meta ? [meta.type, meta.sizeM2 ? `${meta.sizeM2} m²` : null].filter(Boolean).join(' · ') : '';
    html += `
      <div class="address-card">
        <div class="icon">🏢</div>
        <div class="address-details">
          <div class="address-name">${esc(addr.name)}${extra ? ` <span class="tag">${esc(extra)}</span>` : ''}</div>
          <div class="address-text">${esc(addr.address || `${addr.lat.toFixed(4)}, ${addr.lon.toFixed(4)}`)}</div>
        </div>
        <div class="address-actions">
          <button class="btn-icon" data-edit="${addr.id}">✏️</button>
          <button class="btn-icon danger" data-delete="${addr.id}">🗑</button>
        </div>
      </div>`;
  }

  container.innerHTML = html;
  container.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => editAddress(parseInt(btn.dataset.edit, 10)));
  });
  container.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteAddress(parseInt(btn.dataset.delete, 10)));
  });
}

function openAddressModal(addr) {
  editingAddressId = addr ? addr.id : null;
  const meta = addr ? learner.getAddressMeta(addr.id || addr.name) : null;
  $('#modal-body').innerHTML = `
    <h2>${addr ? 'Modifier le logement' : 'Nouveau logement'}</h2>
    <div class="form-group">
      <label>Nom du logement</label>
      <input id="input-name" type="text" value="${esc(addr ? addr.name : '')}" placeholder="Ex: Appt Bastille">
    </div>
    <div class="form-group">
      <label>Adresse (optionnel)</label>
      <input id="input-address" type="text" value="${esc(addr ? addr.address || '' : '')}" placeholder="12 rue de la Paix, Paris">
    </div>
    <div class="form-group">
      <label>Latitude</label>
      <input id="input-lat" type="number" step="any" value="${addr ? addr.lat : ''}" placeholder="48.8566">
    </div>
    <div class="form-group">
      <label>Longitude</label>
      <input id="input-lon" type="number" step="any" value="${addr ? addr.lon : ''}" placeholder="2.3522">
    </div>
    <div class="step-inputs" style="padding:0;margin-bottom:16px">
      <div>
        <label>Surface (m²)</label>
        <input id="input-size" type="number" min="1" step="1" inputmode="numeric" value="${meta && meta.sizeM2 ? meta.sizeM2 : ''}" placeholder="Ex: 45">
      </div>
      <div>
        <label>Type</label>
        <input id="input-type" type="text" value="${esc(meta && meta.type ? meta.type : '')}" placeholder="T2, studio…">
      </div>
    </div>
    <button id="btn-gps-capture" class="btn-gps">📍 Capturer ma position actuelle</button>
    <div class="form-actions">
      <button id="btn-cancel-address" class="btn btn-secondary">Annuler</button>
      <button id="btn-save-address" class="btn btn-primary">Enregistrer</button>
    </div>`;

  $('#btn-save-address').addEventListener('click', saveAddress);
  $('#btn-cancel-address').addEventListener('click', closeModal);
  $('#btn-gps-capture').addEventListener('click', gpsForAddress);
  $('#address-modal').classList.add('active');
}

async function saveAddress() {
  const name = $('#input-name').value.trim();
  const address = $('#input-address').value.trim();
  const lat = parseFloat($('#input-lat').value);
  const lon = parseFloat($('#input-lon').value);
  const sizeM2 = parseInt($('#input-size').value, 10);
  const type = $('#input-type').value.trim();

  if (!name) { showToast('Nom requis', 'error'); return; }
  if (isNaN(lat) || isNaN(lon)) { showToast('Coordonnées requises', 'error'); return; }

  const data = { name, address, lat, lon };
  let id = editingAddressId;
  if (id) {
    data.id = id;
    await storage.updateAddress(data);
  } else {
    id = await storage.addAddress(data);
  }

  const meta = {};
  if (Number.isFinite(sizeM2) && sizeM2 > 0) meta.sizeM2 = sizeM2;
  if (type) meta.type = type;
  if (Object.keys(meta).length) {
    learner.setAddressMeta(id, meta);
    await storage.saveModel(learner.exportModel());
  }

  showToast(editingAddressId ? 'Adresse modifiée' : 'Adresse ajoutée', 'success');
  closeModal();
  renderAddresses();
}

async function editAddress(id) {
  const addresses = await storage.getAddresses();
  const addr = addresses.find(a => a.id === id);
  if (addr) openAddressModal(addr);
}

async function deleteAddress(id) {
  if (!confirm('Supprimer ce logement ?')) return;
  await storage.deleteAddress(id);
  showToast('Adresse supprimée');
  renderAddresses();
}

async function gpsForAddress() {
  try {
    const pos = await getCurrentPosition();
    $('#input-lat').value = pos.lat.toFixed(6);
    $('#input-lon').value = pos.lon.toFixed(6);
    showToast(`Position capturée (±${Math.round(pos.accuracy)} m)`, 'success');
  } catch {
    showToast('GPS indisponible', 'error');
  }
}

// ---- HISTORY ----

async function renderHistory() {
  const tours = await storage.getTours();
  const container = $('#history-list');

  if (tours.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">📊</div>
        <div class="title">Aucune tournée</div>
        <div class="subtitle">Importez une journée Traccar ou enregistrez un exercice</div>
      </div>`;
    return;
  }

  const sorted = tours.sort((a, b) => new Date(b.date) - new Date(a.date));
  let html = '';

  for (const tour of sorted) {
    const clientStops = tour.stops.filter(s => s.type === 'client');
    const totalOnSite = tour.stops.reduce((sum, s) => sum + (s.duration || 0), 0);
    const totalTour = tour.totalDuration || (tour.endTime - tour.startTime);
    const travelTime = totalTour - totalOnSite;
    const source = tour.source || 'gps';

    html += `
      <div class="tour-card">
        <div class="tour-header">
          <div class="tour-date">${formatDate(tour.date)}</div>
          <span class="tag ${esc(source)}">${source === 'traccar' ? 'GPS Traccar' : source === 'manuel' ? 'Exercice manuel' : source === 'fichier' ? `Fichier ${tour.fileKind === 'gpx' ? 'GPX' : 'JSON'}` : 'GPS'}</span>
        </div>
        <div class="tour-stats">
          <div class="tour-stat"><span class="label">Durée totale</span><span class="value">${formatDuration(totalTour)}</span></div>
          <div class="tour-stat"><span class="label">Logements</span><span class="value">${clientStops.length}</span></div>
          <div class="tour-stat"><span class="label">${tour.distanceM ? 'Distance' : 'Trajets'}</span><span class="value">${tour.distanceM ? `${(tour.distanceM / 1000).toFixed(1)} km` : formatDuration(travelTime > 0 ? travelTime : 0)}</span></div>
        </div>
        <div class="tour-stops-list">`;

    for (const stop of tour.stops) {
      const dotClass = stop.type === 'client' ? 'client' : stop.type === 'home' ? 'home' : 'personal';
      const name = stop.address ? stop.address.name
        : stop.type === 'home' ? 'Domicile'
        : (stop.traccarAddress || 'Pause perso');
      html += `
          <div class="tour-stop-row">
            <span class="time">${formatTime(stop.arrivalTime)}</span>
            <div class="stop-dot ${dotClass}"></div>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span>
            <span class="stop-duration">${stop.duration ? formatDuration(stop.duration) : ''}</span>
          </div>`;
    }

    html += `
        </div>
        <div class="tour-delete" data-tour-delete="${tour.id}">Supprimer cette tournée</div>
      </div>`;
  }

  container.innerHTML = html;
  container.querySelectorAll('[data-tour-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteTour(parseInt(btn.dataset.tourDelete, 10)));
  });
}

async function deleteTour(id) {
  if (!confirm('Supprimer cette tournée ? Ce qu\'elle a déjà appris au modèle reste.')) return;
  await storage.deleteTour(id);
  showToast('Tournée supprimée');
  renderHistory();
}

// ---- SETTINGS ----

async function renderSettings() {
  const home = await storage.getSetting('home');
  const cfg = (await storage.getSetting('traccar')) || {};
  const container = $('#settings-content');

  container.innerHTML = `
    <div class="setting-section">
      <h3>Domicile</h3>
      <div class="setting-row">
        <div>
          <div class="setting-label">Adresse de départ</div>
          <div class="coords-display">${home ? `${home.lat.toFixed(5)}, ${home.lon.toFixed(5)}` : 'Non défini'}</div>
        </div>
        <button class="btn-gps" id="btn-set-home">📍 GPS actuel</button>
      </div>
    </div>

    <div class="setting-section">
      <h3>Traccar (source GPS)</h3>
      <div class="notice">
        1. Installez <strong>Traccar Client</strong> sur le téléphone (App Store / Play Store).<br>
        2. Créez un compte sur le serveur (démo gratuite : demo.traccar.org, historique non garanti).<br>
        3. Dans le site Traccar, ajoutez l'appareil avec l'identifiant affiché dans l'appli.<br>
        4. Générez un token : Traccar → Compte → Token (recommandé, évite de stocker le mot de passe ici).
      </div>
      <div class="form-group">
        <label>URL du serveur</label>
        <input id="tr-server" type="url" value="${esc(cfg.serverUrl || DEFAULT_TRACCAR_SERVER)}" placeholder="${DEFAULT_TRACCAR_SERVER}">
      </div>
      <div class="form-group">
        <label>Token API (recommandé)</label>
        <input id="tr-token" type="text" value="${esc(cfg.token || '')}" placeholder="Collez le token Traccar" autocomplete="off">
      </div>
      <div class="form-group">
        <label>Ou e-mail du compte Traccar</label>
        <input id="tr-email" type="email" value="${esc(cfg.email || '')}" placeholder="vous@exemple.fr" autocomplete="off">
      </div>
      <div class="form-group">
        <label>Mot de passe Traccar (stocké sur cet appareil uniquement)</label>
        <input id="tr-password" type="password" value="${esc(cfg.password || '')}" autocomplete="off">
      </div>
      <div class="section-actions">
        <button class="btn btn-secondary" id="btn-tr-test">Tester et lister les appareils</button>
      </div>
      <div id="tr-devices">
        ${cfg.deviceId ? `<div class="info-row"><span class="label">Appareil enregistré</span><span class="value">${esc(cfg.deviceName || cfg.deviceId)}</span></div>` : ''}
      </div>
      <div class="section-actions">
        <button class="btn btn-primary" id="btn-tr-save">Enregistrer Traccar</button>
      </div>
    </div>

    <div class="setting-section">
      <h3>Détection des arrêts</h3>
      <div class="setting-row"><span class="setting-label">Calculée par</span><span class="setting-value">serveur Traccar</span></div>
      <div class="setting-row"><span class="setting-label">Arrêt = immobile</span><span class="setting-value">≥ 180 s (défaut serveur)</span></div>
      <div class="setting-row"><span class="setting-label">Rayon logement</span><span class="setting-value">50 m</span></div>
      <div class="setting-row"><span class="setting-label">Rayon domicile</span><span class="setting-value">80 m</span></div>
    </div>

    <div class="setting-section">
      <h3>Données</h3>
      <div class="setting-row" style="cursor:pointer" id="btn-export">
        <span class="setting-label">Exporter les données</span>
        <span class="setting-value">JSON</span>
      </div>
      <div class="setting-row" style="cursor:pointer" id="btn-clear">
        <span class="setting-label" style="color:var(--danger)">Effacer toutes les données</span>
        <span class="setting-value">⚠️</span>
      </div>
    </div>`;

  $('#btn-set-home').addEventListener('click', setHomeGPS);
  $('#btn-export').addEventListener('click', exportData);
  $('#btn-clear').addEventListener('click', clearAllData);
  $('#btn-tr-test').addEventListener('click', testTraccar);
  $('#btn-tr-save').addEventListener('click', () => saveTraccar(cfg));
}

function readTraccarForm() {
  return {
    serverUrl: ($('#tr-server').value.trim() || DEFAULT_TRACCAR_SERVER),
    token: $('#tr-token').value.trim() || null,
    email: $('#tr-email').value.trim() || null,
    password: $('#tr-password').value || null
  };
}

async function testTraccar() {
  const form = readTraccarForm();
  const box = $('#tr-devices');
  const client = new TraccarClient(form);
  if (!client.hasCredentials()) { showToast('Token ou e-mail + mot de passe requis', 'error'); return; }

  box.innerHTML = '<div class="notice">Connexion…</div>';
  try {
    const devices = await client.getDevices();
    if (!devices.length) {
      box.innerHTML = '<div class="notice">Connexion OK mais aucun appareil sur ce compte. Ajoutez le téléphone dans Traccar avec l\'identifiant de l\'appli.</div>';
      return;
    }
    const saved = (await storage.getSetting('traccar')) || {};
    box.innerHTML = `
      <div class="notice ok">Connexion OK — ${devices.length} appareil(s)</div>
      <div class="form-group">
        <label>Appareil à suivre</label>
        <select id="tr-device" class="input">
          ${devices.map(d => `<option value="${d.id}" data-name="${esc(d.name)}" ${String(saved.deviceId) === String(d.id) ? 'selected' : ''}>${esc(d.name)} (${esc(d.uniqueId)})</option>`).join('')}
        </select>
      </div>`;
  } catch (e) {
    box.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
  }
}

async function saveTraccar(previous) {
  const form = readTraccarForm();
  const select = $('#tr-device');
  const cfg = { ...previous, ...form };
  if (select) {
    cfg.deviceId = parseInt(select.value, 10);
    cfg.deviceName = select.selectedOptions[0].dataset.name;
  }
  if (cfg.token) { cfg.email = null; cfg.password = null; }
  await storage.setSetting('traccar', cfg);
  showToast(cfg.deviceId ? 'Traccar enregistré' : 'Enregistré — testez pour choisir l\'appareil', 'success');
  renderSettings();
}

async function setHomeGPS() {
  try {
    const pos = await getCurrentPosition();
    const home = { lat: pos.lat, lon: pos.lon };
    await storage.setSetting('home', home);
    matcher.setHome(home);
    showToast(`Domicile enregistré (±${Math.round(pos.accuracy)} m)`, 'success');
    renderSettings();
  } catch {
    showToast('GPS indisponible', 'error');
  }
}

async function exportData() {
  const addresses = await storage.getAddresses();
  const tours = await storage.getTours();
  const home = await storage.getSetting('home');
  const model = await storage.getModel();
  const data = { home, addresses, tours, model, exportDate: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `route-tracker-${todayLocal()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Données exportées', 'success');
}

async function clearAllData() {
  if (!confirm('Supprimer toutes les données (adresses, tournées, apprentissage, réglages) ? Irréversible.')) return;
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('route-tracker', 2);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const stores = ['addresses', 'tours', 'settings', 'model'];
  const available = stores.filter(s => db.objectStoreNames.contains(s));
  const tx = db.transaction(available, 'readwrite');
  available.forEach(s => tx.objectStore(s).clear());
  await new Promise(resolve => { tx.oncomplete = resolve; });
  learner.importModel({ travelTimes: {}, siteTimes: {}, routeFrequency: {}, routeNotes: {}, addressMeta: {} });
  matcher.setAddresses([]);
  matcher.setHome(null);
  showToast('Données effacées');
  renderSettings();
}

// ---- INIT ----

document.addEventListener('DOMContentLoaded', () => {
  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  $('#fab-add').addEventListener('click', () => openAddressModal(null));
  $('#address-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  switchView('track');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
