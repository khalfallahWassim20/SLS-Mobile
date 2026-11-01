# Application mobile — prototype

Depuis la racine : `npm install`, puis `npm run mobile`. Ouvrir avec Expo Go compatible avec le SDK utilisé par le projet, ou utiliser un émulateur Android configuré localement.

Ce prototype en français utilise un catalogue et des clients fictifs. Il permet de remplir un panier, enregistrer un paiement et conserver une vente de démonstration dans SQLite sur le téléphone. L'historique et le solde local restent disponibles après redémarrage ; la désinstallation peut supprimer ces données. Le stockage n'est pas chiffré : n'y saisir aucune donnée réelle. Les remises proposées sont limitées à quelques boutons pour la démonstration.

Il n'y a pas encore de facture officielle, avoir, imputation des règlements à des factures, PDF, synchronisation, authentification ou autorisation administrateur. Les ventes fictives peuvent être modifiées localement, avec trace et choix de remboursement ou crédit ; ce crédit n'est pas encore imputable à une autre vente. Les données ne sont ni sauvegardées sur un serveur ni partagées entre appareils. Ne pas utiliser en production.

Les règlements de dette sont conservés localement et déduits du solde global, sans imputation à une facture précise. Les ventes et paiements sont visibles dans l'historique. Les fichiers clients/articles ne sont pas encore importés.

## Téléchargement de référence (test uniquement)

La section « Clients et articles de l’administration » permet de télécharger manuellement un instantané complet via le jeton de test mobile distinct du compte admin. Les données restent consultables hors ligne, mais sont en lecture seule et ne remplacent pas le catalogue de vente fictif. Les ventes et règlements ne sont pas envoyés au serveur. Un échec de téléchargement conserve l'ancien instantané. Le cache local n'est pas chiffré ; ne pas utiliser de données réelles.
