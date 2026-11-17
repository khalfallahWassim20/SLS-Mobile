# Préparation de la facture du jour

La migration PostgreSQL relançable inclut les registres préparatoires des paiements unifiés, règlements d'ancienne dette et compensations. Elle ne transforme pas les opérations existantes et **n'active ni les routes v6 ni les écrans mobiles normaux**. Si un registre contient déjà des opérations, les anciens traitements incompatibles restent bloqués plutôt que de présenter un solde erroné.

Les essais automatisés utilisent des bases fictives. Ils vérifient notamment une migration répétée avec conservation des clients, articles, commerciaux, ventes, préétablies, clôtures et de la lignée ; ils vérifient aussi le maintien des gardes et l'absence de routes v6 sur le routeur mobile normal. Ils ne prouvent pas que tous les téléphones réels ont synchronisé leurs opérations.

Un aperçu de transition v4→v6 a été ajouté pour les essais : après vérification préalable de la session et d'une lignée déjà épinglée, il compare la référence v4 et les opérations locales à une référence v6 dans une transaction SQLite exclusive. Un savepoint temporaire permet de réutiliser les calculs v6, puis est annulé même en cas d'erreur : aucun cache v6 ni acquittement n'est conservé. Il signale les opérations en attente et les clients en conflit, notamment deux préétablies concurrentes. Le cache v4 reste inchangé ; les caches v5 et les tentatives v6 restent bloquants. L'adaptateur mobile est réservé au banc fictif et n'est pas monté dans l'application normale.

L'aperçu recense aussi, uniquement sur le téléphone inspecté, les dépenses originales, corrections et annulations ainsi que les opérations de dépense en attente ; les chaînes de dépenses sont contrôlées avant le comptage. Il compte les tentatives de clôture et états locaux connus. Si les tables nécessaires manquent, l'inventaire concerné est indiqué indisponible et non vide par défaut. Aucun acquittement ni aucune écriture ne sont effectués.

Cet aperçu n'autorise jamais une migration : il ne contrôle pas les autres téléphones et ne rapproche pas les dépenses ni les clôtures avec le serveur ; un indicateur local synchronisé ne prouve pas leur présence serveur. La situation serveur peut changer après la lecture. Il ne résout ni la première confiance de la lignée, ni les compensations, ni la transition v5. Un test HTTP/PostgreSQL/SQLite fictif vérifie le parcours et le refus d'une lignée modifiée.

Lorsqu'une compensation expérimentale existe, l'administration peut afficher automatiquement une synthèse vérifiée en lecture seule par commercial et par jour. Elle distingue préétablie, ventes, paiement unique et choix remboursement/crédit. Le total après remboursements est théorique : les choix n'attestent ni remise physique ni mode de paiement. Les anciens exports et la clôture ne sont pas activés par cette lecture ; les opérations hors ligne ne sont pas visibles.

Avant toute migration réelle, conserver une sauvegarde vérifiée de la base et les données locales des téléphones. Une restauration, une base copiée ou un téléphone non synchronisé peut nécessiter un rapprochement. Cette préparation ne vaut pas autorisation d'activer le paiement unique, les compensations ou la clôture v6 en production ; les projections normales, les conflits et les tests sur téléphone restent à terminer.

## Raccordement du paiement unique (non validé)

Un accès « Passer à la facture du jour » est maintenant raccordé au journal
mobile individuel. Le passage écrit la référence v6 et la lignée serveur dans
une transaction locale, sans supprimer les données précédentes. Il refuse les
files en attente, les clients en conflit, les dépenses locales et une clôture
sans réponse. L'espace affiche un paiement portant sur le total préétablie et
ventes sans ventilation ; l'ancienne dette reste séparée. Au redémarrage, la
liaison conservée ouvre le même espace ; la saisie locale reste possible hors
ligne et la synchronisation demande une session et la même lignée.

Le serveur ne monte ces routes que si `SLS_DAY_INVOICE_ENABLED=1` est configuré
explicitement ; cette option est désactivée par défaut. **Ce raccordement n'a
pas été testé et ne doit pas être activé sur les données réelles avant les
vérifications convenues.** La transition suppose une première confiance dans
l'adresse déjà liée, ne vérifie pas les opérations hors ligne d'autres
appareils et n'intègre pas les dépenses locales existantes. Le trop-perçu et
son choix remboursement/crédit, les lectures ordinaires d'administration, la
clôture et les exports complets restent à raccorder. Aucun retour automatique à
l'ancien parcours n'est prévu : conserver les données et une sauvegarde.
