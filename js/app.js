import { geocode, geocodeAll, travelMatrix, routeLine } from './api.js';
import { optimizeOrder, pathCost } from './solver.js';
import { STREET_WORD, PHONE, cleanStreet, cityLast, fixZeros, formatPhone, compare, streetType } from './address.js';
import { readSheetPhoto } from './sheet.js';
import { savePage, listPages, countPages, clearPages, removeOldPages } from './pages.js';

const STORE_KEY = 'ma-tournee-v1';
const LOW_SCORE = 0.45; // en dessous, l'adresse trouvée n'est peut-être pas la bonne
const MAX_STOPS = 90; // limite du service de calcul de trajets

// Pourquoi l'adresse trouvée est douteuse (texte affiché à l'utilisateur), ou
// '' si tout correspond : ville, rue et type de voie demandés, et bonne note.
function doubtReason(query, found) {
  if (found.type === 'municipality') return 'seule la ville a été trouvée, pas la rue';
  const same = compare(query, found);
  if (!same.city) return 'la ville trouvée n’est pas écrite dans l’adresse';
  if (found.unique) return ''; // seule rue de ce nom dans la ville (voir geocode) : c'est une correction, pas un doute
  if (!same.type) return `« ${streetType(found.street)} » au lieu de « ${streetType(query)} »`;
  if (!same.street) return 'le nom de la rue est différent';
  if (found.score < LOW_SCORE) return 'ressemblance faible';
  return '';
}

const isDoubtful = (query, found) => doubtReason(query, found) !== '';

// Ce que l'appli a corrigé d'elle-même pour trouver l'adresse, ou ''. Une
// correction n'est jamais appliquée en silence : elle est montrée, et se
// valide d'un appui.
function correctionNote(line, found) {
  if (found.unique) return 'seule rue de ce nom dans la ville';
  if (line.repaired) return '« 0 » lu à la place d’un « O »';
  return '';
}

// La recherche d'adresse ne renvoie jamais une autre ville que celle écrite
// (voir geocode). Quand elle ne reconnaît aucune ville, il faut corriger le texte.
const UNKNOWN_CITY = 'Ville non reconnue. Vérifie le nom de la ville dans l’adresse (ou ajoute-la).';

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
    settings: {
      home: null,
      work: null,
      startFrom: 'work',
      onsiteMinutes: 10,
      lunchStart: '12:00',
      lunchMinutes: 90,
      lunchAtAgency: false,
      ...saved.settings,
    },
    draft: saved.draft || '',
    pending: null, // interventions en cours de vérification (pas reprises après fermeture)
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
//
// L'écran principal (le parcours, ou la liste tant qu'il n'y a pas de
// parcours) est la base. Les autres écrans s'ouvrent « par-dessus » et sont
// inscrits dans l'historique du navigateur : le bouton Retour du téléphone, ou
// la flèche en haut à gauche, ramène à l'écran d'avant au lieu de quitter
// l'appli. La feuille scannée et le formulaire d'ajout se referment de même.

const TITLES = { settings: 'Réglages', stats: 'Statistiques', input: 'Liste du jour', review: 'Adresses à vérifier' };
let currentView = null;
let depth = 0; // nombre d'écrans ou de volets ouverts au-dessus de l'écran principal

function render(view) {
  currentView = view;
  for (const section of document.querySelectorAll('.view')) {
    section.hidden = section.id !== `view-${view}`;
  }
  window.scrollTo(0, 0);
  ({ settings: renderSettings, input: renderInput, review: renderReview, tour: renderTour, stats: renderStats })[view]();
  renderTopbar();
  applyUpdate();
}

function renderTopbar() {
  $('#nav-back').hidden = depth === 0;
  const title = history.state?.overlay === 'move' ? 'Déplacer' : TITLES[currentView];
  $('#app-title').textContent = (depth > 0 && title) || 'Mes interventions';
}

// Ouvre un écran par-dessus l'écran actuel.
function open(view) {
  if (view === currentView) return;
  depth++;
  history.pushState({ view, depth }, '');
  render(view);
}

// Ouvre un volet du même écran (feuille scannée, formulaire d'ajout,
// déplacement d'une intervention).
function openOverlay(overlay) {
  depth++;
  history.pushState({ view: currentView, depth, overlay }, '');
  showOverlay(overlay);
  renderTopbar();
}

function showOverlay(overlay) {
  if (overlay !== 'viewer') closeViewer();
  $('#add-form').hidden = overlay !== 'add';
  if (overlay !== 'move') stopMoving();
}

// Revient d'un cran, comme le bouton Retour du téléphone.
function goBack() {
  if (depth > 0) history.back();
}

// Revient à l'écran principal, quel que soit le nombre d'écrans ouverts.
function goHome() {
  if (depth > 0) history.go(-depth);
  else render(homeView());
}

// Le navigateur vient de revenir en arrière (ou en avant) : on affiche l'écran correspondant.
function onPopState(event) {
  // retour « en avant » sur un déplacement déjà terminé : il n'y a plus rien à déplacer
  if (event.state?.overlay === 'move' && movingId === null) return history.back();
  const leaving = currentView;
  depth = event.state?.depth ?? 0;
  showOverlay(event.state?.overlay);
  if (leaving === 'review' && state.pending) {
    state.pending = null; // vérification abandonnée
    saveState();
  }
  let view = depth === 0 ? homeView() : event.state.view;
  if (view === 'review' && !state.pending) view = homeView();
  if (view !== currentView) render(view);
  else renderTopbar();
}

function homeView() {
  const { home, work, startFrom } = state.settings;
  if (!home || (startFrom === 'work' && !work)) return 'settings';
  return state.tour ? 'tour' : 'input';
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
  $('#lunch-start').value = state.settings.lunchStart;
  $('#lunch-minutes').value = state.settings.lunchMinutes;
  $('#welcome').hidden = homeView() !== 'settings';
  showVersion();
}

async function saveSettings(event) {
  event.preventDefault();
  const homeQuery = $('#home').value.trim();
  const workQuery = $('#work').value.trim();
  const startFrom = document.querySelector('input[name=startFrom]:checked').value;
  const minutes = (input) => Math.min(240, Math.max(0, Math.round(Number(input.value) || 0)));
  const onsiteMinutes = minutes($('#onsite'));
  const lunchStart = /^\d{2}:\d{2}$/.test($('#lunch-start').value) ? $('#lunch-start').value : '12:00';
  const lunchMinutes = minutes($('#lunch-minutes'));
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
    if (home.unknownCity) return toast('Domicile : ville non reconnue. Ajoute la ville ou le code postal.');
    if (workQuery && !work) return toast('Adresse du travail introuvable. Ajoute le code postal ou la ville.');
    if (work?.unknownCity) return toast('Travail : ville non reconnue. Ajoute la ville ou le code postal.');
    const { lunchAtAgency } = state.settings;
    state.settings = { home, work, startFrom, onsiteMinutes, lunchStart, lunchMinutes, lunchAtAgency };
    saveState();
    if (depth > 0) goBack();
    else render(homeView());
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
  if (!found || found.unknownCity) return found;
  return { query, label: found.label, lat: found.lat, lon: found.lon, doubtful: isDoubtful(query, found) };
}

// ---------- Saisie de la liste ----------

const POSTCODE = /(^|\D)\d{5}(\D|$)/;

// Ligne écrite par la lecture de photo : « Matin | adresse | nom · tél | libellé ».
const SLOT_FIELD = /^(matin|m|apr[eè]s[- ]?midi|am|\?)$/i;
// Un « ! » au début de la ligne : intervention prioritaire (à faire en premier).
const PRIORITY_MARK = /^!+\s*/;

