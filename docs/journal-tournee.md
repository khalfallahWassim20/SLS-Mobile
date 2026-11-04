# Journal de tournée — cadrage confirmé et limites

## Décisions confirmées
- Le journal du jour est l'accueil du commercial. Une seule facture préétablie TTC par client et par jour ; plusieurs clients et plusieurs ventes supplémentaires par client sont possibles.
- La facture préétablie n'est pas déjà comprise dans le solde client. Une dette antérieure peut être réglée séparément (espèces, chèque ou virement).
- Si la facture préétablie est entièrement impayée, cocher « Crédit » pour ajouter son montant entier à la dette. En cas de paiement partiel, seul le reste impayé devient dette, sans cocher « Crédit ».
- Exemple : ancienne dette 1 000 DT − règlement 300 DT + facture entièrement à crédit 600 DT = nouvelle dette 1 300 DT. Total facturé 600 DT ; total encaissé 300 DT.
- Clôture obligatoire en fin de journée ; exports PDF et Excel/CSV souhaités.
- Dans le dashboard web, afficher séparément facture préétablie, vente supplémentaire et total client (exemple : 600, 250 et 850 DT).

## Étape réalisée
Les fonctions pures du domaine calculent les totaux client/jour, séparent les paiements de facture des règlements d'ancienne dette, contrôlent le paiement et testent le choix crédit total. **Le prototype mobile ci-dessous est local uniquement ; les comptes commerciaux, la clôture, les exports et la synchronisation du journal ne sont pas encore implémentés.**

## Points de conception à valider avant l'intégration
- Définir l'identité du commercial et le jour local (fuseau Afrique/Tunis) ; garantir l'unicité par commercial, date et client même sur plusieurs appareils.
- Les paiements répétés doivent être imputés une seule fois. Le plafond du règlement d'ancienne dette utilise le dernier solde connu *avant* ajout de la nouvelle facture, diminué des règlements déjà saisis. Hors ligne, ce solde peut être périmé.
- Définir à quel moment une facture non payée doit être validée comme dette, ainsi que les corrections, annulations et la réouverture après clôture ; toutes les modifications doivent être tracées sans double compter les ventes et paiements existants.
- Le traitement d'un trop-perçu sur une vente de tournée, d'un avoir et des paiements ultérieurs doit être spécifié dans les totaux du journal ; le calcul actuel les refuse ou exclut les factures annulées sans gérer leurs remboursements.
- Le dashboard doit distinguer préétabli, ventes supplémentaires et total client ; définir séparément le chiffre d’affaires consolidé avec le système principal pour éviter un double comptage. Confirmer si la référence papier est obligatoire.
- Les modes chèque et virement nécessitent des champs et règles de validation ; spécifier l'imputation si une facture de tournée est réglée ultérieurement.
- Clôture et export doivent inclure paiements, corrections et factures de tournée, fonctionner hors ligne et être synchronisés ; un export CSV compatible Excel n'est pas un fichier XLSX natif.

## Prototype mobile — première étape
Un écran d'accueil regroupe les factures préétablies saisies localement et les ventes locales du même client et du même jour (date civile de Tunis). L'unicité locale (date, client) est imposée par SQLite, mais il n'y a pas encore d'identité de commercial ni d'unicité serveur. La facture saisie n'affecte pas le solde avant son traitement. Un paiement ou le choix crédit total enregistre un événement local : le solde sur ce téléphone intègre le reste de facture et déduit les règlements d'ancienne dette. Les paiements ultérieurs sur le préétabli ne sont disponibles que depuis le journal du jour. Chèque, espèces et virement sont proposés ; les deux montants d'une opération partagent le même mode. Les opérations et leurs détails sont locaux et ne sont jamais envoyés au serveur ; le dashboard et les autres appareils ne les voient pas. Le règlement global synchronisé est désactivé pour les clients ayant des opérations de journal locales afin d'éviter des soldes divergents. Ne pas utiliser pour des factures réelles. Les ventes sont regroupées par date, sans lien journal durable ; une correction à venir devra définir l'appartenance et les clôtures. L'export et la clôture restent à construire.

## Préparation de la synchronisation (non activée)
Un calcul pur de rapprochement compare l'instantané serveur et les opérations locales ordonnées. Il ne rajoute que la différence non encore incluse dans le solde serveur et signale une divergence ou un serveur en avance comme conflit. Les marqueurs devront être lus dans la même transaction que le solde serveur. Ce calcul n'est pas encore branché à l'API, à SQLite ou à l'interface : il n'envoie aucune donnée. Reste à construire l'enregistrement transactionnel/idempotent et ses tests PostgreSQL, la gestion des conflits entre appareils, les marqueurs versionnés, la migration des données locales existantes, l'envoi et l'affichage web. Ne pas utiliser la file de ventes pour les opérations du journal avant la mise en place de ces garanties.

### Préparation côté serveur
La migration prépare des tables distinctes et un stockage transactionnel avec versions immuables, détection de doublons et conflits d'identifiants. Une route expérimentale réservée à l'administrateur est désactivée par défaut et isolée des soldes. Elle ne doit pas être utilisée pour synchroniser le mobile : aucune opération mobile n'est transmise et les soldes serveur restent inchangés. La contrainte provisoire est une facture par client et date, sans identité de commercial ; elle devra évoluer si le périmètre multi-commercial l'exige. Les montants d'ancienne dette sont vérifiés contre la limite connue localement, ce qui ne garantit pas un solde à jour sur plusieurs appareils hors ligne. Les tests automatiques couvrent le protocole, les routes et la migration sur PGlite (moteur PostgreSQL intégré mono-connexion). Les verrous et les accès concurrents, simulés dans ces tests, restent à vérifier sur un serveur PostgreSQL réel avant activation.

La route technique est montée sous `/api/experimental/journal`, après authentification administrateur et uniquement si `JOURNAL_EXPERIMENTAL=1`. Elle est réservée aux tests fictifs : elle ne met pas à jour les soldes, ne doit pas servir à une synchronisation réelle et est à laisser désactivée par défaut. Le mobile ne l'utilise pas. L'intégration ultérieure devra éviter de mélanger ces données de test isolées avec le journal synchronisé.
