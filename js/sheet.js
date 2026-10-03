// Lecture de la « Liste des évènements par agent » prise en photo.
//
// Tout se passe sur le téléphone avec Tesseract (reconnaissance de texte) :
// la photo n'est envoyée nulle part. Seul l'outil lui-même et le dictionnaire
// français sont téléchargés la première fois.
//
// Méthode : on lit tous les mots de la page avec leur position, puis on
// reconstitue le tableau. Les colonnes sont repérées par leur contenu
// (téléphones = colonne Adresse, codes « LL36C-… » = colonne Client, dates =
// colonne Date) et chaque ligne du tableau commence au niveau de sa date, de
// son n° d'évènement ou de son « M » / « AM ».

import { STREET_WORD, PHONE, cleanStreet } from './address.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
const LONG_SIDE = 3200; // taille de travail : assez grand pour les petits caractères
const COPY_LONG_SIDE = 2200; // copie gardée pour relecture : lisible, mais légère
const ANGLE_KEY = 'mes-interventions-angle';

const DATE = /\d{1,2}\/\d{2}\/\d{4}/;
const CONTRACT = /^[A-Z]{2}\d{2}[A-Z]-/; // LL36C-ICF, AR36C-MBC…
const REF = /(\d{1,2})?\s*[-–]?\s*(2\d{7})/; // « 4 - 26100001 »
const SLOT = /^(A?M)$/;
const LINKING_WORD = /(^|\s)(DE|DU|DES|LA|LE|D'|L'|ET|SAINT|STE|ST)$/; // rue coupée en fin de ligne
const PAGE_WORD = /^(RUE|APPT|IND|LISTE|EVENEMENTS|AGENT|INTERVENANT|LIBELLÉ|LIBELLE|ADRESSE|CONTRAT|BAILLEUR|PLOMBERIE|LOCATAIRE)$/i;

let workerPromise = null;
let onLog = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Impossible de charger l’outil de lecture. Vérifie la connexion internet.'));
    document.head.append(script);
  });
}

function getWorker() {
  workerPromise ??= (async () => {
    if (!window.Tesseract) await loadScript(TESSERACT_URL);
    return window.Tesseract.createWorker('fra', 1, { logger: (message) => onLog?.(message) });
  })().catch((err) => {
    workerPromise = null;
    throw err;
  });
  return workerPromise;
}

// Lit une photo de la liste. `onProgress(texte)` reçoit l'avancement.
// Renvoie les interventions trouvées sur la page (`rows`) et une copie de la
// page remise à l'endroit (`copy`, image JPEG) pour pouvoir la revoir.
export async function readSheetPhoto(file, onProgress = () => {}) {
  onLog = (message) => {
    if (message.status === 'recognizing text') onProgress(`Lecture du texte… ${Math.round(message.progress * 100)} %`);
    else if (/load/i.test(message.status)) onProgress('Préparation de l’outil de lecture…');
  };
  onProgress('Préparation de l’outil de lecture…');
  const worker = await getWorker();
  const bitmap = await createImageBitmap(file);

  // La feuille est « à l'italienne » : sur une photo prise en hauteur, elle est
  // couchée. On essaie d'abord le sens qui a marché la dernière fois.
  let angles = bitmap.height > bitmap.width ? [-90, 90] : [0, 180];
  let lastAngle = null;
  try {
    lastAngle = Number(localStorage.getItem(ANGLE_KEY));
  } catch {
    // pas de mémoire disponible
  }
  if (angles.includes(lastAngle)) angles = [lastAngle, ...angles.filter((a) => a !== lastAngle)];

  let best = null;
  for (const angle of angles) {
    const canvas = prepareImage(bitmap, angle);
    const lines = await recognizeLines(worker, canvas);
    const score = orientationScore(lines);
    if (!best || score > best.score) best = { angle, canvas, lines, score };
    if (score >= 8) break;
  }
  try {
    localStorage.setItem(ANGLE_KEY, String(best.angle));
  } catch {
    // pas grave
  }

  const sheet = parseSheet(best.lines, best.canvas.width);
  onProgress('Lecture des « M » / « AM »…');
  await readMissingSlots(worker, best.canvas, sheet);
  onLog = null;
  return { rows: sheet.rows, copy: await readableCopy(bitmap, best.angle) };
}

