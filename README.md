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
4. Sur chaque téléphone, ouvrir « Données de l'administration » puis « Connexion commercial ». Se connecter individuellement avec le compte correspondant. Le téléphone est lié à ce commercial et à ce serveur ; le mot de passe n’est pas enregistré. La session est conservée dans le stockage sécurisé du téléphone jusqu’à minuit, heure de Tunisie, et restaurée automatiquement le même jour.
5. Au journal, synchroniser toutes les opérations puis clôturer. Une demande perdue peut être renvoyée sans créer de doublon. Dans l'administration, sélectionner le commercial et la date pour consulter ou rouvrir sa journée. Après réouverture, actualiser l'état de la journée sur le téléphone.

Un appareil hors ligne peut ne pas connaître une clôture faite ailleurs. Le serveur refusera alors les nouvelles écritures pour la journée fermée ; elles resteront en attente et nécessiteront un rapprochement ou une réouverture administrative. Les exports PDF/CSV et une interface complète de résolution des conflits ne sont pas encore disponibles. Voir `docs/journal-tournee.md`.

## Nettoyer les opérations fictives avant un nouveau test

**Destructif et irréversible.** Utiliser uniquement sur la base de test et après avoir vérifié son adresse dans `apps/api/.env`. Faire une sauvegarde si nécessaire. Les ventes, modifications, factures de journal, paiements, demandes de synchronisation et clôtures sont supprimés ; les clients, articles, commerciaux, identifiants, soldes initiaux, limites, mode de synchronisation et journal d'audit administratif sont conservés. Le solde client redevient son solde initial, qui n'est pas forcément zéro. L'identité déjà liée à un téléphone est conservée.

1. Mettre à jour le projet et ouvrir la nouvelle version dans Expo Go sur **chaque téléphone**, sans désinstaller Expo Go. Placer chaque téléphone en mode avion une fois l'application ouverte et ne plus saisir ni synchroniser d'opérations.
2. Sur chaque téléphone : « Autres fonctions » → « Historique local » → « Nettoyer les opérations fictives de ce téléphone » et confirmer deux fois. Cela supprime aussi les opérations non envoyées et efface le cache de référence local. Garder les téléphones déconnectés jusqu'à la fin du nettoyage du serveur.
3. Arrêter l'API et toute autre application qui écrit dans la base (PostgreSQL doit rester démarré). Depuis la racine du projet, après migration, exécuter :

```sh
npm run reset:test-operations -- EFFACER_LES_OPERATIONS_FICTIVES
```

4. Redémarrer l'API puis reconnecter les téléphones nettoyés. Actualiser les données (ou se reconnecter au commercial si le mode individuel est actif). Vérifier le journal et les soldes avant de créer le nouveau scénario.

Il faut nettoyer **tous** les appareils avant de reprendre : un téléphone oublié pourrait renvoyer d'anciennes opérations après le nettoyage du serveur. L'outil ne peut pas vérifier les téléphones hors ligne. En cas d'échec, ne pas reprendre les tests avant d'avoir identifié l'étape en cause ; aucune suppression n'est faite automatiquement lors de la mise à jour.

### Session quotidienne du commercial

Après mise à jour de l’API et du mobile, le commercial se connecte en ligne avec son compte. Son jeton est enregistré avec Expo SecureStore, sans enregistrer le mot de passe, et expire à minuit (début du jour suivant) en heure de Tunisie selon l’horloge du serveur. L’application tente de le restaurer automatiquement avant cette échéance, même sans réseau ; la révocation ou la désactivation ne peut être confirmée par le serveur qu’au prochain échange. Après minuit, une nouvelle connexion en ligne est nécessaire pour synchroniser ou clôturer, mais les opérations locales restent accessibles hors ligne pour l’identité déjà liée. Une erreur de stockage sécurisé peut imposer une nouvelle connexion après fermeture : le mobile l’indique. Ne pas désinstaller Expo Go ni effacer ses données pour tester.

La date et l’heure automatiques du téléphone et du serveur doivent être correctes. Une horloge locale erronée peut empêcher la restauration ou afficher un état périmé ; le serveur contrôle la validité et la révocation à chaque requête. En hors ligne, il est impossible de vérifier la révocation ou une clôture distante. HTTP, SQLite non chiffré et autres limites rendent cette version réservée aux données fictives et au réseau privé de test.

## Raccordement v5 pour test isolé uniquement

Les espaces v5 mobile, serveur et administration sont désormais raccordés **derrière trois options explicites**. La version normale reste inchangée. Ce n'est pas une activation de production : utiliser exclusivement une **base PostgreSQL distincte contenant des données fictives**, ainsi qu'un téléphone de test dont les données ont été préservées. Ne pas basculer une base ou un téléphone utilisé pour d'autres essais sans sauvegarde et vérification de toutes les files. Ne jamais supprimer des données pour débloquer un conflit.

Pour un environnement d'essai préparé séparément, les variables suivantes doivent être présentes **au démarrage** des trois composants :

- API : `SLS_V5_TEST_ONLY=DONNEES_FICTIVES_ISOLEES`
- Expo : `EXPO_PUBLIC_SLS_V5_TEST_ONLY=DONNEES_FICTIVES_ISOLEES`
- Vite admin : `VITE_SLS_V5_TEST_ONLY=DONNEES_FICTIVES_ISOLEES`

Redémarrer les processus après modification des variables ; Expo et Vite intègrent leurs variables dans le bundle. Le mode individuel doit déjà être activé sur cette base de test suivant la procédure de la section précédente. La bascule individuelle reste irréversible et ne vérifie pas les appareils hors ligne. Le téléphone vérifie son identité et la référence v5 avant la liaison ; il conserve les opérations existantes et refuse la migration si ses anciennes files sont en attente. Le travail hors ligne reste possible après expiration de session, la synchronisation nécessite une reconnexion.

