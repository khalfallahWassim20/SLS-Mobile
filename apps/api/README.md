# API — développement local

PostgreSQL, authentification admin par mot de passe bcrypt configuré dans l'environnement et jeton JWT d'une heure. L'API écoute sur `127.0.0.1` et est accessible au navigateur via le proxy de Vite. Un seul administrateur est configuré dans `.env` ; ce n'est pas encore une gestion de comptes ou de rôles complète. Seuls clients et articles sont implémentés. Le prix d'achat est visible uniquement via ces endpoints administrateur ; aucune API mobile n'existe encore.

## Configuration

Depuis la racine : `docker compose up -d`, puis copier `apps/api/.env.example` en `apps/api/.env`. Remplacer le secret JWT par une valeur aléatoire privée d'au moins 32 caractères ; créer un hash bcrypt local :

```sh
node -e "console.log(require('bcryptjs').hashSync('CHOISIR_UN_MOT_DE_PASSE',12))"
```

Inscrire le hash dans `ADMIN_PASSWORD_HASH` sans guillemets ; remplacer le mot de passe d'exemple dans la commande. Ne pas partager ou versionner `.env`. Depuis la racine exécuter `npm run migrate`, puis `npm run api`.

Prototype local uniquement : pas de TLS, mécanisme de révocation, audit, gestion de comptes ni sauvegarde de production. Ne pas exposer sur Internet ni utiliser de vraies données. Les migrations, les accès et la sécurité restent à vérifier sur une instance PostgreSQL réelle avant production.

Après mise à jour, relancer `npm run migrate` pour créer les tables supplémentaires sans supprimer les données existantes. Le journal d'administration est écrit dans la même transaction que la création ou modification d'un client ou article ; il n'est pas encore un système d'audit complet de production.

## Test mobile sur réseau local

Le point de lecture `/api/mobile/reference` est désactivé si `MOBILE_DEMO_TOKEN` est absent ou inférieur à 32 caractères. Il utilise un jeton dédié, jamais celui de l'administrateur et ne renvoie pas le prix d'achat. Pour un test local uniquement, définir un jeton aléatoire et `API_HOST=0.0.0.0` dans `.env`, puis redémarrer l'API. L'API devient alors accessible sur le réseau : utiliser uniquement un réseau privé fiable et des données fictives. HTTP ne chiffre ni le jeton ni les données ; ne pas exposer publiquement. Après le test, supprimer ces deux variables et redémarrer l'API. Cette solution provisoire ne remplace pas HTTPS, les comptes commerciaux, les contrôles par appareil ou le chiffrement local.

L'API de test `/api/mobile/sales` accepte des versions de vente fictive avec le jeton mobile de démonstration ; elle vérifie les totaux et l'ordre des versions, et garde les opérations par UUID. Le menu administrateur « Ventes démo » montre la dernière version reçue. Cette fonctionnalité ne crée pas de facture, ne synchronise pas les règlements séparés et ne met pas à jour les soldes clients. La robustesse réseau et les accès par appareil ne sont pas encore validés pour la production.

Le endpoint de test `/api/mobile/settlements` reçoit les nouveaux règlements globaux avec idempotence par UUID. L'administration affiche un solde de démonstration calculé à partir du solde initial et des ventes et règlements reçus. Il ne comprend pas les opérations en attente ou créées avant la mise en file, et il ne remplace pas un grand livre comptable. Le mobile récupère le solde global lors d'un téléchargement manuel. Les tests d'intégration, de réseau et de concurrence sur PostgreSQL et appareils restent à réaliser.

L'instantané mobile v2 contient le solde de démonstration reçu par le serveur et les marqueurs des ventes et règlements reçus, pour permettre au téléphone de réconcilier ses opérations locales sans double comptage. La lecture est cohérente au sein d'une transaction PostgreSQL, mais ne résout pas les dépassements de plafond par plusieurs appareils hors ligne. Ce protocole n'est pas validé en production.

## Fiches de commerciaux (démonstration)

Après `npm run migrate`, l'administration peut créer, modifier ou désactiver des fiches de commerciaux fictifs. Les mutations sont tracées dans le journal d'audit. Ces fiches ne sont pas des comptes : elles ne donnent aucun accès mobile et ne sont pas encore associées aux ventes ou aux journaux. La désactivation ne révoque pas le jeton mobile partagé ; la clôture et la réouverture ne sont pas encore disponibles.

## Import de la liste des articles CSV

L'import est effectué **sur le serveur**, jamais dans le téléphone ; le prix d'achat n'est pas transmis dans la référence mobile. Le fichier d'origine n'est pas ajouté au dépôt : conserver une copie en lieu sûr et ne pas la publier. L'application reste un prototype non sécurisé pour la production ; l'import réel ne constitue pas une mise en production.

Format reconnu : export CSV UTF-8 « Liste des Produits », colonnes `Code a barre`, `Libellé`, `P.AU Htva`, avec prix HT en dinars à trois décimales. La virgule dans `1,646.387 dt` est interprétée comme séparateur de milliers. Les deux lignes techniques exactes `Commentaire` et `USING FOR LABELS` à zéro sont exclues. Un code interne distinct est créé pour chaque article ; un code-barres absent reste vide et peut être renseigné dans l'administration.

Calcul retenu : **achat TTC = achat HT × 1,19**, arrondi au millime ; puis **vente TTC = achat TTC × 1,20**, arrondi au millime. Ainsi 46,310 DT HT → 55,109 DT d'achat TTC → 66,131 DT de vente TTC. La marge de 20 % est appliquée à l'achat TTC, non à l'achat HT. Tous les articles sont enregistrés avec TVA 19 % ; le fichier ne contient pas de quantité par carton, donc celle-ci vaut provisoirement 1 et doit être corrigée si nécessaire. Faire confirmer les taux, les prix et la règle d'arrondi avant utilisation commerciale.

Après sauvegarde de la base et vérification de la destination de `DATABASE_URL`, depuis la racine du projet et avec les dépendances installées (`npm ci`) :

```powershell
npm run migrate
npm run import:articles -- "C:\chemin\vers\ETAT_Liste_des_Produits.csv"
```

La deuxième commande affiche un aperçu sans écriture. Pour importer réellement, définir `DATABASE_URL` vers la base choisie dans l'environnement du terminal, puis lancer :

```powershell
npm run import:articles -- "C:\chemin\vers\ETAT_Liste_des_Produits.csv" IMPORTER_LES_ARTICLES
```

Ne pas partager l'URL de connexion si elle contient un mot de passe. L'import est transactionnel : si un code-barres du fichier existe déjà, ou si une ligne est invalide, **aucun article n'est ajouté**. Le même fichier est reconnu lors d'une répétition et n'est pas réimporté ; les fiches existantes ne sont jamais modifiées ni supprimées. Un fichier modifié n'est pas considéré identique et une collision bloque l'ensemble. Le journal d'audit conserve une trace des créations. Après import, actualiser la référence sur chaque téléphone connecté. Les comptes, clients, ventes et clôtures ne sont pas supprimés.
