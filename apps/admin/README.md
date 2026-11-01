# Administration web — prototype

Après configuration et lancement de PostgreSQL et de l'API (voir `apps/api/README.md`), lancer `npm run admin` depuis la racine. Ouvrir l'adresse affichée par Vite et se connecter avec le compte configuré dans l'API. La session est conservée uniquement en mémoire ; recharger la page demande une nouvelle connexion.

Gestion de clients et articles : ajout, modification, activation et désactivation. Les prix sont saisis en TTC, en dinars à trois décimales ; un code interne article est attribué automatiquement. Limite de crédit 0 = aucune limite. Le champ solde est un solde initial seulement, car les ventes et règlements ne sont pas encore synchronisés. Pas d'import CSV, factures, tableau de bord, audit, gestion d'utilisateurs ou synchronisation mobile dans cette étape. Ne pas utiliser avec des données réelles ni exposer publiquement.

La vue d’ensemble présente uniquement les nombres de clients et articles. Le journal affiche les 200 dernières créations et modifications de ces données à partir de son activation ; les données existantes ne génèrent pas de traces rétroactives. Le journal n'enregistre pas encore les connexions, ventes ni paiements.

Le menu « Ventes démo » affiche les ventes fictives manuellement envoyées par le mobile, sans mise à jour des soldes clients ni synchronisation des règlements de dette.