L'espace d'administration v5 regroupe les soldes, avoirs, historiques, journaux, exports et réouverture. Les vues anciennes ne doivent pas être utilisées pour interpréter des avoirs. Les remboursements de modifications distantes et les avoirs refusés peuvent encore nécessiter un rapprochement manuel et bloquer le client ou la clôture. Les parcours n'ont pas encore été validés sur un téléphone réel : ne pas interpréter un export Android ou des tests automatisés comme un essai physique réussi. Les descriptions plus anciennes ci-dessous ou dans les documents qui indiquent « non monté » correspondent à l'état antérieur à ce raccordement de test.

Dans l'essai v5, une demande d'avoir en attente peut être vérifiée puis abandonnée en ligne depuis la tournée. Le serveur refuse cet abandon si l'avoir a déjà été reçu ; une demande réellement abandonnée est archivée, sans supprimer la facture. Un versement physique éventuel reste à vérifier séparément. Si la facture n'a jamais été synchronisée, l'abandon sécurisé nécessite d'abord un rapprochement. Relancer `npm run migrate` sur la **base de test isolée** avant d'essayer cette fonctionnalité.

**Journal mobile v5 expérimental :** le paiement initial de la vente est compté le jour de sa création ; les remboursements de modification sont déduits le jour où ils ont été enregistrés sur le téléphone, y compris sans vente ce jour-là. Les modifications importées sont vérifiées mais leurs remboursements ne sont pas imputés à ce téléphone. Des historiques incomplets ou incohérents bloquent le journal. Le serveur garde encore certaines clôtures entre jours ou commerciaux : ne pas utiliser ces parcours en production avant vérification complète et essai sur téléphone. Le suivi ne prouve pas le versement physique.

Les tests automatisés sur PostgreSQL incluent les courses entre clôture et remboursement par un autre commercial, ainsi que la reprise exacte de l’opération gagnante. La clôture des remboursements de modification entre jours ou commerciaux reste volontairement bloquée, même avec une preuve de caisse concordante. Un marqueur de révision locale ambigu ou une date illisible bloque aussi l’export au lieu d’attribuer le remboursement au hasard.

**Comparaison de test des ventes :** dans la tournée v5, le bouton « Comparer ventes et remboursements » vérifie en ligne, opération par opération, les paiements initiaux et les remboursements du téléphone face aux données reçues pour le même commercial et jour. Il signale notamment une opération d’un autre téléphone utilisant le même compte. Il ne compare ni avoirs, ni préétablies, ni règlements d’ancienne dette ; le résultat est une lecture ponctuelle, pas une preuve de paiement ni une autorisation de clôture. Synchroniser d’abord et faire vérifier les écarts. La garde des clôtures entre jours/commerciaux reste active.

**Avoirs et caisse v5 :** l’annulation reste dans le journal du propriétaire de la facture, mais un remboursement enregistré par un commercial est déduit de la caisse de ce commercial, à la date de l’avoir. Un remboursement saisi par l’administrateur reste non attribué jusqu’à une décision explicite dans le journal du propriétaire : choisir la caisse administrative ou celle d’un commercial après vérification du versement. L’attribution est définitive, tracée et ne verse pas d’argent. Tant qu’elle manque, les clôtures de cette date sont bloquées ; une attribution à la caisse administrative lève ce blocage, tandis que la clôture de la caisse commerciale choisie exige une preuve correspondant aux attributions reçues sur le téléphone. Si une journée commerciale est déjà clôturée à cette date, un nouveau remboursement saisi par l’administrateur est refusé. Cette mesure est volontairement restrictive et ne prouve pas que l’argent a été versé. Les anciens exports peuvent être périmés.

La référence v5 transmet aussi les attributions vérifiées au téléphone. Après synchronisation, son journal et ses exports déduisent séparément les remboursements administrateur attribués à ce commercial ; hors ligne, des décisions plus récentes peuvent manquer. Un ancien cache sans attribution affiche un avertissement. Lors de la clôture v5, la liste des remboursements administrateur est figée sur le téléphone puis comparée côté serveur sous verrou ; une liste périmée est refusée. En cas de conflit, un abandon confirmé par le serveur réserve définitivement l’identifiant de la demande avant une nouvelle tentative. La clôture v5 exige désormais aussi une empreinte des ventes, de leurs versions et montants, des préétablies, paiements, règlements et avoirs présents sur le téléphone ; le serveur la recalcule à partir des opérations reçues sous verrou. Une différence bloque la clôture, y compris pour les opérations reçues d’un autre téléphone avec le même compte. Cela ne détecte pas les opérations encore hors ligne et ne prouve pas le versement physique. Les avoirs reçus créés ailleurs sur les factures du commercial sont déduits de son facturé le jour de l’avoir et intégrés à la preuve de clôture ; les remboursements restent imputés à la caisse de leur auteur ou à la caisse attribuée. Un cache ancien ou une preuve différente exige une synchronisation et un rapprochement avant clôture. Une comparaison consultative supplémentaire vérifie par identifiant les préétablies, paiements du journal, règlements globaux, avoirs commerciaux et remboursements administrateur attribués reçus par le serveur. La comparaison des ventes reste séparée ; les deux captures peuvent être prises à des moments différents. Ces aperçus restent consultatifs et ne remplacent pas le contrôle transactionnel de clôture ; ils ne contrôlent pas les appareils encore hors ligne. L’essai physique Android et les validations comptables restent nécessaires.
