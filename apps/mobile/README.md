# Application mobile — prototype

Depuis la racine : `npm install`, puis `npm run mobile`. Ouvrir avec Expo Go compatible avec le SDK utilisé par le projet, ou utiliser un émulateur Android configuré localement.

Ce prototype en français utilise un catalogue et des clients fictifs. Il permet de remplir un panier, enregistrer un paiement et conserver une vente de démonstration dans SQLite sur le téléphone. L'historique et le solde local restent disponibles après redémarrage ; la désinstallation peut supprimer ces données. Le stockage n'est pas chiffré : n'y saisir aucune donnée réelle. Les remises proposées sont limitées à quelques boutons pour la démonstration.

Il n'y a pas encore de facture officielle, modification, avoir, règlement ultérieur, remboursement, PDF, synchronisation, authentification ou autorisation administrateur. Les données ne sont ni sauvegardées sur un serveur ni partagées entre appareils. Ne pas utiliser en production.
