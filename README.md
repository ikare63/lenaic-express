# Lénaïc Express

Un journal personnel hébergé sur GitHub Pages.

## Ce que contient le dépôt

- `index.html` : structure de l'interface
- `style.css` : design « une de journal »
- `app.js` : affichage, filtres, recherche, favoris et personnalisation locale
- `sources.json` : sources RSS et recherches Google News
- `preferences.json` : thèmes, mots-clés et poids du classement
- `scripts/fetch_news.py` : récupération, dédoublonnage et classement des articles
- `data/actualites.json` : édition lue par le site
- `.github/workflows/update-news.yml` : mise à jour automatique toutes les 2 heures

## Mise en ligne sur GitHub

1. Crée un dépôt, par exemple `lenaic-express`.
2. Envoie **le contenu** de ce dossier à la racine du dépôt.
3. Dans GitHub : `Settings` → `Pages`.
4. Dans `Build and deployment`, choisis `Deploy from a branch`.
5. Branche : `main`, dossier : `/ (root)`, puis `Save`.
6. Va dans `Actions` → `Mettre à jour Lénaïc Express` → `Run workflow` pour générer immédiatement une édition fraîche.

Le workflow s'exécute ensuite automatiquement toutes les deux heures.

## Personnaliser le fil

### Ajouter une recherche d'actualités

Dans `sources.json` :

```json
{
  "id": "mon-sujet",
  "name": "Mon sujet",
  "type": "google_news",
  "query": "\"expression exacte\" OR autre mot",
  "category": "genealogie",
  "priority": 4,
  "enabled": true
}
```

### Ajouter un vrai flux RSS/Atom

```json
{
  "id": "ma-source",
  "name": "Nom du média",
  "type": "rss",
  "url": "https://exemple.fr/feed.xml",
  "category": "histoire",
  "priority": 3,
  "enabled": true
}
```

### Changer les centres d'intérêt

Modifie `preferences.json`. Plus le `weight` d'une catégorie ou d'un mot-clé est élevé, plus l'article remonte dans l'édition.

Les boutons « Plus comme ça », « Moins comme ça », favoris et masquages du site sont enregistrés dans `localStorage` : ils restent privés dans le navigateur et ne modifient pas le dépôt.

## Remarque sur le fichier de départ

`data/actualites.json` contient quelques articles réels repérés lors de la création du projet afin que le site ne soit pas vide avant le premier lancement du workflow. Dès que l'Action est exécutée, le fichier est recalculé à partir des sources.