// Dessine la photo tournée de `angle` degrés, avec son grand côté à `longSide`
// pixels (jamais agrandie si `enlarge` est faux).
function rotatedCanvas(bitmap, angle, longSide, enlarge) {
  const sideways = angle % 180 !== 0;
  const width0 = sideways ? bitmap.height : bitmap.width;
  const height0 = sideways ? bitmap.width : bitmap.height;
  const ratio = longSide / Math.max(width0, height0);
  const scale = enlarge ? ratio : Math.min(1, ratio);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width0 * scale);
  canvas.height = Math.round(height0 * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.drawImage(bitmap, (-bitmap.width * scale) / 2, (-bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

// Pour la lecture : photo agrandie, puis passée en noir et blanc avec un seuil
// local, pour effacer les ombres.
function prepareImage(bitmap, angle) {
  const canvas = rotatedCanvas(bitmap, angle, LONG_SIDE, true);
  adaptiveThreshold(canvas.getContext('2d'), canvas.width, canvas.height, Math.round(LONG_SIDE / 160));
  return canvas;
}

// Pour la relecture par Pierre : la page à l'endroit, en couleurs, allégée.
function readableCopy(bitmap, angle) {
  const canvas = rotatedCanvas(bitmap, angle, COPY_LONG_SIDE, false);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
}

// Un pixel devient noir s'il est nettement plus sombre que la moyenne de son voisinage.
function adaptiveThreshold(ctx, width, height, radius, k = 0.12) {
  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 1; y <= height; y++) {
    let rowSum = 0;
    for (let x = 1; x <= width; x++) {
      rowSum += gray[(y - 1) * width + x - 1];
      integral[y * stride + x] = integral[(y - 1) * stride + x] + rowSum;
    }
  }
  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width, x + radius + 1);
      const sum =
        integral[bottom * stride + right] - integral[top * stride + right] - integral[bottom * stride + left] + integral[top * stride + left];
      const mean = sum / ((right - left) * (bottom - top));
      const value = gray[y * width + x] < mean * (1 - k) ? 0 : 255;
      const i = (y * width + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = value;
    }
  }
  ctx.putImageData(image, 0, 0);
}

async function recognizeLines(worker, canvas) {
  await worker.setParameters({ tessedit_pageseg_mode: '3', tessedit_char_whitelist: '' });
  const { data } = await worker.recognize(canvas, {}, { blocks: true });
  return (data.blocks ?? []).flatMap((block) =>
    block.paragraphs.flatMap((paragraph) =>
      paragraph.lines.map((line) => ({
        baseline: line.baseline,
        words: line.words.map((word) => ({ text: word.text, conf: word.confidence, ...word.bbox })),
      })),
    ),
  );
}

// Nombre de mots attendus sur cette feuille : sert à savoir si la photo est dans le bon sens.
function orientationScore(lines) {
  return lines
    .flatMap((line) => line.words)
    .filter((word) => word.conf > 50 && (PAGE_WORD.test(cleanWord(word.text)) || DATE.test(word.text) || word.text.match(PHONE)))
    .length;
}

