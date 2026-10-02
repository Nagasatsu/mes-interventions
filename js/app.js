import { geocode, geocodeAll, travelMatrix, routeLine } from './api.js';
import { optimizeOrder, pathCost } from './solver.js';

const STORE_KEY = 'ma-tournee-v1';
const LOW_SCORE = 0.45; // en dessous, l'adresse trouvée n'est peut-être pas la bonne
const MAX_STOPS = 90; // limite du service de calcul de trajets

// Mots qui ne permettent pas de reconnaître une rue (« Rue de la… »).
const GENERIC_WORDS = new Set(
  ('rue avenue boulevard place chemin allee impasse route quai cours square lotissement residence ' +
    'chaussee voie hameau faubourg cite passage esplanade promenade clos domaine sentier rond point ' +
    'de du des la le les l d et aux au en sur sous saint sainte st ste bis ter').split(' '),
);
const ABBREVIATIONS = { gal: 'general', gen: 'general', mal: 'marechal', pdt: 'president', cdt: 'commandant', dr: 'docteur', pr: 'professeur' };

const words = (text) =>
  text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

// Le service d'adresses renvoie toujours quelque chose, même quand la rue
// n'existe pas (il prend alors une rue voisine au nom proche). On vérifie donc
// que les mots importants du nom de rue trouvé étaient bien dans la demande.
function isDoubtful(query, found) {
  if (found.score < LOW_SCORE || found.type === 'municipality') return true;
  const asked = new Set(words(query).map((w) => ABBREVIATIONS[w] ?? w));
  return words(found.street ?? '').some((w) => !GENERIC_WORDS.has(w) && !/^\d+$/.test(w) && !asked.has(w));
}

const $ = (selector) => document.querySelector(selector);

let state = loadState();
let map = null;
let mapLayer = null;
let mapFittedFor = null;

// ---------- Sauvegarde sur le téléphone ----------

function loadState() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    // stockage indisponible : on repart de zéro
  }
  return {
    settings: { home: null, work: null, startFrom: 'work', onsiteMinutes: 10, ...saved.settings },
    draft: saved.draft || '',
    pending: saved.pending || null, // interventions en cours de vérification
    tour: saved.tour || null, // parcours calculé
    history: saved.history || [], // un résumé par parcours, pour les statistiques
  };
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // stockage plein ou bloqué : l'appli marche quand même, sans mémoire
  }
}

// ---------- Navigation entre les écrans ----------

function show(view) {
  for (const section of document.querySelectorAll('.view')) {
    section.hidden = section.id !== `view-${view}`;
  }
  window.scrollTo(0, 0);
  ({ settings: renderSettings, input: renderInput, review: renderReview, tour: renderTour, stats: renderStats })[view]();
}

function homeView() {
  const { home, work, startFrom } = state.settings;
  if (!home || (startFrom === 'work' && !work)) return 'settings';
  if (state.tour) return 'tour';
  if (state.pending) return 'review';
  return 'input';
}

function startPlace() {
  const { home, work, startFrom } = state.settings;
  return startFrom === 'work' && work ? { ...work, name: 'Travail' } : { ...home, name: 'Domicile' };
}

// ---------- Réglages ----------

function renderSettings() {
  const { home, work, startFrom } = state.settings;
  $('#home').value = home?.query ?? '';
  $('#work').value = work?.query ?? '';
  $('#home-found').textContent = home ? `✓ ${home.label}` : '';
  $('#work-found').textContent = work ? `✓ ${work.label}` : '';
  for (const radio of document.querySelectorAll('input[name=startFrom]')) {
    radio.checked = radio.value === startFrom;
  }
  $('#onsite').value = state.settings.onsiteMinutes;
  $('#close-settings').hidden = homeView() === 'settings';
}

async function saveSettings(event) {
  event.preventDefault();
  const homeQuery = $('#home').value.trim();
  const workQuery = $('#work').value.trim();
  const startFrom = document.querySelector('input[name=startFrom]:checked').value;
  const onsiteMinutes = Math.min(240, Math.max(0, Math.round(Number($('#onsite').value) || 0)));
  if (startFrom === 'work' && !workQuery) {
    return toast('Indique l’adresse du travail, ou choisis de partir du domicile.');
  }
  busy('Recherche des adresses…');
  try {
    const [home, work] = await Promise.all([
      findPlace(homeQuery, state.settings.home),
      workQuery ? findPlace(workQuery, state.settings.work) : null,
    ]);
    if (!home) return toast('Adresse du domicile introuvable. Ajoute le code postal ou la ville.');
    if (workQuery && !work) return toast('Adresse du travail introuvable. Ajoute le code postal ou la ville.');
    state.settings = { home, work, startFrom, onsiteMinutes };
    saveState();
    show(homeView());
    const doubtful = [['domicile', home], ['travail', work]].find(([, place]) => place?.doubtful);
    if (doubtful) toast(`Adresse du ${doubtful[0]} pas sûre : « ${doubtful[1].label} ». Corrige-la dans les réglages si besoin.`);
  } catch (err) {
    toast(err.message);
  } finally {
    idle();
  }
}

