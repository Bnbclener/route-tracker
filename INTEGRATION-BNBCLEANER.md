# Intégration dans BnB Cleaner

## Principe

- **Traccar** capture le GPS (appli Traccar Client sur le téléphone du prestataire, serveur Traccar).
- **Route Tracker** lit les rapports Traccar (arrêts + trajets), reconnaît les logements, apprend les durées réelles et propose l'ordre de tournée.
- **Aucune donnée inventée** : sans mesure GPS, sans saisie manuelle et sans surface connue, une durée vaut `null` et s'affiche « ? ».

## Architecture modulaire

Le dossier `core/` contient le noyau réutilisable, sans dépendance :

```
core/
├── geo.js              → haversine (distance), utilisé seulement pour ordonner les inconnus
├── stop-detector.js    → détection d'arrêts à partir de positions brutes (si un jour on lit /positions)
├── address-matcher.js  → position ↔ logement connu (50 m) / domicile (80 m)
├── learner.js          → apprentissage : trajets directionnels, temps sur site, commentaires, corrections manuelles
├── optimizer.js        → ordre de tournée ; ne produit jamais une durée sans source
├── traccar-adapter.js  → client REST Traccar + conversion rapports → tournée
├── storage-adapter.js  → interface de stockage (IndexedDB ici, Supabase dans BnB Cleaner)
└── index.js            → point d'entrée unique
```

## Sources d'une valeur affichée

| Étiquette | Origine |
|-----------|---------|
| `measured` | rapports Traccar (GPS réel), moyenne mobile α = 0,3 |
| `manual` | saisi par l'utilisateur (exercice ou correction), α = 0,6, puis le GPS pèse moitié moins |
| `surface` | temps sur place déduit de la surface saisie : max(30 min, 1,2 min/m²) |
| `unknown` | rien → `null` → « ? » |

Le point de départ est l'identifiant `'home'` dans le modèle. Les trajets sont directionnels : `A__B` ≠ `B__A`.

## Pour intégrer dans BnB Cleaner (React/TSX)

### 1. Copier `core/`
```bash
cp -r route-tracker/core/ maquette/fusion-tsx/src/core/route-tracker/
```

### 2. Adaptateur Supabase
Implémenter `SupabaseStorageAdapter` (template dans `storage-adapter.js`). Les logements viennent de la table `logements`, les tournées vont dans `tournees` / `arrets`, le modèle appris dans `route_model` (un JSON par prestataire).

### 3. Import d'une journée
```ts
import { TraccarClient, dayRange, buildTourFromTraccar, AddressMatcher, RouteLearner } from '@/core/route-tracker';

const client = new TraccarClient({ serverUrl, token });
const { from, to } = dayRange('2026-09-20');
const [stops, trips] = await Promise.all([
  client.getStops(deviceId, from, to),
  client.getTrips(deviceId, from, to)
]);

const matcher = new AddressMatcher();
matcher.setAddresses(logements);
matcher.setHome(domicilePrestataire);

const tour = buildTourFromTraccar({ dateStr: '2026-09-20', deviceId, deviceName, stops, trips },
  (lat, lon) => matcher.classify(lat, lon));

learner.learnFromTour(tour);
await supabase.from('route_model').upsert({ agent_id, model: learner.exportModel() });
```

Côté serveur (Edge Function / cron) c'est préférable : pas de CORS, token Traccar jamais exposé au navigateur.

### 4. Planification
```ts
const result = optimizer.optimize(logementsDuJour, { startId: 'home', startCoords: domicile, departureTime: Date.now() });
// result.complete === false → afficher les « ? », ne jamais combler avec une valeur par défaut
```

### 5. Schéma Supabase suggéré
```sql
CREATE TABLE tournees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  date DATE NOT NULL,
  source TEXT NOT NULL,            -- 'traccar' | 'manuel'
  import_key TEXT UNIQUE,          -- traccar_<deviceId>_<date>, anti-doublon
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  distance_m INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE arrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournee_id UUID REFERENCES tournees(id) ON DELETE CASCADE,
  logement_id UUID REFERENCES logements(id),
  type TEXT NOT NULL,              -- 'client' | 'home' | 'personal'
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  arrival_time TIMESTAMPTZ,
  departure_time TIMESTAMPTZ,
  duration_ms INTEGER,
  traccar_address TEXT
);

CREATE TABLE route_model (
  agent_id UUID PRIMARY KEY REFERENCES agents(id),
  model JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

## Traccar — repères vérifiés (septembre 2026)

- Serveurs démo gratuits : `demo.traccar.org`, `demo2`, `demo3`, `demo4` — appareils illimités, historique et disponibilité non garantis. Donc importer chaque journée rapidement ; Route Tracker / BnB Cleaner reste la source de vérité.
- Offres payantes : Tracking Account dès 9,95 $/mois, Tracking Server dès 49,95 $/mois.
- API : `GET /api/reports/stops` et `/api/reports/trips` avec `deviceId`, `from`, `to` (ISO 8601), en-tête `Accept: application/json`. Auth : `Authorization: Bearer <token>` ou Basic.
- Détection d'arrêt côté serveur : `report.trip.minDuration` = 180 s par défaut.
- CORS : dépend du réglage `web.origin` du serveur ; non modifiable sur les serveurs démo. Si bloqué depuis le navigateur, passer par un serveur (Edge Function) ou par un export de fichier.