const cleanWord = (text) => text.replace(/[|“”"«»_~]/g, '').trim();

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// Regroupe des valeurs proches ; renvoie les groupes, du plus fourni au moins fourni.
function clusters(values, tolerance) {
  const groups = [];
  for (const value of [...values].sort((a, b) => a - b)) {
    const last = groups.at(-1);
    if (last && value - last.at(-1) <= tolerance) last.push(value);
    else groups.push([value]);
  }
  return groups.sort((a, b) => b.length - a.length);
}

// Reconstitue le tableau à partir des mots et de leur position.
// Exportée à part pour pouvoir la tester sans photo.
export function parseSheet(lines, width) {
  // Inclinaison de la photo : pente médiane des lignes de texte. On « redresse »
  // les positions pour que les mots d'une même ligne du tableau soient alignés.
  const slope =
    median(
      lines
        .map((line) => line.baseline)
        .filter((b) => b && b.x1 - b.x0 > width * 0.05)
        .map((b) => (b.y1 - b.y0) / (b.x1 - b.x0)),
    ) ?? 0;
  const words = lines
    .flatMap((line) => line.words)
    .map((word) => ({ ...word, text: cleanWord(word.text) }))
    // l'outil donne souvent une confiance très basse aux nombres pourtant bien lus :
    // on garde les mots peu sûrs quand leur forme est reconnaissable
    .filter((word) => word.text && (word.conf > 10 || /\d{4,}|^A?M$|^\d{1,2}[-–]$/.test(word.text)))
    .map((word) => ({ ...word, y: (word.y0 + word.y1) / 2 - word.x0 * slope, h: word.y1 - word.y0 }));
  const h = median(words.map((word) => word.h)) ?? 20;

  // Colonne Adresse : là où commencent les numéros de téléphone.
  const phoneX = words.filter((w) => w.text.match(PHONE)).map((w) => w.x0);
  const streetX = words
    .filter((w) => /^(RUE|AVENUE|IMPASSE|ALLEE|ALLÉE|CHEMIN|PLACE|ROUTE|RESIDENCE|RÉSIDENCE|CITE|CITÉ)$/i.test(w.text))
    .map((w) => {
      const before = words.filter((o) => Math.abs(o.y - w.y) < h * 0.6 && o.x0 < w.x0 && w.x0 - o.x0 < width * 0.05);
      return Math.min(w.x0, ...before.map((o) => o.x0));
    });
  const addressLeft = Math.min(...(clusters(phoneX.length ? phoneX : streetX, width * 0.015)[0] ?? [width * 0.3]));
  // Colonne Client : codes de contrat (« LL36C-ICF… »).
  const clientLeft =
    median(clusters(words.filter((w) => CONTRACT.test(w.text) && w.x0 > addressLeft).map((w) => w.x0), width * 0.015)[0] ?? []) ??
    addressLeft + width * 0.135;
  // Colonne Date : le groupe de dates le plus fourni, à droite de la colonne Client.
  const dateWords = words.filter((w) => DATE.test(w.text) && w.x0 > clientLeft);
  const dateLeft = median(clusters(dateWords.map((w) => w.x0), width * 0.02)[0] ?? []) ?? clientLeft + width * 0.11;
  const tableDates = dateWords.filter((w) => Math.abs(w.x0 - dateLeft) < width * 0.03);
  // case « Rdv » : juste après la date (mesuré sur la feuille : de 7,5 % à 12,2 % de la largeur après le début de la date)
  const slotLeft = dateLeft + width * 0.075;
  const slotRight = dateLeft + width * 0.122;
  // Colonne Libellé : n° d'évènement à 8 chiffres, à gauche des adresses.
  const refWords = words.filter((w) => w.x0 < addressLeft && /^[-–]?2\d{7}$|^\d{1,2}[-–]2\d{7}$/.test(w.text));
  const libelleLeft = (median(refWords.map((w) => w.x0)) ?? addressLeft - width * 0.16) - width * 0.03;
  const slotWords = words.filter((w) => SLOT.test(w.text) && w.x0 >= slotLeft && w.x0 < slotRight);

  // Début de chaque ligne du tableau : dates, n° d'évènement, « M » / « AM »,
  // et (une ligne au-dessus) les téléphones.
  const anchors = [
    ...tableDates.map((w) => w.y),
    ...refWords.map((w) => w.y),
    ...slotWords.map((w) => w.y),
    ...words.filter((w) => w.text.match(PHONE) && Math.abs(w.x0 - addressLeft) < width * 0.015).map((w) => w.y - h * 1.4),
  ];
  const tops = clusters(anchors, h * 1.3)
    .map((group) => group[0])
    .sort((a, b) => a - b);
  const footer = Math.min(...words.filter((w) => /^(Editée|Éditée|Page)$/i.test(w.text)).map((w) => w.y), Infinity);

  const refFor = (top) =>
    refWords.filter((w) => Math.abs(w.y - top) < h * 2).sort((a, b) => Math.abs(a.y - top) - Math.abs(b.y - top))[0];

  const rows = tops.map((top, i) => {
    const from = top - h * 0.7;
    const to = Math.min(tops[i + 1] !== undefined ? tops[i + 1] - h * 0.7 : Infinity, footer - h);
    const inRow = words.filter((w) => w.y >= from && w.y < to);
    const addressLines = textLines(inRow.filter((w) => w.x0 >= addressLeft - width * 0.01 && w.x0 < clientLeft - width * 0.005), h);
    const refWord = refFor(top);
    const libelleLines = textLines(
      inRow.filter((w) => w !== refWord && w.x0 >= libelleLeft && w.x0 < addressLeft - width * 0.01),
      h,
    );
    const slot = inRow.find((w) => SLOT.test(w.text) && w.x0 >= slotLeft && w.x0 < slotRight)?.text ?? null;
    return {
      ...parseAddressCell(addressLines),
      ...parseLibelle(libelleLines, refWord),
      slot,
      slotBox: { x0: slotLeft, x1: slotRight, y0: top - h * 0.6, y1: top + h * 1.8 },
    };
  });
  return {
    rows: rows.filter((row) => row.address),
    slope,
    debug: { h, slope, addressLeft, clientLeft, dateLeft, libelleLeft, slotLeft, tops: tops.map(Math.round) },
  };
}

// Mots → lignes de texte, de haut en bas.
function textLines(words, h) {
  const groups = [];
  for (const word of [...words].sort((a, b) => a.y - b.y)) {
    const group = groups.find((g) => Math.abs(g.y - word.y) < h * 0.75);
    if (group) group.words.push(word);
    else groups.push({ y: word.y, words: [word] });
  }
  return groups.map((g) => g.words.sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(' '));
}

// Case « Adresse » : NOM / téléphone(s) / rue / [résidence] / VILLE.
export function parseAddressCell(lines) {
  const phones = [];
  const rest = [];
  for (const line of lines) {
    phones.push(...(line.match(PHONE) ?? []).map((phone) => phone.replace(/\D/g, '')));
    const text = line.replace(PHONE, ' ').replace(/\s[-–]\s*$/, '').replace(/\s+/g, ' ').trim();
    // sur cette feuille tout est en majuscules : une ligne sans mot de 3 majuscules est un parasite
    if (/\p{Lu}{3,}/u.test(text)) rest.push(text);
  }
  // la 1re ligne est normalement le nom ; si le nom n'a pas été lu, la rue peut être en 1re ligne
  let streetIndex = rest.findIndex((line, i) => i > 0 && STREET_WORD.test(line));
  if (streetIndex === -1 && STREET_WORD.test(rest[0] ?? '')) streetIndex = 0;
  if (streetIndex === -1) {
    // rue non reconnue : on tente tout sauf le nom
    return { name: rest[0] ?? '', phones, address: cleanStreet(rest.slice(1).join(' ')) };
  }
  let street = rest[streetIndex];
  let next = streetIndex + 1;
  // nom de rue coupé en fin de ligne (« RUE DU GENERAL DE » / « GAULLE »)
  while (next < rest.length - 1 && LINKING_WORD.test(street)) street += ` ${rest[next++]}`;
  // dernière ligne = ville ; les lignes entre la rue et la ville (TOUR X, résidence) sont ignorées
  const city = rest.length - 1 >= next ? rest[rest.length - 1] : '';
  const name = cleanStreet(rest.slice(0, streetIndex).join(' '));
  return { name, phones, address: cleanStreet(`${street} ${city}`) };
}

// Case « Libellé » : « 4 - 26100001 » puis le type d'intervention.
function parseLibelle(lines, refWord) {
  let text = lines.join(' ').replace(/\s+/g, ' ').trim();
  let num = null;
  let ref = null;
  const fromWord = refWord?.text.match(REF);
  if (fromWord) {
    ref = fromWord[2];
    if (fromWord[1]) num = Number(fromWord[1]);
  }
  const inText = text.match(REF);
  if (inText) {
    ref ??= inText[2];
    if (inText[1]) num ??= Number(inText[1]);
    text = text.slice(inText.index + inText[0].length);
  }
  // « 4 - » lu comme des mots à part, avant le n° à 8 chiffres
  const lead = text.match(/^\s*(\d{1,2})\s*[-–]\s*/);
  if (lead) {
    num ??= Number(lead[1]);
    text = text.slice(lead[0].length);
  }
  const label = text
    .replace(/[[\]|;!+*_~«»“”]/g, ' ') // traits du tableau et taches lus comme des signes
    .replace(/(^|\s)[^\p{L}\d\s]+(?=\s|$)/gu, ' ') // « mots » sans lettre ni chiffre
    .replace(/(\s+\S{1,2})+$/, '') // débris en fin de libellé
    .replace(/^(\s*\S{1,2}\s)+/, '') // et au début (reste du n° mal lu, « Ja »)
    .replace(/^[\s:–-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { num, ref, label: label.slice(0, 80) };
}

// Deuxième lecture, ciblée sur la case « Rdv » des lignes où le « M » / « AM »
// n'a pas été lu (petits caractères isolés, souvent ignorés à la première lecture).
async function readMissingSlots(worker, canvas, sheet) {
  const missing = sheet.rows.filter((row) => !row.slot);
  if (!missing.length) return;
  await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: 'AM' });
  try {
    for (const row of missing) {
      const box = row.slotBox;
      const xMid = (box.x0 + box.x1) / 2;
      const top = Math.max(0, Math.round(box.y0 + xMid * sheet.slope));
      const rectangle = {
        left: Math.round(box.x0),
        top,
        width: Math.round(Math.min(box.x1, canvas.width) - box.x0),
        height: Math.round(Math.min(box.y1 - box.y0, canvas.height - top)),
      };
      if (rectangle.width < 10 || rectangle.height < 10 || !hasInk(canvas, rectangle)) continue;
      const { data } = await worker.recognize(canvas, { rectangle });
      const letters = data.text.replace(/[^AM]/g, '');
      if (letters.includes('AM')) row.slot = 'AM';
      else if (letters === 'M') row.slot = 'M';
    }
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: '3', tessedit_char_whitelist: '' });
  }
}

// La case contient-elle quelque chose (et pas seulement du blanc) ?
function hasInk(canvas, { left, top, width, height }) {
  const data = canvas.getContext('2d').getImageData(left, top, width, height).data;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark++;
  return dark / (width * height) > 0.01;
}