// Réutilise le résultat déjà connu si l'adresse n'a pas changé.
async function findPlace(query, previous) {
  if (previous?.query === query) return previous;
  const found = await geocode(query);
  return found && { query, label: found.label, lat: found.lat, lon: found.lon, doubtful: isDoubtful(query, found) };
}

// ---------- Saisie de la liste ----------

// Mots qui signalent une adresse, pour la repérer dans une ligne qui contient
// d'autres infos (nom du client, numéro d'intervention…).
const STREET_WORD = /(^|[^\p{L}])(rue|avenue|av|bd|boulevard|chemin|allée|allee|impasse|place|route|rte|quai|cours|square|lotissement|lieu-dit|résidence|residence|chaussée|voie|hameau|faubourg|zac|za|zi|cité|cite|passage|rond-point|esplanade|promenade|clos|domaine)(?![\p{L}])/iu;
const POSTCODE = /(^|\D)\d{5}(\D|$)/;

// Une intervention par ligne.
function parseList(text) {
  return text
    .split(/\r?\n/)
    .map((raw) => raw.trim())
    .filter((raw) => /[\p{L}\p{N}]/u.test(raw))
    .map((raw) => ({ raw, query: extractAddress(raw) }));
}

function extractAddress(line) {
  // enlève une numérotation du type « 1. », « 2) », « - »
  const cleaned = line.replace(/^(\d{1,3}\s*[.)]|[-•*·])\s+/, '');
  // si la ligne a plusieurs champs (séparés par | ; ou tabulation),
  // garde le champ « rue » et le champ « code postal »
  const fields = cleaned.split(/\s*[|;\t]\s*/).filter(Boolean);
  if (fields.length > 1) {
    const street = fields.find((f) => STREET_WORD.test(f));
    const postcode = fields.find((f) => POSTCODE.test(f));
    const picked = [...new Set([street, postcode].filter(Boolean))];
    if (picked.length) return picked.join(' ');
  }
  return cleaned;
}

function renderInput() {
  const { home } = state.settings;
  const start = startPlace();
  const startText = start.name === 'Travail' ? `au travail (${start.label})` : 'au domicile';
  $('#route-summary').innerHTML = `Départ ${esc(startText)}<br>Retour au domicile (${esc(home.label)})`;
  $('#list').value = state.draft;
  updateCount();
  $('#back-to-tour').hidden = !state.tour;
}

function updateCount() {
  const n = parseList($('#list').value).length;
  $('#list-count').textContent = plural(n, 'intervention');
}

function onListInput() {
  state.draft = $('#list').value;
  saveState();
  updateCount();
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) return toast('Le presse-papiers est vide.');
    $('#list').value = text;
    onListInput();
  } catch {
    toast('Collage refusé : fais un appui long dans la zone de texte puis « Coller ».');
  }
}

async function optimize() {
  const lines = parseList($('#list').value);
  if (!lines.length) return toast('Colle d’abord la liste des interventions.');
  if (lines.length > MAX_STOPS) return toast(`Maximum ${MAX_STOPS} interventions à la fois.`);
  onListInput();
  busy(`Recherche des adresses… 0/${lines.length}`);
  try {
    const results = await geocodeAll(
      lines.map((line) => line.query),
      startPlace(),
      (done, total) => busy(`Recherche des adresses… ${done}/${total}`),
    );
    state.pending = lines.map((line, i) => toStop(i + 1, line, results[i]));
    for (const stop of state.pending) stop.reviewing = needsCheck(stop);
    saveState();
    if (state.pending.some((stop) => stop.reviewing)) show('review');
    else await computeTour();
  } catch (err) {
    toast(err.message);
  } finally {
    idle();
  }
}

function toStop(id, line, found) {
  const stop = { id, raw: line.raw, query: line.query, found: Boolean(found) };
  if (found) {
    Object.assign(stop, { label: found.label, lat: found.lat, lon: found.lon, doubtful: isDoubtful(line.query, found) });
  }
  return stop;
}

const needsCheck = (stop) => !stop.found || stop.doubtful;

// ---------- Vérification des adresses douteuses ----------