// Une intervention par ligne.
function parseList(text) {
  return text
    .split(/\r?\n/)
    .map((raw) => raw.trim())
    .filter((raw) => /[\p{L}\p{N}]/u.test(raw))
    .map(parseLine);
}

function parseLine(raw) {
  const firstPhone = (text) => text.match(PHONE)?.[0].replace(/\D/g, '') ?? null;
  const priority = PRIORITY_MARK.test(raw);
  const text = raw.replace(PRIORITY_MARK, '');
  const fields = text.split(/\s*\|\s*/);
  const structured = fields.length >= 2 && SLOT_FIELD.test(fields[0]);
  const address = structured ? fields[1] : extractAddress(text);
  const query = cleanStreet(fixZeros(address));
  const repaired = fixZeros(address) !== address; // correction à montrer (voir correctionNote)
  if (structured) {
    const slot = /^(matin|m)$/i.test(fields[0]) ? 'M' : /^(apr|am)/i.test(fields[0]) ? 'AM' : null;
    const details = fields.slice(2).filter(Boolean).join(' · ');
    return { raw, query, title: fields[1], details, phone: firstPhone(details), slot, priority, repaired };
  }
  return { raw, query, title: text, details: '', phone: firstPhone(text), slot: null, priority, repaired };
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

// ---------- Interrupteur « Pause déjeuner à l'agence » ----------

function renderAgencyToggle() {
  const { lunchAtAgency, lunchMinutes } = state.settings;
  const passed = Date.now() >= lunchWindow().to;
  for (const toggle of document.querySelectorAll('.agency-toggle')) {
    toggle.hidden = lunchMinutes <= 0;
    toggle.querySelector('.agency-note').textContent = passed ? 'pause de midi déjà passée' : '';
    for (const button of toggle.querySelectorAll('[data-agency]')) {
      button.setAttribute('aria-pressed', String((button.dataset.agency === 'yes') === lunchAtAgency));
    }
  }
}

// Sur le parcours, le changement est appliqué tout de suite : depuis le départ
// si la journée n'a pas commencé, sinon depuis là où l'on est.
async function setLunchAtAgency(value) {
  if (value === state.settings.lunchAtAgency) return;
  if (value && !state.settings.work) return toast('Indique d’abord l’adresse de l’agence (travail) dans les réglages.');
  state.settings.lunchAtAgency = value;
  saveState();
  renderAgencyToggle();
  const tour = state.tour;
  if (!tour || $('#view-tour').hidden) return;
  if (Date.now() >= lunchWindow().to) return toast('La pause de midi est déjà passée aujourd’hui : le parcours ne change pas.');
  await recalculate([], { fromStart: notStarted(tour) });
}

// La journée n'a pas commencé : un recalcul repart du point de départ.
const notStarted = (tour) => tour.stops.every((stop) => statusOf(stop) === 'todo') && !tour.recalculatedAt;

// Correction de « Matin » / « Après-midi » sur une intervention du parcours :
// l'ordre est recalculé tout de suite, et la ligne de la liste est corrigée
// aussi (pour qu'un nouveau tri garde la correction).
async function onSlotChange(event) {
  const select = event.target.closest('select[data-slot]');
  if (!select) return;
  const tour = state.tour;
  const stop = tour.stops.find((s) => s.id === Number(select.closest('[data-id]').dataset.id));
  stop.slot = select.value || null;
  rewriteLine(stop, withSlot(stop.raw, stop.slot));
  saveState();
  await recalculate([], { fromStart: notStarted(tour) });
}

// « Prioritaire » activé ou retiré sur une intervention du parcours : même
// principe, l'ordre est recalculé tout de suite et la ligne de la liste suit.
async function togglePriority(id) {
  const tour = state.tour;
  const stop = tour.stops.find((s) => s.id === id);
  stop.priority = !stop.priority;
  rewriteLine(stop, withPriority(stop.raw, stop.priority));
  saveState();
  await recalculate([], { fromStart: notStarted(tour) });
}

// Remplace la ligne d'une intervention dans la liste du jour.
function rewriteLine(stop, raw) {
  state.draft = state.draft
    .split('\n')
    .map((line) => (line.trim() === stop.raw ? raw : line))
    .join('\n');
  stop.raw = raw;
}

const SLOT_LABEL = { M: 'Matin', AM: 'Après-midi' };

// Réécrit une ligne de la liste avec « Matin | », « Après-midi | » ou « ? | » devant.
function withSlot(raw, slot) {
  const mark = raw.match(PRIORITY_MARK)?.[0] ?? '';
  const text = raw.slice(mark.length);
  const fields = text.split(/\s*\|\s*/);
  const rest = fields.length >= 2 && SLOT_FIELD.test(fields[0]) ? fields.slice(1) : [text];
  return mark + [SLOT_LABEL[slot] ?? '?', ...rest].join(' | ');
}

// Réécrit une ligne de la liste avec ou sans le « ! » des prioritaires.
const withPriority = (raw, priority) => (priority ? '! ' : '') + raw.replace(PRIORITY_MARK, '');

function renderInput() {
  const { home } = state.settings;
  const start = startPlace();
  const startText = start.name === 'Travail' ? `au travail (${start.label})` : 'au domicile';
  $('#route-summary').innerHTML = `Départ ${esc(startText)}<br>Retour au domicile (${esc(home.label)})`;
  $('#list').value = state.draft;
  updateCount();
  renderAgencyToggle();
}

function updateCount() {
  const lines = parseList($('#list').value);
  const priorities = lines.filter((line) => line.priority).length;
  $('#list-count').textContent =
    plural(lines.length, 'intervention') + (priorities ? `, dont ${plural(priorities, 'prioritaire')}` : '');
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

// Photos de la feuille : chaque intervention lue devient une ligne de la liste,
// que Pierre peut vérifier avant de trier. Une intervention déjà présente
// (même page photographiée deux fois) n'est pas ajoutée une deuxième fois.
async function importPhotos(files) {
  if (!files.length) return;
  let added = 0;
  let already = 0;
  let unknownSlot = 0;
  try {
    for (const [i, file] of [...files].entries()) {
      const page = files.length > 1 ? `Photo ${i + 1}/${files.length} · ` : '';
      busy(`${page}Lecture de la photo…`);
      const { rows, copy } = await readSheetPhoto(file, (text) => busy(page + text));
      const addedBefore = added;
      for (const row of rows) {
        const list = $('#list').value;
        if ((row.ref && list.includes(row.ref)) || list.includes(row.address)) {
          already++;
          continue;
        }
        $('#list').value = `${list.trim() ? `${list.trimEnd()}\n` : ''}${sheetLine(row)}`;
        added++;
        if (!row.slot) unknownSlot++;
      }
      // Copie de la page gardée sur le téléphone, pour revérifier en cas
      // d'erreur de lecture (pas pour une page déjà scannée, qui n'apporte rien).
      if (added > addedBefore && copy) await savePage(copy).catch(() => {});
    }
    onListInput();
    if (!added && !already) {
      toast('Aucune intervention trouvée. Reprends la photo bien à plat, toute la feuille visible, sans ombre.');
    } else {
      toast(
        `${plural(added, 'intervention ajoutée', 'interventions ajoutées')}` +
          (already ? `, ${already} déjà dans la liste` : '') +
          (unknownSlot ? `. Matin / après-midi non lu pour ${unknownSlot} : tu pourras le choisir sur chaque intervention après le tri.` : '.'),
      );
    }
  } catch (err) {
    toast(err.message);
  } finally {
    idle();
    $('#photo-input').value = '';
    $('#scan-input').value = '';
    updatePagesButtons();
  }
}

// ---------- Feuille scannée : relecture des pages gardées sur le téléphone ----------

let viewerUrls = [];

async function updatePagesButtons() {
  const count = await countPages().catch(() => 0);
  for (const button of document.querySelectorAll('.view-pages')) {
    button.hidden = !count;
    button.textContent = `Voir la feuille scannée (${plural(count, 'page')})`;
  }
}

async function openViewer() {
  const pages = await listPages().catch(() => []);
  if (!pages.length) return toast('Aucune page scannée à afficher.');
  viewerUrls = pages.map((page) => URL.createObjectURL(page.blob));
  $('#viewer-pages').innerHTML = pages
    .map((page, i) => {
      const time = new Date(page.addedAt).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `<figure><figcaption>Page ${i + 1} · scannée ${esc(time)}</figcaption><img src="${viewerUrls[i]}" alt="Page scannée ${i + 1}"></figure>`;
    })
    .join('');
  $('#viewer').hidden = false;
  openOverlay('viewer');
}

function closeViewer() {
  $('#viewer').hidden = true;
  $('#viewer-pages').innerHTML = '';
  for (const url of viewerUrls) URL.revokeObjectURL(url);
  viewerUrls = [];
}

function sheetLine(row) {
  const slot = row.slot === 'M' ? 'Matin' : row.slot === 'AM' ? 'Après-midi' : '?';
  const contact = [row.name, ...row.phones.map(formatPhone)].filter(Boolean).join(' · ');
  const libelle = [row.num ? `n°${row.num}` : '', row.ref ?? '', row.label].filter(Boolean).join(' ');
  return [slot, row.address, contact, libelle].join(' | ');
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
    if (state.pending.some((stop) => stop.reviewing)) open('review');
    else await computeTour();
  } catch (err) {
    toast(err.message);
  } finally {
    idle();
  }
}

function toStop(id, line, found) {
  const { raw, query, title, details, phone, slot } = line;
  const usable = Boolean(found) && !found.unknownCity;
  const priority = Boolean(line.priority);
  const stop = { id, raw, query, title, details, phone, slot, priority, found: usable, unknownCity: Boolean(found?.unknownCity) };
  if (usable) {
    const doubt = doubtReason(line.query, found);
    const corrected = doubt ? '' : correctionNote(line, found);
    // « doubtful » : à montrer avant de calculer, que ce soit un doute ou une correction
    Object.assign(stop, { label: found.label, lat: found.lat, lon: found.lon, doubtful: Boolean(doubt || corrected), doubt, corrected });
    if (doubt && found.alternatives?.length) stop.alternatives = found.alternatives; // autres rues possibles, à proposer
  }
  return stop;
}

const needsCheck = (stop) => !stop.found || stop.doubtful;

// ---------- Vérification des adresses douteuses ----------

function renderReview() {
  const items = state.pending.filter((stop) => stop.reviewing);
  const unsure = items.some((stop) => stop.found && stop.doubtful);
  // Une adresse introuvable (ou dont la ville n'est pas reconnue) bloque la
  // suite : il faut corriger le texte. Une adresse « pas sûre » se confirme
  // d'un appui, ou se remplace par une autre rue proposée.
  const removeButton = '<button class="btn danger" data-action="remove" type="button">Retirer</button>';
  $('#review-list').innerHTML = items
    .map((stop) => {
      const status = !stop.found ? 'bad' : needsCheck(stop) ? 'warn' : 'ok';
      const result = !stop.found
        ? stop.unknownCity
          ? UNKNOWN_CITY
          : 'Adresse introuvable'
        : `${status !== 'warn' ? 'Trouvé' : stop.corrected ? `Corrigé automatiquement (${esc(stop.corrected)})` : `Trouvé, mais pas sûr (${esc(stop.doubt)})`} : <b>${esc(stop.label)}</b>`;
      const editor = `
          <input type="text" value="${esc(stop.query)}" aria-label="Adresse à chercher" enterkeyhint="search">
          <div class="row">
            <button class="btn" data-action="search" type="button">Chercher</button>
            ${status === 'warn' ? '' : removeButton}
          </div>`;
      const alternatives = (status === 'warn' && stop.alternatives) || [];
      const choices = alternatives.length
        ? `<p class="hint alts-title">Ou une autre rue de ${esc(alternatives[0].city)} :</p>
          <div class="alts">
            ${alternatives.map((alt, i) => `<button class="btn" data-action="pick" data-alt="${i}" type="button">${esc(alt.street)}</button>`).join('')}
          </div>`
        : '';
      const confirm = `
          <div class="row">
            <button class="btn success" data-action="confirm" type="button">C’est la bonne ✓</button>
            ${removeButton}
          </div>`;
      return `
        <li class="card ${status}" data-id="${stop.id}">
          <p class="raw">${esc(stop.title ?? stop.raw)}</p>
          ${stop.details ? `<p class="hint">${esc(stop.details)}</p>` : ''}
          <p class="result">${result}</p>
          ${status === 'bad' ? editor : `${status === 'warn' ? confirm + choices : ''}
          <details class="fix"><summary>${status === 'warn' ? 'Corriger à la main' : 'Modifier'}</summary>${editor}</details>`}
        </li>`;
    })
    .join('');
  const blocked = items.some((stop) => !stop.found);
  const button = $('#review-continue');
  button.disabled = blocked || state.pending.length === 0;
  button.textContent = blocked ? 'Corrige ou retire les adresses en rouge' : unsure ? 'Tout est bon, calculer le meilleur ordre' : 'Calculer le meilleur ordre';
}

async function onReviewClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const item = button.closest('[data-id]');
  const index = state.pending.findIndex((stop) => stop.id === Number(item.dataset.id));
  const stop = state.pending[index];
  const { action } = button.dataset;
  if (action === 'remove') {
    state.pending.splice(index, 1);
  } else if (action === 'confirm') {
    stop.doubtful = false; // l'adresse trouvée est la bonne : rien à réécrire
  } else {
    const picked = action === 'pick' && stop.alternatives[Number(button.dataset.alt)];
    const query = picked ? pickedQuery(stop, picked) : item.querySelector('input').value.trim();
    busy('Recherche…');
    try {
      const found = await geocode(query, startPlace());
      state.pending[index] = { ...toStop(stop.id, { ...stop, query }, found), reviewing: true };
      if (!found) toast('Toujours introuvable. Essaie avec le code postal et la ville.');
      else if (found.unknownCity) toast(UNKNOWN_CITY);
    } catch (err) {
      toast(err.message);
    } finally {
      idle();
    }
  }
  saveState();
  renderReview();
}

