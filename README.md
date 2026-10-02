# Mes interventions

Application pour téléphone (Android) qui remet dans le meilleur ordre les
interventions de la journée, pour faire le moins de route possible.

1. On prend en photo la « Liste des évènements par agent » (une photo par page) :
   le téléphone lit la feuille lui-même (Tesseract), sans envoyer la photo.
   On peut aussi coller une liste, une intervention par ligne.
2. L'appli trouve chaque adresse et signale celles qui sont douteuses.
3. Elle calcule l'ordre qui minimise le temps de trajet : départ du travail
   (ou du domicile), retour au domicile, rendez-vous du matin (« M ») avant
   ceux de l'après-midi (« AM »).
4. Elle affiche le parcours sur une carte, avec un bouton Waze / Google Maps
   par intervention, et des boutons « Fait » / « Absent » (client pas là)
   pour suivre l'avancement.
5. En cours de journée : « Recalculer d'ici » retrie ce qui reste à partir
   de la position GPS (ou de la dernière intervention faite), et « + Ajouter »
   insère une intervention urgente puis recalcule.
6. L'heure de retour à la maison est estimée en continu (route qui reste +
   temps moyen sur place par intervention + pause déjeuner, réglables ; les
   rendez-vous de l'après-midi commencent après la pause). Interrupteur
   « Pause déjeuner à l'agence : Non | Oui » sur les écrans liste et parcours :
   avec « Oui », le parcours passe par l'agence entre le matin et
   l'après-midi (recalcul immédiat sur l'écran du parcours).
7. L'écran Statistiques montre le temps de route gagné par semaine et par
   mois (un parcours calculé compte pour sa journée).

C'est une « appli web installable » (PWA) : elle s'ouvre dans Chrome et
s'ajoute à l'écran d'accueil comme une vraie appli. Pas besoin du Play Store.

## Tester sur le PC

```
node dev-server.mjs
```

puis ouvrir http://localhost:8000

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html`, `style.css` | les écrans |
| `js/app.js` | fonctionnement de l'appli (écrans, sauvegarde, carte) |
| `js/api.js` | recherche d'adresses et temps de trajet (services en ligne) |
| `js/solver.js` | calcul du meilleur ordre de passage |
| `js/sheet.js` | lecture de la photo de la feuille (colonnes, lignes, M / AM) |
| `js/address.js` | règles communes pour nettoyer les adresses (APPT, IND, téléphones…) |
| `sw.js`, `manifest.webmanifest`, `icons/` | installation sur le téléphone et mode hors-ligne |

## Services utilisés (gratuits, sans compte)

- **Géoplateforme de l'IGN** : adresse vers coordonnées GPS.
- **OSRM** (serveur de démonstration, données OpenStreetMap) : temps de trajet
  en voiture. S'il ne répond pas, l'appli estime les temps à vol d'oiseau.
- **OpenStreetMap** : fond de carte.

La lecture des photos se fait sur le téléphone (l'outil Tesseract et le
dictionnaire français sont téléchargés depuis jsDelivr la première fois).
Les adresses des interventions (sans nom ni téléphone) sont envoyées aux
services ci-dessus pour le calcul. Rien n'est enregistré ailleurs que sur le
téléphone.

Les photos et listes réelles servant aux essais vont dans `test-data/`, qui
n'est jamais envoyé sur GitHub.