function renderReview() {
  const items = state.pending.filter((stop) => stop.reviewing);
  const okCount = state.pending.length - items.length;
  $('#review-intro').textContent =
    `${plural(okCount, 'adresse trouvée', 'adresses trouvées')} sans souci. ` +
    'Pour les autres, corrige le texte puis « Chercher », ou retire-les.';
  $('#review-list').innerHTML = items
    .map((stop) => {
      const status = !stop.found ? 'bad' : needsCheck(stop) ? 'warn' : 'ok';
      const result = !stop.found
        ? 'Adresse introuvable'
        : `${status === 'warn' ? 'Trouvé, mais pas sûr' : 'Trouvé'} : <b>${esc(stop.label)}</b>`;
      return `
        <li class="card ${status}" data-id="${stop.id}">
          <p class="raw">${esc(stop.raw)}</p>
          <p class="result">${result}</p>
          <input type="text" value="${esc(stop.query)}" aria-label="Adresse à chercher" enterkeyhint="search">
          <div class="row">
            <button class="btn" data-action="search" type="button">Chercher</button>
            <button class="btn danger" data-action="remove" type="button">Retirer</button>
          </div>
        </li>`;
    })
    .join('');
  const blocked = items.some((stop) => !stop.found);
  const button = $('#review-continue');
  button.disabled = blocked || state.pending.length === 0;
  button.textContent = blocked ? 'Corrige ou retire les adresses introuvables' : 'Calculer le meilleur ordre';
}

async function onReviewClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const item = button.closest('[data-id]');
  const index = state.pending.findIndex((stop) => stop.id === Number(item.dataset.id));
  const stop = state.pending[index];
  if (button.dataset.action === 'remove') {
    state.pending.splice(index, 1);
  } else {
    const query = item.querySelector('input').value.trim();
    busy('Recherche…');
    try {
      const found = await geocode(query, startPlace());
      state.pending[index] = { ...toStop(stop.id, { raw: stop.raw, query }, found), reviewing: true };
      if (!found) toast('Toujours introuvable. Essaie avec le code postal et la ville.');
    } catch (err) {
      toast(err.message);
    } finally {
      idle();
    }
  }
  saveState();
  renderReview();
}

async function continueReview() {
  busy('Calcul du parcours…');
  try {
    await computeTour();
  } catch (err) {
    toast(err.message);
  } finally {
    idle();
  }
}

// ---------- Calcul de la tournée ----------

async function computeTour() {
  const stops = state.pending;
  const n = stops.length;
  const start = startPlace();
  const end = { ...state.settings.home, name: 'Domicile' };
  // dans la matrice : 0 = départ, 1..n = interventions, n+1 = retour
  busy('Calcul des temps de trajet…');
  const matrix = await travelMatrix([start, ...stops, end]);

  busy('Recherche du meilleur ordre…');
  await new Promise((resolve) => setTimeout(resolve, 30)); // laisse le message s'afficher
  const listOrder = stops.map((_, i) => i + 1);
  const bestOrder = optimizeOrder(matrix.durations, 0, n + 1, listOrder);
  // gain par rapport à l'ordre de la liste, mesuré avec la même matrice
  const pathOf = (order) => [0, ...order, n + 1];
  const saved = {
    duration: pathCost(matrix.durations, pathOf(listOrder)) - pathCost(matrix.durations, pathOf(bestOrder)),
    distance: pathCost(matrix.distances, pathOf(listOrder)) - pathCost(matrix.distances, pathOf(bestOrder)),
  };

  busy('Tracé de l’itinéraire…');
  const ordered = bestOrder.map((i) => stops[i - 1]);
  const route = matrix.source === 'osrm' ? await routeLine([start, ...ordered, end]) : null;
  const path = pathOf(bestOrder);
  const legs =
    route?.legs ??
    path.slice(1).map((to, k) => ({
      duration: matrix.durations[path[k]][to],
      distance: matrix.distances[path[k]][to],
    }));

  const today = dayKey(new Date());
  const createdAt = Date.now();
  // Un parcours recalculé dans la journée avant d'avoir commencé remplace le
  // précédent dans les statistiques, sinon la journée compterait deux fois.
  const previous = state.tour;
  if (previous?.day === today && previous.stops.every((stop) => statusOf(stop) === 'todo')) {
    state.history = state.history.filter((entry) => entry.id !== previous.createdAt);
  }
  state.history.push({
    id: createdAt,
    day: today,
    stops: n,
    absent: 0,
    savedTime: Math.max(0, saved.duration),
    savedDistance: Math.max(0, saved.distance),
  });

  state.tour = {
    createdAt,
    day: today,
    start,
    end,
    stops: ordered.map(({ reviewing, ...stop }, k) => ({ ...stop, leg: legs[k], status: 'todo' })),
    back: legs[n],
    total: {
      duration: legs.reduce((sum, leg) => sum + leg.duration, 0),
      distance: legs.reduce((sum, leg) => sum + leg.distance, 0),
    },
    saved,
    line: route?.line ?? null,
    estimated: matrix.source !== 'osrm',
  };
  state.pending = null;
  saveState();
  show('tour');
}

// ---------- Affichage de la tournée ----------

