# SLS Mobile

Fondations d'une application de facturation pour commerciaux de distribution en Tunisie. **Projet en démarrage : prototype mobile avec données fictives uniquement. API et synchronisation ne sont pas encore implémentées ; le stockage local de démonstration n’est pas chiffré. Ne pas utiliser pour des factures réelles.**

## Organisation prévue

- `docs/regles-metier.md` : décisions et questions ouvertes.
- `packages/domain` : premier moteur TypeScript de calcul et tests.
- `apps/mobile` : prototype Android Expo ; `apps/admin` et `apps/api` : emplacements réservés.

## Démarrer

Installer Node.js 22 et npm, puis :

```sh
npm ci
npm run check
```

Les calculs utilisent des millimes entiers et des taux en centièmes de pour cent. Les règles d'arrondi sont provisoires et doivent être validées par le comptable. Les fonctions de solde sont des fonctions pures : elles ne fournissent pas encore de persistance, contrôle d'accès ou synchronisation.

## Prototype mobile

Lancer `npm run mobile` et ouvrir le projet avec Expo Go sur Android. Voir `apps/mobile/README.md` pour ses limites.