// Adresse à chercher quand on choisit une autre rue proposée : le même numéro,
// dans la rue choisie (qui est toujours dans la ville écrite).
function pickedQuery(stop, alt) {
  const number = cityLast(stop.query).match(/^\d+(?:\s?(?:bis|ter))?(?=\s)/i)?.[0] ?? '';
  return `${number} ${alt.street} ${alt.postcode} ${alt.city}`.trim();
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

// Ordre de la journée : matin, pause (à l'agence si Pierre y retourne), après-midi.
// Dans chaque demi-journée, les interventions prioritaires passent d'abord.
// Chaque étape a un rang : 0 = prioritaire du matin, 1 = matin, 2 = pause à
// l'agence, 3 = prioritaire de l'après-midi, 4 = après-midi.
// Revenir à un rang plus petit coûte « l'infini » : le meilleur ordre respecte
// donc toujours la journée.
const RANK = { M: 1, AM: 4 };
const LUNCH_RANK = 2;
const LAST_RANK = 4;
const BACKWARDS = 1e6;
const LUNCH_ID = -1;

const isLunch = (stop) => stop.kind === 'lunch';

// Rang d'une étape. `morning` ne sert qu'aux interventions sans « M » ni « AM » ;
// si elles sont prioritaires, elles passent en tout premier.
function rankOf(stop, morning) {
  if (isLunch(stop)) return LUNCH_RANK;
  const half = RANK[stop.slot] ?? (morning || stop.priority ? RANK.M : RANK.AM);
  return stop.priority ? half - 1 : half;
}

function lunchWindow(now = Date.now()) {
  const [hours, minutes] = state.settings.lunchStart.split(':').map(Number);
  const from = new Date(now).setHours(hours, minutes, 0, 0);
  return { from, to: from + state.settings.lunchMinutes * 60 * 1000 };
}

// Passage à l'agence pour la pause : si le réglage le demande et que la pause n'est pas passée.
function lunchAtAgencyToday() {
  const { lunchAtAgency, lunchMinutes, work } = state.settings;
  return Boolean(lunchAtAgency && lunchMinutes > 0 && work && Date.now() < lunchWindow().to);
}

function lunchStop() {
  const { work } = state.settings;
  const title = 'Pause déjeuner à l’agence';
  return { id: LUNCH_ID, kind: 'lunch', raw: title, title, label: work.label, lat: work.lat, lon: work.lon, found: true };
}

// Meilleur ordre de passage pour `stops` (la pause à l'agence peut en faire
// partie), entre le point 0 et le point n+1 de la matrice des temps.
// `startTime` : heure à laquelle on quitte le point 0.
function bestOrder(durations, stops, startTime = Date.now()) {
  const n = stops.length;
  const all = stops.map((_, i) => i + 1);
  const slots = stops.map((stop) => stop.slot);
  const constrained = stops.some((stop) => isLunch(stop) || stop.priority) || (slots.includes('M') && slots.includes('AM'));
  if (!constrained) return optimizeOrder(durations, 0, n + 1, all);
  // Interventions sans « M » / « AM » ni priorité : le matin si on y arriverait
  // avant la pause, l'après-midi sinon (d'après un premier ordre, sans la pause).
  const real = all.filter((i) => !isLunch(stops[i - 1]));
  const draftRanks = stops.map((stop) => (stop.slot || stop.priority ? rankOf(stop) : null));
  const draft = optimizeOrder(penalize(durations, [0, ...draftRanks, LAST_RANK]), 0, n + 1, real, 150);
  const lunchFrom = lunchWindow().from;
  const onsite = state.settings.onsiteMinutes * 60 * 1000;
  const arrival = new Map();
  let time = startTime;
  let previous = 0;
  for (const i of draft) {
    time += durations[previous][i] * 1000;
    arrival.set(i, time);
    time += onsite;
    previous = i;
  }
  const ranks = stops.map((stop, k) => rankOf(stop, arrival.get(k + 1) < lunchFrom));
  return optimizeOrder(penalize(durations, [0, ...ranks, LAST_RANK]), 0, n + 1, all);
}

// Ce que coûtent les interventions prioritaires dans l'ordre calculé : leur
// nombre, et la route en plus (en secondes) par rapport au meilleur ordre sans
// aucune priorité.
function priorityToll(durations, stops, order, startTime) {
  const count = stops.filter((stop) => stop.priority).length;
  if (!count) return { count, cost: 0 };
  const pathOf = (path) => [0, ...path, stops.length + 1];
  const free = bestOrder(durations, stops.map((stop) => ({ ...stop, priority: false })), startTime);
  return { count, cost: Math.max(0, pathCost(durations, pathOf(order)) - pathCost(durations, pathOf(free))) };
}

// Ordre des étapes qui restent, dans la matrice des temps (0 = point de
// départ, 1..n = étapes, n+1 = retour). Les `lockedCount` premières ont été
// placées à la main : elles gardent leur ordre. Les autres sont triées au
// mieux à partir de la dernière étape placée à la main.
function orderAfterLocked(durations, todo, lockedCount) {
  const n = todo.length;
  const head = todo.slice(0, lockedCount).map((_, i) => i + 1);
  const free = todo.slice(lockedCount);
  if (!free.length) return { order: head, priorities: { count: 0, cost: 0 } };
  const nodes = [lockedCount, ...free.map((_, i) => lockedCount + 1 + i), n + 1];
  const sub = nodes.map((a) => nodes.map((b) => durations[a][b]));
  // heure à laquelle on repart de la dernière étape placée à la main
  const onsite = state.settings.onsiteMinutes * 60 * 1000;
  const lunch = lunchWindow();
  let startTime = Date.now();
  for (const i of head) {
    startTime += durations[i - 1][i] * 1000;
    startTime = isLunch(todo[i - 1]) ? Math.max(startTime, lunch.from) + (lunch.to - lunch.from) : startTime + onsite;
  }
  const tail = bestOrder(sub, free, startTime);
  return {
    order: [...head, ...tail.map((i) => lockedCount + i)],
    priorities: priorityToll(sub, free, tail, startTime),
  };
}

function penalize(durations, ranks) {
  return durations.map((row, i) =>
    row.map((value, j) => (ranks[i] !== null && ranks[j] !== null && ranks[i] > ranks[j] ? value + BACKWARDS : value)),
  );
}

async function computeTour() {
  const real = state.pending;
  const stops = lunchAtAgencyToday() ? [...real, lunchStop()] : real;
  const n = stops.length;
  const start = startPlace();
  const end = { ...state.settings.home, name: 'Domicile' };
  // dans la matrice : 0 = départ, 1..n = interventions, n+1 = retour
  busy('Calcul des temps de trajet…');
  const matrix = await travelMatrix([start, ...stops, end]);

  busy('Recherche du meilleur ordre…');
  await new Promise((resolve) => setTimeout(resolve, 30)); // laisse le message s'afficher
  const listOrder = real.map((_, i) => i + 1);
  const best = bestOrder(matrix.durations, stops);
  // gain par rapport à l'ordre de la liste, mesuré avec la même matrice
  // (sans le passage à l'agence, que la liste ne prévoit pas)
  const pathOf = (order) => [0, ...order, n + 1];
  const bestWithoutLunch = best.filter((i) => !isLunch(stops[i - 1]));
  const saved = {
    duration: pathCost(matrix.durations, pathOf(listOrder)) - pathCost(matrix.durations, pathOf(bestWithoutLunch)),
    distance: pathCost(matrix.distances, pathOf(listOrder)) - pathCost(matrix.distances, pathOf(bestWithoutLunch)),
  };

  busy('Tracé de l’itinéraire…');
  const ordered = best.map((i) => stops[i - 1]);
  const route = matrix.source === 'osrm' ? await routeLine([start, ...ordered, end]) : null;
  const path = pathOf(best);
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
    stops: real.length,
    absent: 0,
    savedTime: Math.max(0, saved.duration),
    savedDistance: Math.max(0, saved.distance),
  });

  state.tour = {
    createdAt,
    day: today,
    start,
    end,
    stops: ordered.map(({ reviewing, alternatives, ...stop }, k) => ({ ...stop, leg: legs[k], status: 'todo' })),
    back: legs[n],
    total: {
      duration: legs.reduce((sum, leg) => sum + leg.duration, 0),
      distance: legs.reduce((sum, leg) => sum + leg.distance, 0),
    },
    saved,
    priorities: priorityToll(matrix.durations, stops, best),
    line: route?.line ?? null,
    estimated: matrix.source !== 'osrm',
  };
  state.pending = null;
  saveState();
  goHome();
}