function renderTour() {
  const tour = state.tour;
  const nextId = tour.stops.find((stop) => statusOf(stop) === 'todo')?.id;
  const { saved } = tour;

  $('#tour-summary').innerHTML = `
    <div class="stats">
      <div><b>${tour.stops.length}</b><span>interventions</span></div>
      <div><b>${fmtDuration(tour.total.duration)}</b><span>de route</span></div>
      <div><b>${fmtDistance(tour.total.distance)}</b><span>au total</span></div>
    </div>
    ${saved.duration >= 60 ? `<p class="gain"><b>${fmtDuration(saved.duration)}</b><span>de route en moins par rapport à l'ordre de la liste${saved.distance >= 1000 ? ` (${fmtDistance(saved.distance)} de moins)` : ''}</span></p>` : ''}
    ${tour.estimated ? '<p class="hint warn-text">Service d’itinéraire injoignable : temps estimés à vol d’oiseau.</p>' : ''}`;
  renderProgress();

  const stopItem = (stop, k) => {
    const status = statusOf(stop);
    const isNext = stop.id === nextId;
    const actions =
      status === 'todo'
        ? `<a class="btn" href="${wazeUrl(stop)}" target="_blank" rel="noopener">Waze</a>
           <a class="btn" href="${mapsUrl(stop)}" target="_blank" rel="noopener">Maps</a>
           <button class="btn" data-action="absent" type="button">Absent</button>
           <button class="btn success" data-action="done" type="button">Fait ✓</button>`
        : '<button class="btn" data-action="todo" type="button">Annuler</button>';
    return `
    <li class="stop ${status}${isNext ? ' next' : ''}" data-id="${stop.id}">
      ${legLine(stop.leg)}
      <div class="stop-card">
        <div class="stop-head">
          <span class="num">${k + 1}</span>
          <div class="stop-text">
            ${isNext ? '<span class="badge">Prochaine</span>' : ''}
            ${status === 'absent' ? '<span class="badge absent">Client absent</span>' : ''}
            ${stop.added ? '<span class="badge added">Ajoutée</span>' : ''}
            <p class="title">${esc(stop.raw)}</p>
            ${sameText(stop.raw, stop.label) ? '' : `<p class="sub">${esc(stop.label)}</p>`}
          </div>
        </div>
        <div class="actions">${actions}</div>
      </div>
    </li>`;
  };
  const endpoint = (letter, title, place) => `
    <div class="stop-card endpoint">
      <div class="stop-head">
        <span class="num">${letter}</span>
        <div class="stop-text"><p class="title">${title}</p><p class="sub">${esc(place.label)}</p></div>
      </div>
    </div>`;

  $('#recalc').hidden = !nextId;
  $('#tour-list').innerHTML = `
    <li class="stop">${endpoint('D', `Départ · ${esc(tour.start.name)}`, tour.start)}</li>
    ${tour.stops.map(stopItem).join('')}
    <li class="stop">${legLine(tour.back)}${endpoint('R', 'Retour · Domicile', tour.end)}</li>`;

  drawMap(tour, nextId);
}

// Statut d'une intervention : 'todo' (à faire), 'done' (faite) ou 'absent' (client absent).
// Les parcours enregistrés avant l'ajout de « Absent » n'avaient qu'un champ `done`.
const statusOf = (stop) => stop.status ?? (stop.done ? 'done' : 'todo');

function onTourClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = Number(button.closest('[data-id]').dataset.id);
  const stop = state.tour.stops.find((s) => s.id === id);
  delete stop.done;
  stop.status = button.dataset.action;
  stop.changedAt = stop.status === 'todo' ? undefined : Date.now();
  const entry = state.history.find((e) => e.id === state.tour.createdAt);
  if (entry) entry.absent = state.tour.stops.filter((s) => statusOf(s) === 'absent').length;
  saveState();
  renderTour();
  if (stop.status !== 'todo') $('.stop.next')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- Avancement et heure de retour ----------

// Heure de retour = maintenant + route qui reste + temps sur place pour chaque
// intervention qui reste, arrondi à 5 minutes (c'est une estimation).
function returnTime(tour, todo) {
  const driving = todo.reduce((total, stop) => total + stop.leg.duration, 0) + tour.back.duration;
  const onsite = todo.length * state.settings.onsiteMinutes * 60;
  const step = 5 * 60 * 1000;
  return new Date(Math.round((Date.now() + (driving + onsite) * 1000) / step) * step);
}

const fmtClock = (date) => `${date.getHours()} h ${String(date.getMinutes()).padStart(2, '0')}`;

function renderProgress() {
  const tour = state.tour;
  const todo = tour.stops.filter((stop) => statusOf(stop) === 'todo');
  const absent = tour.stops.filter((stop) => statusOf(stop) === 'absent').length;
  const started = todo.length < tour.stops.length || tour.recalculatedAt;
  const driving = todo.reduce((total, stop) => total + stop.leg.duration, 0) + tour.back.duration;
  const details = todo.length
    ? `Reste ${plural(todo.length, 'intervention')} · ${fmtDuration(driving)} de route`
    : 'Toutes les interventions sont terminées';
  $('#tour-progress').innerHTML = `
    <p class="eta">Retour à la maison vers <b>${fmtClock(returnTime(tour, todo))}</b>${started ? '' : ' <span>en partant maintenant</span>'}</p>
    <p class="hint">${details}${absent ? ` · ${plural(absent, 'client absent', 'clients absents')}` : ''}</p>`;
}

// ---------- Recalcul en cours de journée ----------

// Position GPS du téléphone, ou null si refusée ou introuvable.
function currentPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, name: 'Ta position' }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

// Sans GPS : on repart de la dernière intervention faite, sinon du départ.
function lastDonePlace(tour) {
  const last = tour.stops
    .filter((stop) => statusOf(stop) === 'done' && stop.changedAt)
    .sort((a, b) => b.changedAt - a.changedAt)[0];
  return last ? { lat: last.lat, lon: last.lon, name: 'Dernière intervention faite' } : tour.from ?? tour.start;
}

// Retrie les interventions qui restent (plus d'éventuelles nouvelles) à partir
// de l'endroit où l'on est. Les interventions terminées gardent leur place.
async function recalculate(added = []) {
  const tour = state.tour;
  busy('Recherche de ta position…');
  try {
    const finished = tour.stops.filter((stop) => statusOf(stop) !== 'todo');
    const todo = [...tour.stops.filter((stop) => statusOf(stop) === 'todo'), ...added];
    const gps = await currentPosition();
    const from = gps ?? lastDonePlace(tour);
    const n = todo.length;

    busy('Calcul des temps de trajet…');
    const matrix = await travelMatrix([from, ...todo, tour.end]);
    busy('Recherche du meilleur ordre…');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const order = optimizeOrder(matrix.durations, 0, n + 1, todo.map((_, i) => i + 1));
    const ordered = order.map((i) => todo[i - 1]);

    busy('Tracé de l’itinéraire…');
    const route = matrix.source === 'osrm' ? await routeLine([from, ...ordered, tour.end]) : null;
    const path = [0, ...order, n + 1];
    const legs =
      route?.legs ??
      path.slice(1).map((to, k) => ({
        duration: matrix.durations[path[k]][to],
        distance: matrix.distances[path[k]][to],
      }));
    legs[0] = { ...legs[0], from: gps ? 'position' : 'last' };

    tour.stops = [...finished, ...ordered.map((stop, k) => ({ ...stop, leg: legs[k] }))];
    tour.back = legs[n];
    const allLegs = [...tour.stops.map((stop) => stop.leg), tour.back];
    tour.total = {
      duration: allLegs.reduce((sum, leg) => sum + leg.duration, 0),
      distance: allLegs.reduce((sum, leg) => sum + leg.distance, 0),
    };
    tour.from = from;
    tour.line = route?.line ?? null;
    tour.estimated = matrix.source !== 'osrm';
    tour.recalculatedAt = Date.now();
    const entry = state.history.find((e) => e.id === tour.createdAt);
    if (entry) entry.stops = tour.stops.length;
    saveState();
    renderTour();
    $('.stop.next')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (!gps) toast('Position GPS introuvable : recalcul depuis la dernière intervention faite.');
  } catch (err) {
    toast(err.message);
  } finally {
    idle();
  }
}

async function addStop(event) {
  event.preventDefault();
  const raw = $('#add-address').value.trim();
  if (!raw) return toast('Indique l’adresse de la nouvelle intervention.');
  const query = parseList(raw)[0]?.query ?? raw;
  busy('Recherche de l’adresse…');
  let found;
  try {
    found = await geocode(query, startPlace());
  } catch (err) {
    return toast(err.message);
  } finally {
    idle();
  }
  if (!found) return toast('Adresse introuvable. Ajoute le code postal ou la ville.');
  if (isDoubtful(query, found) && !confirm(`Adresse trouvée : « ${found.label} ». C'est bien ça ?`)) return;
  const id = Math.max(0, ...state.tour.stops.map((stop) => stop.id)) + 1;
  const stop = { id, raw, query, found: true, label: found.label, lat: found.lat, lon: found.lon, status: 'todo', added: true };
  $('#add-form').hidden = true;
  $('#add-address').value = '';
  await recalculate([stop]);
}

