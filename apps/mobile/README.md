# Application mobile — prototype

Depuis la racine : `npm install`, puis `npm run mobile`. Ouvrir avec Expo Go compatible avec le SDK utilisé par le projet, ou utiliser un émulateur Android configuré localement.

Ce prototype en français utilise un catalogue et des clients fictifs. Il permet de remplir un panier, enregistrer un paiement et conserver une vente de démonstration dans SQLite sur le téléphone. L'historique et le solde local restent disponibles après redémarrage ; la désinstallation peut supprimer ces données. Le stockage n'est pas chiffré : n'y saisir aucune donnée réelle. Les remises proposées sont limitées à quelques boutons pour la démonstration.

Il n'y a pas encore de facture officielle, avoir, imputation des règlements à des factures, PDF, synchronisation, authentification ou autorisation administrateur. Les ventes fictives peuvent être modifiées localement, avec trace et choix de remboursement ou crédit ; ce crédit n'est pas encore imputable à une autre vente. Les données ne sont ni sauvegardées sur un serveur ni partagées entre appareils. Ne pas utiliser en production.

Les règlements de dette sont conservés localement et déduits du solde global, sans imputation à une facture précise. Les ventes et paiements sont visibles dans l'historique. Les fichiers clients/articles ne sont pas encore importés.

## Téléchargement de référence (test uniquement)

La section « Clients et articles de l’administration » permet de télécharger manuellement un instantané complet via le jeton de test mobile distinct du compte admin. Les données restent consultables hors ligne et permettent de créer des ventes de démonstration locales après actualisation. Les soldes et limites proviennent de la dernière synchronisation et peuvent être périmés. Le prix HT est calculé depuis le TTC par une règle d’arrondi provisoire non validée. Les ventes et règlements ne sont pas envoyés au serveur. Un échec de téléchargement conserve l'ancien instantané. Le cache local n'est pas chiffré ; ne pas utiliser de données réelles.

## Envoi manuel des ventes de démonstration

Les nouvelles ventes faites avec un client téléchargé sont inscrites dans une file locale transactionnelle. Le bouton dans l'historique envoie les opérations dans l'ordre ; chaque opération possède un identifiant unique et peut être renvoyée. Les modifications sont également mises en file sous forme de versions successives. Les ventes fictives intégrées, les ventes créées avant cette fonctionnalité et les règlements globaux de dette ne sont pas envoyés. Les ventes reçues ne mettent pas à jour les soldes sur le serveur. Pas de synchronisation automatique ni de chiffrement : tests uniquement, jamais de données réelles. Les scénarios de coupure et de redémarrage doivent encore être testés sur appareil et serveur réels.

Les anciens clients et articles intégrés au prototype ne sont plus proposés. Les anciennes ventes et règlements enregistrés restent dans l'historique et ne sont pas automatiquement envoyés. Les nouveaux règlements de clients téléchargés sont mis en file avec les nouvelles ventes. Le solde mobile combine le dernier solde global téléchargé et les opérations locales ; les opérations d'autres appareils ne sont visibles qu'après téléchargement. Ne pas s'en servir pour contrôler un plafond réel.

## Solde de démonstration multi-appareil

Après téléchargement de l'instantané v2, le téléphone combine le solde serveur reçu avec les différences de versions locales et les règlements non inclus dans cet instantané. Les marqueurs serveur évitent de compter une opération deux fois même si la réponse d'envoi a été perdue. Les anciens instantanés restent consultables mais nécessitent une actualisation avant une vente. Les opérations d'un autre appareil ne sont visibles qu'après envoi et téléchargement manuel. Deux appareils hors ligne peuvent toujours dépasser une limite simultanément. Les anciens événements uniquement locaux restent locaux. Ce mécanisme est expérimental : tests d'intégration multi-appareil, conflits, sécurité et fiscalité restent indispensables.
