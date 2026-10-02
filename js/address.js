// Règles communes pour reconnaître et nettoyer les adresses, que la liste
// soit collée à la main ou lue sur une photo.

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