function drawMap(tour, nextId) {
  const element = $('#map');
  if (!window.L) {
    element.hidden = true; // Leaflet pas chargé (pas de réseau) : on se passe de carte
    return;
  }
  if (!map) {
    map = L.map(element);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap',
    }).addTo(map);
    mapLayer = L.layerGroup().addTo(map);
  }
  mapLayer.clearLayers();
  const pin = (text, kind) =>
    L.divIcon({ className: `pin ${kind}`, html: `<span>${text}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
  const straight = tour.from
    ? [tour.from, ...tour.stops.filter((stop) => statusOf(stop) === 'todo'), tour.end]
    : [tour.start, ...tour.stops, tour.end];
  const line = tour.line ?? straight.map((p) => [p.lat, p.lon]);
  L.polyline(line, { color: '#2563eb', weight: 4, opacity: 0.75 }).addTo(mapLayer);
  L.marker([tour.end.lat, tour.end.lon], { icon: pin('R', 'endpoint') }).bindPopup('Retour · Domicile').addTo(mapLayer);
  L.marker([tour.start.lat, tour.start.lon], { icon: pin('D', 'endpoint') })
    .bindPopup(`Départ · ${esc(tour.start.name)}`)
    .addTo(mapLayer);
  if (tour.from) {
    L.marker([tour.from.lat, tour.from.lon], { icon: pin('●', 'here') }).bindPopup(esc(tour.from.name)).addTo(mapLayer);
  }
  tour.stops.forEach((stop, k) => {
    const kind = statusOf(stop) !== 'todo' ? 'done' : stop.id === nextId ? 'next' : '';
    L.marker([stop.lat, stop.lon], { icon: pin(k + 1, kind), zIndexOffset: stop.id === nextId ? 1000 : 0 })
      .bindPopup(`<b>${k + 1}.</b> ${esc(stop.raw)}`)
      .addTo(mapLayer);
  });
  map.invalidateSize();
  const fitKey = `${tour.createdAt}/${tour.recalculatedAt ?? 0}`;
  if (mapFittedFor !== fitKey) {
    map.fitBounds(L.latLngBounds(line), { padding: [36, 36] });
    mapFittedFor = fitKey;
  }
}

// ---------- Petits utilitaires ----------

const wazeUrl = (p) => `https://waze.com/ul?ll=${p.lat},${p.lon}&navigate=yes`;
const mapsUrl = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}&travelmode=driving`;

const LEG_ORIGIN = { position: ' depuis ta position', last: ' depuis la dernière intervention faite' };
const legLine = (leg) =>
  `<div class="leg">${fmtDuration(leg.duration)} · ${fmtDistance(leg.distance)}${LEG_ORIGIN[leg.from] ?? ''}</div>`;

function fmtDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

function fmtDistance(meters) {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)} km`;
}

