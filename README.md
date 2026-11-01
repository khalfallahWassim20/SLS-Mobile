# SLS Mobile

Fondations d'une application de facturation pour commerciaux de distribution en Tunisie. **Projet en démarrage : prototype mobile avec données fictives uniquement. API et synchronisation ne sont pas encore implémentées ; le stockage local de démonstration n’est pas chiffré. Ne pas utiliser pour des factures réelles.**

## Organisation prévue

- `docs/regles-metier.md` : décisions et questions ouvertes.
- `packages/domain` : premier moteur TypeScript de calcul et tests.
- `apps/mobile` : prototype Android Expo ; `apps/admin` et `apps/api` : emplacements réservés.

## Démarrer

Installer Node.js 22.13 ou une version compatible plus récente et npm, puis :

```sh
npm ci
npm run check
```

Les calculs utilisent des millimes entiers et des taux en centièmes de pour cent. Les règles d'arrondi sont provisoires et doivent être validées par le comptable. Les fonctions de solde sont des fonctions pures : elles ne fournissent pas encore de persistance, contrôle d'accès ou synchronisation.

## Prototype mobile

Le prototype utilise Expo SDK 58. Lancer `npm run mobile` et ouvrir le projet avec une version d’Expo Go compatible SDK 58 sur Android. Voir `apps/mobile/README.md` pour ses limites.

## Prototype administration

Le serveur et l'espace web de gestion des clients et articles nécessitent PostgreSQL. Suivre les instructions de `apps/api/README.md` puis `apps/admin/README.md`. Ces composants sont en développement local et ne sont pas reliés au mobile ; n'y saisir aucune donnée réelle. L'import CSV et la synchronisation restent à développer.
