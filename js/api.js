// Accès aux services en ligne gratuits :
// - Géoplateforme de l'IGN (service public français) : adresse -> coordonnées GPS
// - OSRM (basé sur OpenStreetMap) : temps de trajet en voiture entre les points
// Si OSRM ne répond pas, on se rabat sur une estimation à vol d'oiseau.

import { cityLast, compare, words } from './address.js';

const GEOCODE_URL = 'https://data.geopf.fr/geocodage/search';
const OSRM_URL = 'https://router.project-osrm.org';
const GEOCODE_PARALLEL = 5;
const CANDIDATES = 8; // on regarde plusieurs résultats, pas seulement le premier

// Adresse → coordonnées. Renvoie null si rien de plausible n'est trouvé.
//
// Le service d'adresses classe ses résultats par ressemblance du texte : pour
// « 12 rue Jean Jaurès Denain » il met en premier « 12 Rue Jean Jaurès à
// Fenain » (nom proche) avant « 12 Avenue Jean Jaurès à Denain ». On choisit
// donc nous-mêmes parmi plusieurs résultats, en exigeant la bonne ville, et
// on ne propose jamais une autre ville que celle qui est écrite.
export async function geocode(query, near) {
  const q = cityLast(query.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim()).slice(0, 200);
  if (q.length < 3) return null;
  const best = pickBest(q, await search({ q, limit: CANDIDATES }, near));
  if (!best || compare(q, best).city) return best ?? null;

  // Le meilleur résultat n'est pas dans une ville écrite dans la demande.
  // Si la demande nomme une ville (ou un code postal), on cherche uniquement là.
  const postcode = q.match(/(?<!\d)\d{5}(?!\d)/)?.[0];
  const citycode = postcode ? null : await askedCity(q, near);
  if (!postcode && !citycode) return best; // aucune ville écrite : le résultat sera signalé « pas sûr »
  const inCity = await search({ q, limit: CANDIDATES, ...(postcode ? { postcode } : { citycode }) });
  return pickBest(q, inCity) ?? null;
}

async function search(params, near) {
  const url = new URLSearchParams(params);
  if (near) {
    // privilégie les adresses proches (utile quand la ville n'est pas précisée)
    url.set('lat', near.lat.toFixed(5));
    url.set('lon', near.lon.toFixed(5));
  }
  const data = await fetchJson(`${GEOCODE_URL}?${url}`);
  return (data.features ?? []).map((feature) => {
    const [lon, lat] = feature.geometry.coordinates;
    const { label, score, type, street, name, city, postcode, citycode } = feature.properties;
    return { label, lat, lon, score, type, street: street || name, city, postcode, citycode };
  });
}

// Le meilleur résultat : d'abord la bonne rue, puis la bonne ville, puis le
// bon type de voie ; à égalité, la note du service.
function pickBest(query, candidates) {
  const rank = (candidate) => {
    const same = compare(query, candidate);
    return (same.street ? 4 : 0) + (same.city ? 2 : 0) + (same.type ? 1 : 0);
  };
  return [...candidates].sort((a, b) => rank(b) - rank(a) || b.score - a.score)[0];
}

// Ville écrite à la fin de la demande (« … NOYELLES SOUS LENS ») : on essaie
// les derniers mots, du groupe le plus long au plus court, et on garde le plus
// long qui est exactement le nom d'une commune. Renvoie son code, ou null.
async function askedCity(query, near) {
  const tokens = words(query);
  const tails = [];
  for (let size = Math.min(5, tokens.length - 1); size >= 1; size--) {
    const tail = tokens.slice(-size);
    if (!tail.some((word) => /^\d+$/.test(word))) tails.push(tail);
  }
  const found = await Promise.all(
    tails.map(async (tail) => {
      const communes = await search({ q: tail.join(' '), type: 'municipality', limit: 3 }, near).catch(() => []);
      return communes.find((commune) => {
        const name = words(commune.city ?? commune.label ?? '');
        return name.length === tail.length && name.every((word) => tail.includes(word));
      });
    }),
  );
  return found.find(Boolean)?.citycode ?? null;
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
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    } catch {
      // pas de réseau, ou service qui ne répond pas dans les 15 secondes
      throw new Error('Le service en ligne ne répond pas. Vérifie la connexion internet et réessaie.');
    }
    if (res.ok) return res.json();
    if (attempt >= attempts || (res.status !== 429 && res.status < 500)) {
      throw new Error(`Le service en ligne a renvoyé une erreur (${res.status}). Réessaie dans un moment.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
}