function plural(n, singular, pluralForm = `${singular}s`) {
  return `${n} ${n > 1 ? pluralForm : singular}`;
}

// Vrai si la ligne d'origine dit déjà la même chose que l'adresse trouvée.
function sameText(a, b) {
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
  return norm(a) === norm(b);
}

function esc(text) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text).replace(/[&<>"']/g, (c) => entities[c]);
}

function busy(text) {
  $('#busy').hidden = false;
  $('#busy-text').textContent = text;
}

function idle() {
  $('#busy').hidden = true;
}

let toastTimer;
function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, 4500);
}

// ---------- Statistiques ----------

const statsView = { period: 'week', offset: 0 }; // offset 0 = période en cours, -1 = précédente…
let statsDays = []; // jours affichés dans le graphique, pour les bulles d'info

function dayKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const shortDate = (date) => date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

// Jours de la période : semaine du lundi au dimanche, ou mois entier.
function periodDays(period, offset) {
  const now = new Date();
  let first;
  let count;
  let label;
  if (period === 'week') {
    const mondayShift = (now.getDay() + 6) % 7;
    first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayShift + offset * 7);
    count = 7;
    const last = new Date(first.getFullYear(), first.getMonth(), first.getDate() + 6);
    const name = offset === 0 ? 'Cette semaine' : offset === -1 ? 'Semaine dernière' : 'Semaine';
    label = `${name} · ${shortDate(first)} – ${shortDate(last)}`;
  } else {
    first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const month = first.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    label = offset === 0 ? `Ce mois-ci · ${month}` : month[0].toUpperCase() + month.slice(1);
  }
  const days = Array.from({ length: count }, (_, i) => {
    const date = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
    const tick = period === 'week' ? 'LMMJVSD'[i] : i === 0 || (i + 1) % 5 === 0 ? String(i + 1) : '';
    const long = date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
    return { key: dayKey(date), tick, long };
  });
  return { days, label };
}

function sumEntries(entries) {
  const total = { stops: 0, absent: 0, savedTime: 0, savedDistance: 0 };
  for (const entry of entries) {
    for (const field of Object.keys(total)) total[field] += entry[field] ?? 0;
  }
  total.days = new Set(entries.map((entry) => entry.day)).size;
  return total;
}

