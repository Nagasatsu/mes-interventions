// Règles communes pour reconnaître, nettoyer et comparer les adresses, que la
// liste soit collée à la main ou lue sur une photo.

// Mots qui signalent une rue (« Rue de la… », « Allée… »).
export const STREET_WORD =
  /(^|[^\p{L}])(rue|avenue|av|bd|boulevard|chemin|allée|allee|impasse|place|route|rte|quai|cours|square|lotissement|lieu-dit|résidence|residence|chaussée|chaussee|voie|hameau|faubourg|zac|za|zi|cité|cite|passage|rond-point|esplanade|promenade|clos|domaine|sentier)(?![\p{L}])/iu;

// Numéro de téléphone : 06/12/34/56/78, 06.12.34.56.78, 06 12 34 56 78…
export const PHONE = /(?<!\d)0[1-9](?:[\s./-]?\d{2}){4}(?!\d)/g;

export const formatPhone = (digits) => digits.replace(/\D/g, '').replace(/(\d{2})(?=\d)/g, '$1 ');

// Retire ce qui gêne la recherche d'adresse :
// « APPT 17 » (numéro d'appartement, pas de rue), la lettre de bâtiment devant
// (« D APPT 17 »), « IND », « BAT C », « ESC 2 », « ETAGE 3 »…
export function cleanStreet(text) {
  return text
    .replace(/(^|\s)(?:[A-Z]\s*'?\s*)?APP?T\.?\s*(?:N°|NO)?\s*\d+[A-Z]?(?=\s|$)/gi, ' ')
    .replace(/(^|\s)IND(?=\s|$)/gi, ' ')
    .replace(/(^|\s)(?:BAT|BATIMENT|BÂTIMENT|ESC|ESCALIER|ETG|ETAGE|ÉTAGE|PORTE)\.?\s*\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Zéro lu à la place d'un O au milieu d'un mot (« MERIC0URT ») : faute
// classique de la lecture de photo.
export const fixZeros = (text) => text.replace(/(?<=\p{L}{2})0(?=\p{L}{2})/gu, 'O');

// La ville écrite en premier (« Denain 12 rue Jean Jaurès ») est remise à la
// fin : le service d'adresses s'y perd sinon et répond dans toute la France.
export function cityLast(query) {
  const starts = [query.search(/\d/), query.search(STREET_WORD)].filter((index) => index >= 0);
  if (!starts.length) return query;
  const cut = Math.min(...starts);
  const before = query.slice(0, cut).replace(/[\s,;:-]+$/, '').trim();
  if (!/\p{L}{3,}/u.test(before)) return query;
  return `${query.slice(cut).replace(/^[\s,;:-]+/, '').trim()} ${before}`;
}

// ---------- Comparaison entre l'adresse demandée et l'adresse trouvée ----------

// Mots qui ne permettent pas de reconnaître une rue ou une ville (« Rue de la… »).
export const GENERIC_WORDS = new Set(
  ('rue avenue boulevard place chemin allee impasse route quai cours square lotissement residence ' +
    'chaussee voie hameau faubourg cite passage esplanade promenade clos domaine sentier rond point ' +
    'de du des la le les l d et aux au en sur sous saint sainte st ste bis ter').split(' '),
);
const ABBREVIATIONS = { gal: 'general', gen: 'general', mal: 'marechal', pdt: 'president', cdt: 'commandant', dr: 'docteur', pr: 'professeur' };

// Texte → mots en minuscules, sans accents ni ponctuation.
export const words = (text) =>
  text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

// Mots qui identifient une rue ou une ville : sans les mots passe-partout
// (« rue de la… ») ni les numéros, abréviations développées.
export const nameWords = (text) =>
  words(text ?? '')
    .map((w) => ABBREVIATIONS[w] ?? w)
    .filter((w) => !GENERIC_WORDS.has(w) && !/^\d+$/.test(w));

// Mots du nom de rue demandé : ceux de la demande, sans la ville écrite à la fin.
export function askedStreet(query, city) {
  const asked = nameWords(query);
  const cityWords = nameWords(city);
  let end = asked.length;
  for (let n = 0; n < cityWords.length && end > 0 && cityWords.includes(asked[end - 1]); n++) end--;
  return asked.slice(0, end);
}

// Nombre de lettres à changer, ajouter ou enlever pour passer d'un texte à
// l'autre (« salaumine » → « sallaumines » : 2). Sert à repérer une faute de frappe.
export function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

// Type de voie, abréviations comprises : « rue », « avenue », « place »…
const STREET_TYPES = {
  rue: 'rue', avenue: 'avenue', av: 'avenue', boulevard: 'boulevard', bd: 'boulevard', place: 'place', pl: 'place',
  chemin: 'chemin', che: 'chemin', allee: 'allee', impasse: 'impasse', imp: 'impasse', route: 'route', rte: 'route',
  square: 'square', quai: 'quai', cours: 'cours', residence: 'residence', cite: 'cite', sentier: 'sentier',
  passage: 'passage', hameau: 'hameau', faubourg: 'faubourg', clos: 'clos', domaine: 'domaine',
};
export const streetType = (text) => words(text).map((w) => STREET_TYPES[w]).find(Boolean);

// Ce que l'adresse trouvée a en commun avec la demande :
// - street : les mots importants du nom de rue trouvé étaient dans la demande ;
// - city : la ville trouvée (ou son code postal) était dans la demande ;
// - type : même type de voie (rue / avenue / place…), quand les deux en ont un.
// Le service d'adresses renvoie toujours quelque chose, même quand la rue
// n'existe pas dans la ville demandée : il prend alors une rue au nom proche,
// parfois dans une autre ville. Ces trois vérifications servent à le repérer.
export function compare(query, found) {
  const asked = new Set(words(query).map((w) => ABBREVIATIONS[w] ?? w));
  const cityWords = nameWords(found.city);
  const askedType = streetType(query);
  const foundType = streetType(found.street ?? '');
  return {
    street: nameWords(found.street).every((w) => asked.has(w)),
    city: Boolean(found.postcode && query.includes(found.postcode)) || (cityWords.length > 0 && cityWords.every((w) => asked.has(w))),
    type: !askedType || !foundType || askedType === foundType,
  };
}
