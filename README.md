# Mes interventions

Application pour téléphone (Android) qui remet dans le meilleur ordre les
interventions de la journée, pour faire le moins de route possible.

1. On scanne la « Liste des évènements par agent » (l'appareil photo s'ouvre
   directement, une page à la fois ; on peut aussi choisir des photos déjà prises) :
   le téléphone lit la feuille lui-même (Tesseract), sans envoyer la photo.
   On peut aussi coller une liste, une intervention par ligne.
2. L'appli trouve chaque adresse, toujours dans la ville écrite. Un nom de rue
   abrégé (« RUE PASTEUR » pour « Rue Louis Pasteur ») est complété
   quand la ville n'a qu'une rue de ce nom. Rien n'est changé en silence :
   chaque correction et chaque adresse douteuse est montrée, et se confirme
   d'un appui (« C'est la bonne ✓ ») ou se remplace par une autre rue
   proposée, sans rien réécrire.
3. Elle calcule l'ordre qui minimise le temps de trajet : départ du travail
   (ou du domicile), retour au domicile, rendez-vous du matin (« M ») avant
   ceux de l'après-midi (« AM »). Une intervention marquée « ★ Prioritaire »
   (bouton sur sa carte, case dans « + Ajouter », ou « ! » au début de sa
   ligne) passe en premier dans sa demi-journée ; l'appli indique la route
   que cela ajoute.
4. Elle affiche le parcours sur une carte, avec un bouton Waze / Google Maps
   par intervention, et des boutons « Fait » / « Absent » (client pas là)
   pour suivre l'avancement.
   On peut aussi placer une intervention à la main : rester appuyé sur sa
   carte, la faire glisser et la lâcher à l'endroit voulu. Elle et celles qui la
   précèdent gardent cet ordre ; le reste est retrié au mieux à partir de là.
   « Remettre l'ordre automatique » annule les placements à la main.
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

## Mettre en ligne une nouvelle version

Augmenter le numéro de version dans `sw.js` (`mes-interventions-vN`) à chaque
mise en ligne, puis `git push`. Sans ce changement, un téléphone où l'appli
est restée ouverte en arrière-plan garde l'ancienne version. Le numéro
s'affiche en bas de l'écran Réglages.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html`, `style.css` | les écrans |
| `js/app.js` | fonctionnement de l'appli (écrans, sauvegarde, carte) |
| `js/api.js` | recherche d'adresses et temps de trajet (services en ligne) |
| `js/solver.js` | calcul du meilleur ordre de passage |
| `js/sheet.js` | lecture de la photo de la feuille (colonnes, lignes, M / AM) |
| `js/pages.js` | copies des pages scannées gardées sur le téléphone (« Voir la feuille scannée ») |
| `js/address.js` | règles communes pour nettoyer les adresses (APPT, IND, téléphones…) |
| `sw.js`, `manifest.webmanifest`, `icons/` | installation sur le téléphone et mode hors-ligne |

## Services utilisés (gratuits, sans compte)

- **Géoplateforme de l'IGN** : adresse vers coordonnées GPS.
- **OSRM** (serveur de démonstration, données OpenStreetMap) : temps de trajet
  en voiture. S'il ne répond pas, l'appli estime les temps à vol d'oiseau.
- **OpenStreetMap** : fond de carte.

Bibliothèques chargées depuis cdnjs : Leaflet (carte) et Sortable
(glisser-déposer des interventions).

La lecture des photos se fait sur le téléphone (l'outil Tesseract et le
dictionnaire français sont téléchargés depuis jsDelivr la première fois).
Les adresses des interventions (sans nom ni téléphone) sont envoyées aux
services ci-dessus pour le calcul. Rien n'est enregistré ailleurs que sur le
téléphone.

Les photos et listes réelles servant aux essais vont dans `test-data/`, qui
n'est jamais envoyé sur GitHub.