function renderStats() {
  const { days, label } = periodDays(statsView.period, statsView.offset);
  for (const button of document.querySelectorAll('[data-period]')) {
    button.setAttribute('aria-pressed', String(button.dataset.period === statsView.period));
  }
  $('#stats-label').textContent = label;
  $('#stats-next').disabled = statsView.offset >= 0;
  $('#reset-stats').hidden = !state.history.length;

  const keys = new Set(days.map((day) => day.key));
  const entries = state.history.filter((entry) => keys.has(entry.day));
  const everything = sumEntries(state.history);
  const allTime = state.history.length
    ? `<p class="hint">Depuis le début : <b>${fmtDuration(everything.savedTime)}</b> de route en moins, sur ${plural(everything.days, 'journée')}.</p>`
    : '';

  if (!entries.length) {
    $('#stats-content').innerHTML = `
      <p class="empty">${state.history.length ? 'Aucun parcours calculé sur cette période.' : 'Les statistiques se rempliront au fil des jours : chaque parcours calculé compte pour sa journée.'}</p>
      ${allTime}`;
    return;
  }

  const total = sumEntries(entries);
  statsDays = days.map((day) => {
    const ofDay = entries.filter((entry) => entry.day === day.key);
    return { ...day, ...sumEntries(ofDay), has: ofDay.length > 0 };
  });

  $('#stats-content').innerHTML = `
    <div class="hero">
      <span class="hero-value">${fmtDuration(total.savedTime)}</span>
      <span class="hero-label">de route en moins par rapport à l'ordre des listes</span>
    </div>
    <div class="stats">
      <div><b>${total.days}</b><span>${total.days > 1 ? 'journées' : 'journée'}</span></div>
      <div><b>${total.stops}</b><span>interventions</span></div>
      <div><b>${fmtDistance(total.savedDistance)}</b><span>en moins</span></div>
    </div>
    ${total.absent ? `<p class="hint">Dont ${plural(total.absent, 'client absent', 'clients absents')}.</p>` : ''}
    ${chartHtml(statsDays)}
    ${tableHtml(statsDays)}
    ${allTime}`;
}

// Graphique en colonnes : minutes gagnées chaque jour de la période.
function chartHtml(days) {
  const minutes = days.map((day) => day.savedTime / 60);
  const max = Math.max(...minutes);
  const step = [5, 10, 15, 30, 60, 120, 240].find((s) => max / s <= 4) ?? 480;
  const top = Math.max(step, Math.ceil(max / step) * step);
  const peak = minutes.indexOf(max);
  const tickLabel = (m) => (m >= 60 && m % 60 === 0 ? `${m / 60} h` : fmtDuration(m * 60));
  const gridlines = [];
  for (let m = 0; m <= top; m += step) {
    gridlines.push(`<div class="gridline" style="top:${(1 - m / top) * 100}%"><span>${tickLabel(m)}</span></div>`);
  }
  const columns = days.map((day, i) => {
    const height = (minutes[i] / top) * 100;
    const description = day.has ? `${fmtDuration(day.savedTime)} gagnées, ${plural(day.stops, 'intervention')}` : 'pas de parcours';
    // l'étiquette du plus haut reste dans le cadre même au bord du graphique
    const align = i < days.length * 0.15 ? 'start' : i >= days.length * 0.85 ? 'end' : 'center';
    return `
      <button class="col" type="button" data-i="${i}" data-h="${height}" aria-label="${esc(`${day.long} : ${description}`)}">
        ${minutes[i] > 0 ? `<span class="bar" style="height:${height}%"></span>` : ''}
        ${i === peak && max > 0 ? `<span class="cap ${align}" style="bottom:${height}%">${fmtDuration(day.savedTime)}</span>` : ''}
      </button>`;
  });
  return `
    <figure class="chart">
      <figcaption>Temps gagné par jour</figcaption>
      <div class="plot">
        ${gridlines.join('')}
        <div class="cols">${columns.join('')}</div>
        <div class="chart-tip" hidden><b></b><span></span></div>
      </div>
      <div class="x-axis" aria-hidden="true">${days.map((day) => `<span>${day.tick}</span>`).join('')}</div>
    </figure>`;
}

