# Préparation de la facture du jour

La migration PostgreSQL relançable inclut les registres préparatoires des paiements unifiés, règlements d'ancienne dette et compensations. Elle ne transforme pas les opérations existantes et **n'active ni les routes v6 ni les écrans mobiles normaux**. Si un registre contient déjà des opérations, les anciens traitements incompatibles restent bloqués plutôt que de présenter un solde erroné.

Les essais automatisés utilisent des bases fictives. Ils vérifient notamment une migration répétée avec conservation des clients, articles, commerciaux, ventes, préétablies, clôtures et de la lignée ; ils vérifient aussi le maintien des gardes et l'absence de routes v6 sur le routeur mobile normal. Ils ne prouvent pas que tous les téléphones réels ont synchronisé leurs opérations.

Un aperçu de transition v4→v6 a été ajouté pour les essais : après vérification préalable de la session et d'une lignée déjà épinglée, il compare la référence v4 et les opérations locales à une référence v6 dans une transaction SQLite exclusive. Un savepoint temporaire permet de réutiliser les calculs v6, puis est annulé même en cas d'erreur : aucun cache v6 ni acquittement n'est conservé. Il signale les opérations en attente et les clients en conflit, notamment deux préétablies concurrentes. Le cache v4 reste inchangé ; les caches v5 et les tentatives v6 restent bloquants. L'adaptateur mobile est réservé au banc fictif et n'est pas monté dans l'application normale.

L'aperçu recense aussi, uniquement sur le téléphone inspecté, les dépenses originales, corrections et annulations ainsi que les opérations de dépense en attente ; les chaînes de dépenses sont contrôlées avant le comptage. Il compte les tentatives de clôture et états locaux connus. Si les tables nécessaires manquent, l'inventaire concerné est indiqué indisponible et non vide par défaut. Aucun acquittement ni aucune écriture ne sont effectués.

Cet aperçu n'autorise jamais une migration : il ne contrôle pas les autres téléphones et ne rapproche pas les dépenses ni les clôtures avec le serveur ; un indicateur local synchronisé ne prouve pas leur présence serveur. La situation serveur peut changer après la lecture. Il ne résout ni la première confiance de la lignée, ni les compensations, ni la transition v5. Un test HTTP/PostgreSQL/SQLite fictif vérifie le parcours et le refus d'une lignée modifiée.

Lorsqu'une compensation expérimentale existe, l'administration peut afficher automatiquement une synthèse vérifiée en lecture seule par commercial et par jour. Elle distingue préétablie, ventes, paiement unique et choix remboursement/crédit. La lecture serveur répartit aussi les règlements globaux et les reçus hérités par client, sans attribuer la facture d'origine au commercial et sans compter deux fois les règlements v6 d'ancienne dette. Les règlements globaux non qualifiés ne sont pas présentés comme ancienne dette. Une incohérence entre les lignes et le total refuse la lecture. Cette modification n'a pas été testée. Le total après remboursements est théorique : les choix n'attestent ni remise physique ni mode de paiement. Les anciens exports et la clôture ne sont pas activés par cette lecture ; les opérations hors ligne ne sont pas visibles.

Avant toute migration réelle, conserver une sauvegarde vérifiée de la base et les données locales des téléphones. Une restauration, une base copiée ou un téléphone non synchronisé peut nécessiter un rapprochement. Cette préparation ne vaut pas autorisation d'activer le paiement unique, les compensations ou la clôture v6 en production ; les projections normales, les conflits et les tests sur téléphone restent à terminer.

## Modification après règlement (non validée)

Une modification v6 sans trop-perçu n'est plus automatiquement refusée parce
qu'un règlement d'ancienne dette existe pour ce client. Les paiements de dette
locaux déjà synchronisés sont contrôlés, les opérations de dette en attente du
client restent bloquantes, et une dette sur une journée ultérieure exige un
rapprochement. La date de la modification doit suivre les paiements connus et
les règlements de dette locaux du même jour ; le serveur vérifie ses propres
preuves et dates sous verrou, y compris celles reçues d'autres téléphones.
Le serveur recalcule aussi le trop-perçu même en l'absence de paiement unifié,
car un paiement initial historique peut exister. Le protocole expérimental de
compensation peut désormais accepter un tel trop-perçu si les sources et les
preuves sont vérifiables, sans inventer de paiement unifié. Avant une révision,
le téléphone contrôle les dates de ses sources locales ; le serveur vérifie
les versions et dates des ventes, de la préétablie et de ses reçus ainsi que
des paiements connus. Une source plus récente bloque la modification. Tout
choix de remboursement ou crédit reste expérimental et les gardes existantes
restent actives. Modification non testée : ne pas activer le protocole sur des
données réelles avant validation.

