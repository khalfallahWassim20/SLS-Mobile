# API — développement local

PostgreSQL, authentification admin par mot de passe bcrypt configuré dans l'environnement et jeton JWT d'une heure. L'API écoute sur `127.0.0.1` et est accessible au navigateur via le proxy de Vite. Un seul administrateur est configuré dans `.env` ; ce n'est pas encore une gestion de comptes ou de rôles complète. Seuls clients et articles sont implémentés. Le prix d'achat est visible uniquement via ces endpoints administrateur ; aucune API mobile n'existe encore.

## Configuration

Depuis la racine : `docker compose up -d`, puis copier `apps/api/.env.example` en `apps/api/.env`. Remplacer le secret JWT par une valeur aléatoire privée d'au moins 32 caractères ; créer un hash bcrypt local :

```sh
node -e "console.log(require('bcryptjs').hashSync('CHOISIR_UN_MOT_DE_PASSE',12))"
```

Inscrire le hash dans `ADMIN_PASSWORD_HASH` sans guillemets ; remplacer le mot de passe d'exemple dans la commande. Ne pas partager ou versionner `.env`. Depuis la racine exécuter `npm run migrate`, puis `npm run api`.

Prototype local uniquement : pas de TLS, mécanisme de révocation, audit, gestion de comptes ni sauvegarde de production. Ne pas exposer sur Internet ni utiliser de vraies données. Les migrations, les accès et la sécurité restent à vérifier sur une instance PostgreSQL réelle avant production.