// Les mêmes chiffres en tableau, lisibles sans toucher le graphique.
function tableHtml(days) {
  const rows = days
    .filter((day) => day.has)
    .map(
      (day) =>
        `<tr><td>${esc(day.long)}</td><td>${day.stops}</td><td>${day.absent}</td><td>${fmtDuration(day.savedTime)}</td><td>${fmtDistance(day.savedDistance)}</td></tr>`,
    )
    .join('');
  return `
    <details class="table-view">
      <summary>Détail par jour</summary>
      <table>
        <thead><tr><th>Jour</th><th>Interv.</th><th>Absents</th><th>Gagné</th><th>En moins</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
}

// Bulle d'info au survol ou au toucher d'une colonne.
function showChartTip(event) {
  const tip = $('#stats-content .chart-tip');
  const column = event.target.closest?.('.col');
  if (!tip) return;
  if (!column) {
    tip.hidden = true;
    return;
  }
  const day = statsDays[Number(column.dataset.i)];
  tip.querySelector('b').textContent = day.has ? `${fmtDuration(day.savedTime)} gagnées` : 'Pas de parcours';
  tip.querySelector('span').textContent = day.has ? `${day.long} · ${plural(day.stops, 'intervention')}` : day.long;
  tip.hidden = false;
  const plot = column.closest('.plot');
  const half = tip.offsetWidth / 2;
  const x = column.offsetLeft + column.offsetWidth / 2;
  tip.style.left = `${Math.min(Math.max(x, half - 44), plot.clientWidth - half)}px`;
  tip.style.top = `${plot.clientHeight * (1 - Number(column.dataset.h) / 100) - 8}px`;
}

function hideChartTip() {
  const tip = $('#stats-content .chart-tip');
  if (tip) tip.hidden = true;
}

// ---------- Mode clair / sombre ----------

const THEME_KEY = 'ma-tournee-theme';
const ICON = (paths) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const MOON_ICON = ICON('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>');
const SUN_ICON = ICON(
  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
);

function renderThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const button = $('#toggle-theme');
  button.innerHTML = dark ? SUN_ICON : MOON_ICON;
  button.setAttribute('aria-label', dark ? 'Passer en mode clair' : 'Passer en mode sombre');
}

function toggleTheme() {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // pas de stockage : le choix ne durera que jusqu'à la fermeture
  }
  renderThemeButton();
}

// Tant qu'aucun choix n'a été fait avec le bouton, on suit le téléphone.
function followPhoneTheme(event) {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    // stockage indisponible
  }
  if (saved) return;
  document.documentElement.dataset.theme = event.matches ? 'dark' : 'light';
  renderThemeButton();
}

// Texte partagé depuis une autre appli (SMS, mail…) via le menu « Partager »
// d'Android, une fois l'appli installée sur l'écran d'accueil.
function receiveSharedText() {
  const params = new URLSearchParams(location.search);
  const shared = params.get('text') || params.get('url');
  if (!shared) return false;
  history.replaceState(null, '', location.pathname);
  state.draft = shared;
  saveState();
  return true;
}

// ---------- Démarrage ----------

function init() {
  renderThemeButton();
  $('#toggle-theme').addEventListener('click', toggleTheme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', followPhoneTheme);
  $('#open-settings').addEventListener('click', () => show('settings'));

  $('#open-stats').addEventListener('click', () => {
    statsView.offset = 0;
    show('stats');
  });
  $('#close-stats').addEventListener('click', () => show(homeView()));
  $('#reset-stats').addEventListener('click', () => {
    if (!confirm('Effacer toutes les statistiques ? Elles ne pourront pas être récupérées.')) return;
    state.history = [];
    saveState();
    renderStats();
  });
  for (const button of document.querySelectorAll('[data-period]')) {
    button.addEventListener('click', () => {
      statsView.period = button.dataset.period;
      statsView.offset = 0;
      renderStats();
    });
  }
  $('#stats-prev').addEventListener('click', () => {
    statsView.offset--;
    renderStats();
  });
  $('#stats-next').addEventListener('click', () => {
    statsView.offset = Math.min(0, statsView.offset + 1);
    renderStats();
  });
  $('#stats-content').addEventListener('pointerover', showChartTip);
  $('#stats-content').addEventListener('focusin', showChartTip);
  $('#stats-content').addEventListener('pointerleave', hideChartTip);
  $('#stats-content').addEventListener('focusout', hideChartTip);
  $('#close-settings').addEventListener('click', () => show(homeView()));
  $('#settings-form').addEventListener('submit', saveSettings);

  $('#list').addEventListener('input', onListInput);
  $('#paste').addEventListener('click', pasteFromClipboard);
  $('#clear-list').addEventListener('click', () => {
    $('#list').value = '';
    onListInput();
    $('#list').focus();
  });
  $('#optimize').addEventListener('click', optimize);
  $('#back-to-tour').addEventListener('click', () => show('tour'));

  $('#review-list').addEventListener('click', onReviewClick);
  $('#review-list').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('input')) {
      event.target.closest('[data-id]').querySelector('[data-action=search]').click();
    }
  });
  $('#review-continue').addEventListener('click', continueReview);
  $('#review-cancel').addEventListener('click', () => {
    state.pending = null;
    saveState();
    show('input');
  });

  $('#tour-list').addEventListener('click', onTourClick);
  $('#recalc').addEventListener('click', () => recalculate());
  $('#show-add').addEventListener('click', () => {
    $('#add-form').hidden = false;
    $('#add-address').focus();
  });
  $('#cancel-add').addEventListener('click', () => {
    $('#add-form').hidden = true;
  });
  $('#add-form').addEventListener('submit', addStop);
  // l'heure de retour avance avec l'horloge, et se met à jour au retour de Waze / Maps
  const refreshProgress = () => {
    if (state.tour && !$('#view-tour').hidden && document.visibilityState === 'visible') renderProgress();
  };
  setInterval(refreshProgress, 60000);
  document.addEventListener('visibilitychange', refreshProgress);
  $('#new-tour').addEventListener('click', () => show('input'));

  const shared = receiveSharedText();
  const start = homeView();
  show(shared && start !== 'settings' ? 'input' : start);

  if ('serviceWorker' in navigator) {
    // Quand une nouvelle version de l'appli prend le relais, on recharge une
    // fois pour l'afficher tout de suite. Rien n'est perdu : tout est déjà
    // sauvegardé sur le téléphone.
    const isUpdate = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!isUpdate || reloading) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker', err));
  }
}

init();