## Photographie du choix de trop-perçu (préparatoire, non validée)

Pour les nouvelles compensations du banc isolé, le téléphone conserve désormais
une copie de la référence antérieure dans la même transaction que la modification
et le choix remboursement/crédit. La lecture de reprise vérifie cette copie et
la compare à la photographie de la facture. Les anciennes compensations sans
copie continuent d'utiliser le cache précédent, qui demeure protégé contre
l'écrasement. La copie n'atteste ni la fraîcheur du serveur ni un remboursement
physique. Elle ne lève aucune garde : choix réel, plusieurs compensations,
actualisation du cache, soldes et reprise complète restent à intégrer. Une
préparation interne sait inventorier jusqu'à 1 000 compensations locales de
clients différents, refuser les doublons, vérifier chaque photographie et
reprendre leurs envois un par un en conservant chaque reçu. La reprise ciblée et
les adaptateurs associés sont limités au banc isolé ; le parcours actuel ne peut
toujours créer qu'une compensation locale et ne sait pas rejouer plusieurs
choix pour le même client. Ces changements ne lèvent aucune garde. Aucun test
n'a été effectué sur ces modifications.

## Raccordement du paiement unique (non validé)

Un accès « Passer à la facture du jour » est maintenant raccordé au journal
mobile individuel. Le passage écrit la référence v6 et la lignée serveur dans
une transaction locale, sans supprimer les données précédentes. Il refuse les
files en attente, les clients en conflit, les dépenses en attente et une clôture
sans réponse. L'espace affiche un paiement portant sur le total préétablie et
ventes sans ventilation ; l'ancienne dette reste séparée. Il donne aussi accès
aux dépenses locales et à leur synchronisation. Au redémarrage, la liaison
conservée ouvre le même espace ; la saisie locale reste possible hors ligne et
la synchronisation demande une session et la même lignée.

Le serveur ne monte ces routes que si `SLS_DAY_INVOICE_ENABLED=1` est configuré
explicitement ; cette option est désactivée par défaut. **Ce raccordement n'a
pas été testé et ne doit pas être activé sur les données réelles avant les
vérifications convenues.** La transition suppose une première confiance dans
l'adresse déjà liée et ne vérifie pas les opérations hors ligne d'autres
appareils. Le trop-perçu et son choix remboursement/crédit, les lectures ordinaires d'administration, la
clôture et les exports complets restent à raccorder. Le serveur refuse désormais
toute nouvelle clôture v6, même si sa preuve de caisse correspond : cette preuve
ne couvre pas encore les dépenses et leurs corrections. Une réponse déjà reçue
reste récupérable par son identifiant de demande. Cette garde ne remplace pas
l'intégration des dépenses dans les preuves, les exports et la clôture. Aucun
retour automatique à l'ancien parcours n'est prévu : conserver les données et
une sauvegarde.

## Synthèse administrative compensée (non validée)

La lecture distincte fournit les règlements v6 et les dépenses reçues pour
permettre un export CSV ou une impression PDF de synthèse. L'export recharge
une photographie serveur et refuse les détails absents ou incohérents ; il
ne remplace pas le journal complet, la preuve de clôture ou la caisse physique.
Les dépenses affichées ne sont pas déduites des encaissements et les opérations
hors ligne, les modes des règlements historiques non détaillés et le mode de
remboursement ne sont pas certifiés. Cette fonctionnalité n'a pas été testée.
Elle ne rend pas disponibles les compensations dans le parcours normal et ne
justifie pas l'activation de v6 sur des données réelles.

## Préparation de preuve des dépenses

Une photographie canonique commune au mobile et au serveur rejoue désormais les
créations, corrections et annulations de dépenses pour une journée : identifiants,
ordre, versions, montants et total restant sont contrôlés. La capture mobile
v6 retourne cette photographie séparément de l'ancienne empreinte de caisse ;
une lecture serveur transactionnelle prépare la même représentation. La
comparaison n'est pas encore incluse dans la demande de clôture : **la garde
serveur reste en place**. La photographie ne démontre ni l'absence d'opérations
sur d'autres téléphones ni le paiement physique, et le lecteur serveur ne
recalcule pas les empreintes d'origine des écritures. Aucun test n'a été exécuté.
