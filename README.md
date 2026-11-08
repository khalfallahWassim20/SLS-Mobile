# SLS Mobile

Fondations d'une application de facturation pour commerciaux de distribution en Tunisie. **Prototype en développement, uniquement avec des données fictives. Le stockage mobile n'est pas chiffré et les échanges HTTP locaux ne sont pas sécurisés. Ne pas utiliser pour des factures réelles.**

## Organisation prévue

- `docs/regles-metier.md` : décisions et questions ouvertes.
- `packages/domain` : premier moteur TypeScript de calcul et tests.
- `apps/mobile` : prototype Android Expo ; `apps/admin` et `apps/api` : administration web et serveur PostgreSQL.

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

Le serveur et l'espace web de gestion des clients et articles nécessitent PostgreSQL. Suivre les instructions de `apps/api/README.md` puis `apps/admin/README.md`. Ces composants sont en développement local et reliés au mobile pour les essais ; n'y saisir aucune donnée réelle. L'import CSV est reporté.


## Essai de la clôture individuelle

La migration ne change pas automatiquement le mode de synchronisation. Avant d'activer le mode individuel :

1. Mettre à jour le serveur, l'administration et **tous les téléphones**, puis exécuter `npm run migrate` avec la base de test configurée. Conserver Expo Go et les données locales.
2. En ancien mode, envoyer toutes les ventes, les règlements et les versions du journal sur chaque téléphone. Vérifier que les files sont vides et que les anciennes données sans identifiant ont été rapprochées. Un téléphone hors ligne est invisible au serveur ; ne pas activer si un appareil n'a pas été vérifié.
3. Dans l'administration, créer un identifiant pour chaque commercial actif. Ouvrir « Tournées identifiées », lire l'avertissement, confirmer les vérifications puis activer le mode individuel. **Cette bascule est définitive.** Une opération ancienne non envoyée ne peut plus être synchronisée automatiquement ; elle doit être conservée pour rapprochement.
4. Sur chaque téléphone, ouvrir « Données de l'administration » puis « Connexion commercial ». Se connecter individuellement avec le compte correspondant. Le téléphone est lié à ce commercial et à ce serveur ; le mot de passe et la session ne sont pas enregistrés.
5. Au journal, synchroniser toutes les opérations puis clôturer. Une demande perdue peut être renvoyée sans créer de doublon. Dans l'administration, sélectionner le commercial et la date pour consulter ou rouvrir sa journée. Après réouverture, actualiser l'état de la journée sur le téléphone.

Un appareil hors ligne peut ne pas connaître une clôture faite ailleurs. Le serveur refusera alors les nouvelles écritures pour la journée fermée ; elles resteront en attente et nécessiteront un rapprochement ou une réouverture administrative. Les exports PDF/CSV et une interface complète de résolution des conflits ne sont pas encore disponibles. Voir `docs/journal-tournee.md`.