// ---------- Affichage de la tournée ----------

function renderTour() {
  const tour = state.tour;
  const nextId = tour.stops.find((stop) => statusOf(stop) === 'todo')?.id;
  const { saved } = tour;
  // rappel du dernier calcul, tant qu'il reste une intervention prioritaire à faire
  const { count: priorities = 0, cost: detour = 0 } = tour.priorities ?? {};
  const priorityLeft = tour.stops.some((stop) => stop.priority && statusOf(stop) === 'todo');

  $('#tour-summary').innerHTML = `
    <div class="stats">
      <div><b>${tour.stops.filter((stop) => !isLunch(stop)).length}</b><span>interventions</span></div>
      <div><b>${fmtDuration(tour.total.duration)}</b><span>de route</span></div>
      <div><b>${fmtDistance(tour.total.distance)}</b><span>au total</span></div>
    </div>
    ${saved.duration >= 60 ? `<p class="gain"><b>${fmtDuration(saved.duration)}</b><span>de route en moins par rapport à l'ordre de la liste${saved.distance >= 1000 ? ` (${fmtDistance(saved.distance)} de moins)` : ''}</span></p>` : ''}
    ${priorities && priorityLeft ? `<p class="priority-note">★ ${plural(priorities, 'prioritaire')} en premier${detour >= 60 ? ` · ${fmtDuration(detour)} de route en plus` : ''}</p>` : ''}
    ${tour.estimated ? '<p class="hint warn-text">Service d’itinéraire injoignable : temps estimés à vol d’oiseau.</p>' : ''}`;

  // Déplacement à la main : bouton sur chaque carte, puis emplacements
  // « Mettre ici » entre les cartes pendant qu'on déplace (voir startMoving).
  const todoStops = tour.stops.filter((stop) => statusOf(stop) === 'todo');
  const moving = todoStops.find((stop) => stop.id === movingId) ?? null;
  const movingIndex = todoStops.indexOf(moving);
  const moveButton = (status) =>
    status === 'todo' && !moving && todoStops.length > 1
      ? `<button class="move-btn" data-move type="button" aria-label="Déplacer">${MOVE_ICON}</button>`
      : '';
  const dropHere = (target, text = 'Mettre ici') =>
    `<li class="drop"><button class="btn" data-drop="${target}" type="button">${text}</button></li>`;
  const dropBefore = (stop) => {
    const i = todoStops.indexOf(stop);
    // pas d'emplacement juste avant ou juste après elle-même : ce serait la même place
    return moving && i >= 0 && i !== movingIndex && i !== movingIndex + 1 ? dropHere(stop.id) : '';
  };
  const dropLast = moving && movingIndex !== todoStops.length - 1 ? dropHere('end', 'Mettre ici, en dernier') : '';
  // repère sous la dernière intervention placée à la main
  const lastLocked = todoStops.filter((stop) => stop.locked).at(-1);
  const orderNote = (stop) =>
    stop === lastLocked && !moving
      ? `<li class="order-note"><span>↑ Ordre choisi à la main</span><button class="btn link" data-auto type="button">Remettre l’ordre automatique</button></li>`
      : '';

  let number = 0;
  const stopItem = (stop) =>
    dropBefore(stop) + (isLunch(stop) ? lunchItem(stop) : interventionItem(stop, ++number)) + orderNote(stop);
  const lunchItem = (stop) => {
    const status = statusOf(stop);
    const isNext = stop.id === nextId;
    const actions =
      status === 'todo'
        ? `<a class="btn" href="${wazeUrl(stop)}" target="_blank" rel="noopener">Waze</a>
           <a class="btn" href="${mapsUrl(stop)}" target="_blank" rel="noopener">Maps</a>
           <button class="btn success" data-action="done" type="button">Pause finie ✓</button>`
        : '<button class="btn" data-action="todo" type="button">Annuler</button>';
    return `
    <li class="stop lunch ${status}${isNext ? ' next' : ''}${stop === moving ? ' moving' : ''}" data-id="${stop.id}">
      ${legLine(stop.leg)}
      <div class="stop-card lunch-card">
        <div class="stop-head">
          <span class="num">P</span>
          <div class="stop-text">
            ${isNext ? '<span class="badge">Prochaine</span>' : ''}
            <p class="title">${esc(stop.title)}</p>
            <p class="sub">${esc(stop.label)}</p>
            <p class="details lunch-time"></p>
          </div>
          ${moveButton(status)}
        </div>
        <div class="actions">${actions}</div>
      </div>
    </li>`;
  };
  const interventionItem = (stop, k) => {
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
    <li class="stop ${status}${isNext ? ' next' : ''}${stop === moving ? ' moving' : ''}" data-id="${stop.id}">
      ${legLine(stop.leg)}
      <div class="stop-card">
        <div class="stop-head">
          <span class="num">${k}</span>
          <div class="stop-text">
            ${isNext ? '<span class="badge">Prochaine</span>' : ''}
            ${status === 'absent' ? '<span class="badge absent">Client absent</span>' : ''}
            ${stop.added ? '<span class="badge added">Ajoutée</span>' : ''}
            ${slotControl(stop, status)}
            ${priorityControl(stop, status)}
            <p class="title">${esc(stop.title ?? stop.raw)}</p>
            ${sameText(stop.title ?? stop.raw, stop.label) ? '' : `<p class="sub">${esc(stop.label)}</p>`}
            ${stop.details ? `<p class="details">${esc(detailsWithoutPhone(stop.details))}</p>` : ''}
            ${stop.phone ? `<a class="phone" href="tel:${stop.phone}">Appeler le ${formatPhone(stop.phone)}</a>` : ''}
          </div>
          ${moveButton(status)}
        </div>
        <div class="actions">${actions}</div>
      </div>
    </li>`;
  };
  const slotControl = (stop, status) => {
    if (status !== 'todo') return stop.slot ? `<span class="badge slot">${SLOT_LABEL[stop.slot]}</span>` : '';
    const option = (value, text) => `<option value="${value}"${(stop.slot ?? '') === value ? ' selected' : ''}>${text}</option>`;
    return `<select class="slot-select${stop.slot ? '' : ' unset'}" data-slot aria-label="Matin ou après-midi">
      ${option('', 'Matin ou après-midi ?')}${option('M', 'Matin')}${option('AM', 'Après-midi')}
    </select>`;
  };
  const priorityControl = (stop, status) => {
    if (status !== 'todo') return stop.priority ? '<span class="badge priority">★ Prioritaire</span>' : '';
    return `<button class="priority-toggle" data-priority type="button" aria-pressed="${Boolean(stop.priority)}">${stop.priority ? '★' : '☆'} Prioritaire</button>`;
  };
  const endpoint = (letter, title, place) => `
    <div class="stop-card endpoint">
      <div class="stop-head">
        <span class="num">${letter}</span>
        <div class="stop-text"><p class="title">${title}</p><p class="sub">${esc(place.label)}</p></div>
      </div>
    </div>`;

  $('#recalc').hidden = !nextId;
  $('#tour-list').classList.toggle('moving-mode', Boolean(moving));
  sortable?.option('disabled', Boolean(moving)); // pas de glisser pendant « Déplacer » / « Mettre ici »
  $('#tour-list').innerHTML = `
    <li class="stop">${endpoint('D', `Départ · ${esc(tour.start.name)}`, tour.start)}</li>
    ${tour.stops.map(stopItem).join('')}
    ${dropLast}
    <li class="stop">${legLine(tour.back)}${endpoint('R', 'Retour · Domicile', tour.end)}</li>`;
  $('#move-bar').hidden = !moving;
  $('#move-bar').textContent = moving ? `Où mettre « ${moving.title ?? moving.raw} » ? Touche « Mettre ici » à l’endroit voulu.` : '';

  renderProgress();
  renderAgencyToggle();
  drawMap(tour, nextId);
}

