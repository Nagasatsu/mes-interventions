// Accès aux services en ligne gratuits :
// - Géoplateforme de l'IGN (service public français) : adresse -> coordonnées GPS
// - OSRM (basé sur OpenStreetMap) : temps de trajet en voiture entre les points
// Si OSRM ne répond pas, on se rabat sur une estimation à vol d'oiseau.

const GEOCODE_URL = 'https://data.geopf.fr/geocodage/search';
const OSRM_URL = 'https://router.project-osrm.org';
const GEOCODE_PARALLEL = 5;

export async function geocode(query, near) {
  const q = query.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (q.length < 3) return null;
  const params = new URLSearchParams({ q, limit: '1' });
  if (near) {
    // privilégie les adresses proches (utile quand la ville n'est pas précisée)
    params.set('lat', near.lat.toFixed(5));
    params.set('lon', near.lon.toFixed(5));
  }
  const data = await fetchJson(`${GEOCODE_URL}?${params}`);
  const feature = data.features?.[0];
  if (!feature) return null;
  const [lon, lat] = feature.geometry.coordinates;
  const { label, score, type, street, name } = feature.properties;
  return { label, lat, lon, score, type, street: street || name };
}

// Géocode une liste d'adresses, quelques-unes à la fois.
// Renvoie un tableau de résultats (null = introuvable).
export async function geocodeAll(queries, near, onProgress) {
  const results = new Array(queries.length).fill(null);
  let next = 0;
  let done = 0;
  let errors = 0;
  async function worker() {
    while (next < queries.length) {
      const i = next++;
      try {
        results[i] = await geocode(queries[i], near);
      } catch {
        errors++;
      }
      onProgress?.(++done, queries.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(GEOCODE_PARALLEL, queries.length) }, worker));
  if (errors === queries.length) {
    throw new Error("Impossible de joindre le service d'adresses. Vérifie la connexion internet.");
  }
  return results;
}

// Matrice des temps (secondes) et distances (mètres) entre tous les points.
export async function travelMatrix(points) {
  const estimate = estimateMatrix(points);
  try {
    const data = await fetchJson(`${OSRM_URL}/table/v1/driving/${coordList(points)}?annotations=duration,distance`);
    if (data.code !== 'Ok') throw new Error(data.code);
    // un trajet introuvable (null) est remplacé par l'estimation
    const fill = (rows, fallback) => rows.map((row, i) => row.map((v, j) => v ?? fallback[i][j]));
    return {
      durations: fill(data.durations, estimate.durations),
      distances: fill(data.distances, estimate.distances),
      source: 'osrm',
    };
  } catch (err) {
    console.warn('OSRM indisponible, estimation à vol d’oiseau', err);
    return { ...estimate, source: 'estimate' };
  }
}

// Tracé de l'itinéraire complet, dans l'ordre donné, pour la carte.
export async function routeLine(points) {
  try {
    const data = await fetchJson(`${OSRM_URL}/route/v1/driving/${coordList(points)}?overview=full&geometries=geojson`);
    if (data.code !== 'Ok') return null;
    const route = data.routes[0];
    return {
      line: route.geometry.coordinates.map(([lon, lat]) => [+lat.toFixed(5), +lon.toFixed(5)]),
      legs: route.legs.map((leg) => ({ duration: leg.duration, distance: leg.distance })),
    };
  } catch {
    return null;
  }
}

// Estimation sans réseau : distance à vol d'oiseau × 1,3 (les routes ne sont
// pas droites), parcourue à 45 km/h de moyenne.
const ROAD_FACTOR = 1.3;
const AVG_SPEED_MS = 45 / 3.6;

function estimateMatrix(points) {
  const distances = points.map((a) => points.map((b) => haversine(a, b) * ROAD_FACTOR));
  const durations = distances.map((row) => row.map((d) => d / AVG_SPEED_MS));
  return { durations, distances };
}

function haversine(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function coordList(points) {
  return points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
}

// fetch + JSON, avec délai maximum et nouvel essai si le service est surchargé.
async function fetchJson(url, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (res.ok) return res.json();
    if (attempt >= attempts || (res.status !== 429 && res.status < 500)) {
      throw new Error(`HTTP ${res.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
}
