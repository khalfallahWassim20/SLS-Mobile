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

Le endpoint de test `/api/mobile/settlements` reçoit les nouveaux règlements globaux avec idempotence par UUID. L'administration affiche un solde de démonstration calculé à partir du solde initial et des ventes et règlements reçus. Il ne comprend pas les opérations en attente ou créées avant la mise en file, et il ne remplace pas un grand livre comptable. Le mobile ne récupère pas encore le solde global serveur. Les tests d'intégration, de réseau et de concurrence sur PostgreSQL et appareils restent à réaliser.