// Statut d'une intervention : 'todo' (à faire), 'done' (faite) ou 'absent' (client absent).
// Les parcours enregistrés avant l'ajout de « Absent » n'avaient qu'un champ `done`.
const statusOf = (stop) => stop.status ?? (stop.done ? 'done' : 'todo');

// Nom, libellé… sans le téléphone (affiché à part, en lien « Appeler »).
const detailsWithoutPhone = (details) =>
  details
    .replace(PHONE, '')
    .replace(/(\s*·\s*){2,}/g, ' · ')
    .replace(/^\s*·\s*|\s*·\s*$/g, '')
    .trim();

function onTourClick(event) {
  const star = event.target.closest('button[data-priority]');
  if (star) return togglePriority(Number(star.closest('[data-id]').dataset.id));
  const mover = event.target.closest('button[data-move]');
  if (mover) return startMoving(Number(mover.closest('[data-id]').dataset.id));
  const drop = event.target.closest('button[data-drop]');
  if (drop) return dropStop(drop.dataset.drop === 'end' ? null : Number(drop.dataset.drop));
  if (event.target.closest('button[data-auto]')) return recalculate([], { fromStart: notStarted(state.tour), unlock: true });
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

// Déroulé estimé du reste de la journée, à partir de maintenant : route, temps
// sur place, et pause déjeuner. La pause se prend entre deux interventions,
// dès que l'heure est passée, ou avant un rendez-vous « Après-midi » (qui ne
// commence pas avant la fin de la pause). Une journée finie avant midi n'en a pas.
function planDay(tour, todo) {
  const { onsiteMinutes, lunchMinutes } = state.settings;
  const minute = 60 * 1000;
  const now = Date.now();
  const lunchFrom = lunchWindow(now).from;
  const lunchDuration = lunchMinutes * minute;
  // pause à l'agence : c'est une étape du parcours, prise en arrivant à l'agence
  const agency = tour.stops.find(isLunch);
  let lunch = null; // { beforeId, from, to, atAgency }
  let lunchDone = lunchMinutes <= 0 || now >= lunchFrom + lunchDuration || (agency && statusOf(agency) !== 'todo');
  let time = now;
  if (!lunchDone && !agency && now >= lunchFrom) {
    // en pleine pause : la journée reprend à la fin de la pause
    time = lunchFrom + lunchDuration;
    lunch = { beforeId: todo[0]?.id ?? null, from: lunchFrom, to: time };
    lunchDone = true;
  }
  for (const stop of todo) {
    if (isLunch(stop)) {
      const from = Math.max(time + stop.leg.duration * 1000, lunchFrom);
      time = from + lunchDuration;
      lunch = { beforeId: stop.id, from, to: time, atAgency: true };
      lunchDone = true;
      continue;
    }
    // (un rendez-vous « Après-midi » placé à la main plus tôt se fait quand on l'a mis)
    if (!lunchDone && !agency && (time >= lunchFrom || (stop.slot === 'AM' && !stop.locked))) {
      const from = Math.max(time, lunchFrom);
      time = from + lunchDuration;
      lunch = { beforeId: stop.id, from, to: time };
      lunchDone = true;
    }
    time += stop.leg.duration * 1000 + onsiteMinutes * minute;
  }
  time += tour.back.duration * 1000;
  const step = 5 * minute; // c'est une estimation : arrondi à 5 minutes
  return { end: new Date(Math.round(time / step) * step), lunch };
}

const fmtClock = (date) => `${date.getHours()} h ${String(date.getMinutes()).padStart(2, '0')}`;

function renderProgress() {
  const tour = state.tour;
  const todo = tour.stops.filter((stop) => statusOf(stop) === 'todo');
  const interventionsLeft = todo.filter((stop) => !isLunch(stop)).length;
  const absent = tour.stops.filter((stop) => statusOf(stop) === 'absent').length;
  const started = todo.length < tour.stops.length || tour.recalculatedAt;
  const driving = todo.reduce((total, stop) => total + stop.leg.duration, 0) + tour.back.duration;
  const { end, lunch } = planDay(tour, todo);
  const details = interventionsLeft
    ? `Reste ${plural(interventionsLeft, 'intervention')} · ${fmtDuration(driving)} de route`
    : 'Toutes les interventions sont terminées';
  $('#tour-progress').innerHTML = `
    <p class="eta">Retour à la maison vers <b>${fmtClock(end)}</b>${started ? '' : ' <span>en partant maintenant</span>'}</p>
    <p class="hint">${details}${lunch ? (lunch.atAgency ? ' · pause à l’agence comprise' : ' · pause déjeuner comprise') : ''}${absent ? ` · ${plural(absent, 'client absent', 'clients absents')}` : ''}</p>`;

  // horaires de la pause : sur l'étape « agence », ou repère dans la liste
  const lunchTime = document.querySelector('#tour-list .lunch-time');
  if (lunchTime) lunchTime.textContent = lunch?.atAgency ? `${fmtClock(new Date(lunch.from))} – ${fmtClock(new Date(lunch.to))}` : '';
  document.querySelector('#tour-list .lunch-break')?.remove();
  const before = lunch && !lunch.atAgency && document.querySelector(`#tour-list .stop[data-id="${lunch.beforeId}"]`);
  if (before) {
    before.insertAdjacentHTML(
      'beforebegin',
      `<li class="lunch-break">Pause déjeuner · ${fmtClock(new Date(lunch.from))} – ${fmtClock(new Date(lunch.to))}</li>`,
    );
  }
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
// de l'endroit où l'on est. Les interventions terminées gardent leur place,
// et celles placées à la main (locked) gardent leur ordre, en tête.
// - place : { id, beforeId } déplace d'abord une intervention à la main ;
// - unlock : oublie tous les placements à la main (ordre automatique).
async function recalculate(added = [], { fromStart = false, place = null, unlock = false } = {}) {
  const tour = state.tour;
  busy(fromStart ? 'Calcul du parcours…' : 'Recherche de ta position…');
  try {
    const finished = tour.stops.filter((stop) => statusOf(stop) !== 'todo');
    // la pause à l'agence suit le réglage actuel : ajoutée, ou retirée si on n'y va plus
    const wantLunch = !finished.some(isLunch) && lunchAtAgencyToday();
    let remaining = tour.stops.filter((stop) => statusOf(stop) === 'todo' && (wantLunch || !isLunch(stop)));
    if (place) remaining = placeStop(remaining, place.id, place.beforeId);
    if (unlock) remaining = remaining.map(({ locked, ...stop }) => stop);
    if (wantLunch && !remaining.some(isLunch)) remaining.push(lunchStop());
    const locked = remaining.filter((stop) => stop.locked);
    const todo = [...locked, ...remaining.filter((stop) => !stop.locked), ...added];
    const gps = fromStart ? null : await currentPosition();
    const from = fromStart ? tour.start : gps ?? lastDonePlace(tour);
    const n = todo.length;

    busy('Calcul des temps de trajet…');
    const matrix = await travelMatrix([from, ...todo, tour.end]);
    busy('Recherche du meilleur ordre…');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const { order, priorities } = orderAfterLocked(matrix.durations, todo, locked.length);
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
    if (!fromStart) legs[0] = { ...legs[0], from: gps ? 'position' : 'last' };

    tour.stops = [...finished, ...ordered.map((stop, k) => ({ ...stop, leg: legs[k] }))];
    tour.back = legs[n];
    const allLegs = [...tour.stops.map((stop) => stop.leg), tour.back];
    tour.total = {
      duration: allLegs.reduce((sum, leg) => sum + leg.duration, 0),
      distance: allLegs.reduce((sum, leg) => sum + leg.distance, 0),
    };
    tour.from = fromStart ? undefined : from;
    tour.priorities = priorities;
    tour.line = route?.line ?? null;
    tour.estimated = matrix.source !== 'osrm';
    tour.version = (tour.version ?? 0) + 1; // pour recadrer la carte
    if (!fromStart) tour.recalculatedAt = Date.now();
    const entry = state.history.find((e) => e.id === tour.createdAt);
    if (entry) entry.stops = tour.stops.filter((stop) => !isLunch(stop)).length;
    saveState();
    renderTour();
    $('.stop.next')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (!fromStart && !gps) toast('Position GPS introuvable : recalcul depuis la dernière intervention faite.');
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  } finally {
    idle();
  }
}

// ---------- Déplacer une intervention à la main ----------
//
// Deux façons : rester appuyé sur une carte et la faire glisser, ou le bouton
// « Déplacer » puis « Mettre ici » à l'endroit voulu (plus pratique pour un
// grand déplacement). Tout ce qui se trouve au-dessus de l'intervention
// déplacée, et elle-même, garde ensuite cet ordre ; ce qui vient après est
// retrié au mieux à partir de là.

let sortable = null;

// Glisser-déposer (bibliothèque Sortable) : appui long au doigt, glisser
// direct à la souris. Les boutons de la carte gardent leur rôle.
function enableDragging() {
  if (!window.Sortable) return; // pas chargée (hors ligne) : il reste le bouton « Déplacer »
  sortable = new Sortable($('#tour-list'), {
    draggable: 'li.stop.todo[data-id]',
    filter: 'button, a, select',
    preventOnFilter: false,
    delay: 350,
    delayOnTouchOnly: true,
    touchStartThreshold: 6,
    forceFallback: true,
    fallbackTolerance: 4,
    animation: 120,
    scroll: false, // défilement fait ici (startAutoScroll), plus régulier que celui de la bibliothèque
    onChoose: () => navigator.vibrate?.(20), // petit signal : la carte est attrapée
    onStart: (event) => {
      $('#tour-list').classList.add('sorting');
      startAutoScroll(event.originalEvent);
    },
    onEnd: onDragEnd,
  });
}

// Défilement de la liste pendant qu'on tient une carte près du haut ou du bas
// de l'écran. Une petite avance à chaque image (mouvement régulier), d'autant
// plus rapide que le doigt est près du bord. La zone du haut commence sous le
// bandeau bleu, qui recouvre le haut de la liste.
const SCROLL_ZONE = 150; // hauteur de chaque zone, en pixels
const SCROLL_MAX = 1200; // vitesse au bord, en pixels par seconde
let dragY = null; // hauteur du doigt à l'écran
let scrollFrame = 0;

// Vitesse de défilement (pixels par seconde, négative vers le haut) pour un
// doigt à la hauteur `y`, la liste étant visible entre `top` et `bottom`.
function scrollSpeed(y, top, bottom) {
  const zone = Math.min(SCROLL_ZONE, (bottom - top) / 3);
  const up = (top + zone - y) / zone;
  const down = (y - (bottom - zone)) / zone;
  const depth = Math.min(1, Math.max(up, down));
  if (depth <= 0) return 0;
  return (up > down ? -1 : 1) * SCROLL_MAX * (0.15 + 0.85 * depth);
}

const trackDrag = (event) => {
  dragY = (event.touches?.[0] ?? event).clientY;
};

function startAutoScroll(event) {
  stopAutoScroll();
  dragY = (event?.touches?.[0] ?? event)?.clientY ?? null;
  document.addEventListener('pointermove', trackDrag, { passive: true });
  document.addEventListener('touchmove', trackDrag, { passive: true });
  const top = $('.topbar').getBoundingClientRect().bottom;
  // on ne défile pas plus loin que la liste : en haut, on s'arrête quand son
  // début arrive sous le bandeau (sinon on remonterait jusqu'à la carte)
  const list = $('#tour-list').getBoundingClientRect();
  const highest = list.top + window.scrollY - top - 8;
  const lowest = list.bottom + window.scrollY - window.innerHeight + 8;
  let last = performance.now();
  const step = (now) => {
    const seconds = Math.min(50, now - last) / 1000;
    last = now;
    const speed = dragY === null ? 0 : scrollSpeed(dragY, top, window.innerHeight);
    const y = window.scrollY;
    if (speed < 0 && y > highest) window.scrollTo(0, Math.max(highest, y + speed * seconds));
    if (speed > 0 && y < lowest) window.scrollTo(0, Math.min(lowest, y + speed * seconds));
    scrollFrame = requestAnimationFrame(step);
  };
  scrollFrame = requestAnimationFrame(step);
}

function stopAutoScroll() {
  cancelAnimationFrame(scrollFrame);
  document.removeEventListener('pointermove', trackDrag);
  document.removeEventListener('touchmove', trackDrag);
  dragY = null;
}

async function onDragEnd(event) {
  stopAutoScroll();
  $('#tour-list').classList.remove('sorting');
  const id = Number(event.item.dataset.id);
  // l'intervention à faire qui suit désormais celle qu'on vient de lâcher
  let next = event.item.nextElementSibling;
  while (next && !next.matches('li.stop.todo[data-id]')) next = next.nextElementSibling;
  const beforeId = next ? Number(next.dataset.id) : null;
  const todo = state.tour.stops.filter((stop) => statusOf(stop) === 'todo');
  const at = todo.findIndex((stop) => stop.id === id);
  const moved = (todo[at + 1]?.id ?? null) !== beforeId;
  const done = moved && (await recalculate([], { fromStart: notStarted(state.tour), place: { id, beforeId } }));
  if (!done) renderTour(); // remet la liste comme elle était
}

let movingId = null; // intervention en cours de déplacement (on choisit où la mettre)
const MOVE_ICON =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 20V5M4 9l4-4 4 4M16 4v15M12 15l4 4 4-4"/></svg>';

function startMoving(id) {
  movingId = id;
  openOverlay('move'); // le bouton Retour annule
  renderTour();
  $('#tour-list .stop.moving')?.scrollIntoView({ block: 'center' });
}

function stopMoving() {
  if (movingId === null) return;
  movingId = null;
  if (currentView === 'tour' && state.tour) renderTour();
}

async function dropStop(beforeId) {
  const id = movingId;
  goBack(); // referme le mode « Déplacer »
  if (id === null) return;
  await recalculate([], { fromStart: notStarted(state.tour), place: { id, beforeId } });
}

// Met l'intervention `id` juste avant `beforeId` (null = en dernier). Elle et
// toutes celles qui la précèdent gardent désormais cet ordre (locked).
function placeStop(todo, id, beforeId) {
  const moved = todo.find((stop) => stop.id === id);
  if (!moved) return todo;
  const rest = todo.filter((stop) => stop !== moved);
  const at = rest.findIndex((stop) => stop.id === beforeId);
  const index = at < 0 ? rest.length : at;
  rest.splice(index, 0, moved);
  return rest.map((stop, i) => ({ ...stop, locked: Boolean(stop.locked) || i <= index }));
}

async function addStop(event) {
  event.preventDefault();
  const raw = $('#add-address').value.trim();
  if (!raw) return toast('Indique l’adresse de la nouvelle intervention.');
  const line = parseList(raw)[0];
  const query = line?.query ?? raw;
  busy('Recherche de l’adresse…');
  let found;
  try {
    found = await geocode(query, startPlace());
  } catch (err) {
    return toast(err.message);
  } finally {
    idle();
  }
  if (!found) return toast('Adresse introuvable. Vérifie la rue et la ville.');
  if (found.unknownCity) return toast('Ville non reconnue. Écris l’adresse avec sa ville, par exemple « 12 rue Jean Jaurès Denain ».');
  const doubt = doubtReason(query, found) || correctionNote(line ?? {}, found);
  if (doubt && !confirm(`Adresse trouvée : « ${found.label} » (${doubt}).\n\nC'est bien ça ?`)) return;
  const id = Math.max(0, ...state.tour.stops.map((stop) => stop.id)) + 1;
  const slot = $('#add-slot').value || null;
  const priority = $('#add-priority').checked || Boolean(line?.priority);
  const title = line?.title ?? raw;
  const stop = { id, raw, query, title, slot, priority, found: true, label: found.label, lat: found.lat, lon: found.lon, status: 'todo', added: true };
  if (history.state?.overlay === 'add') goBack();
  else $('#add-form').hidden = true;
  $('#add-address').value = '';
  $('#add-slot').value = '';
  $('#add-priority').checked = false;
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
  let number = 0;
  for (const stop of tour.stops) {
    const label = isLunch(stop) ? 'P' : ++number;
    const kind =
      statusOf(stop) !== 'todo' ? 'done' : stop.id === nextId ? 'next' : isLunch(stop) ? 'endpoint' : stop.priority ? 'priority' : '';
    L.marker([stop.lat, stop.lon], { icon: pin(label, kind), zIndexOffset: stop.id === nextId ? 1000 : 0 })
      .bindPopup(`<b>${label}.</b> ${esc(stop.title ?? stop.raw)}`)
      .addTo(mapLayer);
  }
  map.invalidateSize();
  const fitKey = `${tour.createdAt}/${tour.version ?? 0}`;
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
  applyUpdate();
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
  state.draft = shared;
  saveState();
  return true;
}

// ---------- Démarrage ----------

function init() {
  renderThemeButton();
  $('#toggle-theme').addEventListener('click', toggleTheme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', followPhoneTheme);
  $('#nav-back').addEventListener('click', goBack);
  window.addEventListener('popstate', onPopState);
  $('#open-settings').addEventListener('click', () => open('settings'));

  $('#open-stats').addEventListener('click', () => {
    statsView.offset = 0;
    open('stats');
  });
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
  $('#settings-form').addEventListener('submit', saveSettings);

  $('#list').addEventListener('input', onListInput);
  $('#paste').addEventListener('click', pasteFromClipboard);
  $('#photo').addEventListener('click', () => $('#scan-input').click());
  $('#scan-input').addEventListener('change', (event) => importPhotos(event.target.files));
  $('#pick-photos').addEventListener('click', () => $('#photo-input').click());
  $('#photo-input').addEventListener('change', (event) => importPhotos(event.target.files));
  for (const button of document.querySelectorAll('.view-pages')) button.addEventListener('click', openViewer);
  $('#close-viewer').addEventListener('click', goBack);
  $('#viewer-pages').addEventListener('click', (event) => {
    if (event.target.matches('img')) event.target.classList.toggle('zoomed');
  });
  removeOldPages()
    .catch(() => {})
    .then(updatePagesButtons);

  $('#clear-list').addEventListener('click', () => {
    // nouvelle liste : les pages scannées de l'ancienne ne servent plus
    clearPages()
      .catch(() => {})
      .then(updatePagesButtons);
    $('#list').value = '';
    onListInput();
    $('#list').focus();
  });
  $('#optimize').addEventListener('click', optimize);

  $('#review-list').addEventListener('click', onReviewClick);
  $('#review-list').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('input')) {
      event.target.closest('[data-id]').querySelector('[data-action=search]').click();
    }
  });
  $('#review-continue').addEventListener('click', continueReview);

  $('#tour-list').addEventListener('click', onTourClick);
  enableDragging();
  $('#tour-list').addEventListener('change', onSlotChange);
  for (const button of document.querySelectorAll('[data-agency]')) {
    button.addEventListener('click', () => setLunchAtAgency(button.dataset.agency === 'yes'));
  }
  $('#recalc').addEventListener('click', () => recalculate());
  $('#show-add').addEventListener('click', () => {
    if ($('#add-form').hidden) openOverlay('add');
    $('#add-address').focus();
  });
  $('#cancel-add').addEventListener('click', goBack);
  $('#add-form').addEventListener('submit', addStop);
  // l'heure de retour avance avec l'horloge, et se met à jour au retour de Waze / Maps
  const refreshProgress = () => {
    if (state.tour && !$('#view-tour').hidden && document.visibilityState === 'visible') renderProgress();
  };
  setInterval(refreshProgress, 60000);
  document.addEventListener('visibilitychange', refreshProgress);
  $('#new-tour').addEventListener('click', () => open('input'));

  // Démarrage : l'écran principal est la base de l'historique. Un texte partagé
  // depuis une autre appli ouvre la liste par-dessus le parcours en cours.
  const shared = receiveSharedText();
  history.replaceState({ depth: 0 }, '', location.pathname);
  render(homeView());
  if (shared && currentView === 'tour') open('input');

  if ('serviceWorker' in navigator) {
    // Quand une nouvelle version de l'appli prend le relais, on recharge pour
    // l'afficher (voir applyUpdate). Rien n'est perdu : tout est déjà
    // sauvegardé sur le téléphone.
    const isUpdate = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!isUpdate) return;
      updateReady = true;
      applyUpdate();
    });
    navigator.serviceWorker
      .register('sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        // L'appli installée reste ouverte en arrière-plan, parfois plusieurs
        // jours, sans jamais se recharger : à chaque retour dessus, on regarde
        // s'il existe une nouvelle version.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') registration.update().catch(() => {});
        });
      })
      .catch((err) => console.warn('Service worker', err));
  }
}

// ---------- Mise à jour de l'appli ----------

const VERSION_PREFIX = 'mes-interventions-v'; // nom de la copie locale de l'appli, voir sw.js
let updateReady = false;
let reloading = false;

// Une nouvelle version est prête : on recharge, mais jamais au milieu d'un
// travail (lecture d'une photo, calcul, vérification des adresses, formulaire
// ouvert). Rappelée à la fin de chacun de ces travaux.
function applyUpdate() {
  if (!updateReady || reloading || depth > 0 || !$('#busy').hidden) return;
  reloading = true;
  location.reload();
}

// Numéro de la version installée, affiché dans les réglages.
async function showVersion() {
  const names = await window.caches?.keys().catch(() => []);
  const name = names?.find((key) => key.startsWith(VERSION_PREFIX));
  $('#app-version').textContent = name ? `Version ${name.slice(VERSION_PREFIX.length)}` : '';
}

init();
