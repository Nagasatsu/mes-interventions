# Mes interventions

Application pour téléphone (Android) qui remet dans le meilleur ordre les
interventions de la journée, pour faire le moins de route possible.

1. On colle la liste des interventions (une par ligne).
2. L'appli trouve chaque adresse et signale celles qui sont douteuses.
3. Elle calcule l'ordre qui minimise le temps de trajet : départ du travail
   (ou du domicile), retour au domicile.
4. Elle affiche le parcours sur une carte, avec un bouton Waze / Google Maps
   par intervention et un bouton « Fait » pour suivre l'avancement.

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
| `sw.js`, `manifest.webmanifest`, `icons/` | installation sur le téléphone et mode hors-ligne |

## Services utilisés (gratuits, sans compte)

- **Géoplateforme de l'IGN** : adresse vers coordonnées GPS.
- **OSRM** (serveur de démonstration, données OpenStreetMap) : temps de trajet
  en voiture. S'il ne répond pas, l'appli estime les temps à vol d'oiseau.
- **OpenStreetMap** : fond de carte.

Les adresses des interventions sont envoyées à ces services pour le calcul.
Rien n'est enregistré ailleurs que sur le téléphone.
