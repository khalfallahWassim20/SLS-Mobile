# Règles métier — décisions et questions ouvertes

Ce document résume les échanges. Il ne remplace pas une validation fiscale complète.

## Décisions confirmées

- Tunisie, dinar tunisien en millimes ; quantités entières. Plus de 2 000 articles, classés en catégories ; clients filtrés par secteur et partagés entre commerciaux.
- Android, français et arabe (RTL). PDF en français. Internet facultatif en tournée ; synchronisation au retour du réseau.
- L'administrateur seul gère clients, articles et prix. Le prix d'achat reste strictement côté serveur, jamais dans les réponses ou données mobiles. Un prix de vente par article ; remise par ligne autorisée.
- Espèces, chèque, virement et crédit ; paiement partiel et règlement ultérieur. Le solde initial d'un client peut être saisi par l'admin.
- Quand le plafond est supérieur à zéro et que le solde atteint ou dépasse ce plafond, la vente est bloquée ; seul l'administrateur peut autoriser la reprise. Le mobile affiche l'état et la décision doit être synchronisée.
- Le commercial peut modifier une facture après validation et partage ; conserver l'historique, recalculer le solde et permettre le partage du nouveau PDF. L'administrateur et le commercial peuvent annuler toute une facture par avoir.
- Si le montant modifié est inférieur au paiement déjà effectué, le commercial choisit le remboursement ou le maintien du trop-perçu en crédit client. Tracer les mouvements.
- Partage manuel du PDF par WhatsApp au client et éventuellement à la direction ; les factures synchronisées sont visibles dans le tableau de bord.
- Aucun arrondi additionnel du net à payer comme sur la facture d'exemple.

## Hypothèses provisoires du moteur

- Montants entiers en millimes ; taux en centièmes de pour cent. Arrondi à la moitié supérieure au millime : net de chaque ligne, puis TVA par taux sur les bases regroupées. Timbre configurable. **À valider par le comptable avec des exemples réels**, notamment taux, timbre et mentions.
- Solde signé : positif = dette, négatif = crédit. Un remboursement est enregistré comme mouvement distinct. La fonction de calcul ne remplace pas un registre transactionnel.
- Un plafond de 0 signifie aucune limite définie. Le blocage est fondé sur le solde actuel connu, sans préjuger de la règle pour une vente qui ferait dépasser la limite. L'autorisation administrateur est représentée provisoirement par un booléen, sans définir sa durée.

## Questions ouvertes avant mise en production

- Une vente qui fait passer le solde de sous le plafond à au-dessus doit-elle être bloquée avant validation ? L'autorisation admin vaut-elle pour une vente ou jusqu'à révocation ? Comment traiter les ventes comptant d'un client bloqué ?
- Hors ligne, deux appareils peuvent disposer de soldes ou autorisations périmés : une limite globale stricte est impossible sans coordination. Définir politique de blocage, synchronisation et résolution des conflits.
- Peut-on modifier et annuler hors ligne ? Qui peut modifier une facture, et comment résoudre les modifications simultanées ? Numérotation et fiscalité à confirmer avec le comptable.
- Comment utiliser un crédit client sur une facture ultérieure ? Peut-on rembourser partiellement ? Définir les règles d'imputation, d'annulation, d'audit et de soldes d'ouverture.
- La ligne « ancien » de la facture exemple représente-t-elle une dette antérieure ? Définir la présentation et éviter de facturer une dette une seconde fois.
- Liste des secteurs et champs articles ; formats d'import réels ; modèles Android ; modalités de chèque ; définition du bénéfice et conservation historique du coût ; liste et droits des administrateurs.
- Définir authentification hors ligne, révocation, chiffrement local et stockage sécurisé ; confirmer capacités PDF et partage sur appareils réels.

## Exemples de fichiers transmis

Les exemples sont séparés par des points-virgules et utilisent la virgule décimale ; ne pas copier de données personnelles ni prix d'achat dans le mobile. L'exemple clients comprend secteur, nom, prénom, adresse, société, MF et téléphone, avec lignes vides à ignorer. L'exemple articles comprend code-barres (parfois vide), désignation, prix d'achat TTC, prix de vente TTC et quantité par carton. Prévoir import côté serveur uniquement, aperçu et validation avant écriture, code interne indépendant du code-barres, contrôle des doublons, montants en millimes et protection du prix d'achat.

À clarifier avant de convertir ou importer : taux de TVA par article et règles d'arrondi pour convertir TTC en HT ; prix par unité ou carton ; traitement des codes-barres absents ; champs code client, solde initial, plafond et catégorie absents des exemples. Ne pas déduire une TVA ni un prix HT sans validation.

### Historique des versions de vente dans l'administration (essai)

Dans « Ventes démo », « Voir les versions » présente les versions reçues par le serveur, la date de réception, la date de modification quand elle est connue, le commercial quand son identité a été enregistrée, les lignes, le montant payé net et le remboursement de chaque version. Les anciennes versions partagées restent non attribuées. Les changements encore hors ligne ne sont pas visibles ; les 200 dernières versions au maximum sont affichées, avec avertissement si l'historique est plus long. C'est une consultation de données fictives, et non un avoir, une facture officielle ou un journal comptable complet. Le choix de conserver un trop-perçu peut se refléter dans le montant payé supérieur au total ; l'historique ne fabrique pas un mouvement distinct lorsqu'il n'a pas été enregistré.

### Avoir intégral — calcul préparatoire (non disponible dans l'application)

Le domaine calcule l'annulation d'une vente entière à partir de son total actuel, de son paiement net déjà conservé et du solde client qui inclut cette vente. Si la vente est impayée, sa dette est retirée. S'il reste un paiement net, le choix explicite est de rembourser **tout** ce paiement net ou de le garder comme crédit en faveur du client ; le crédit n'est pas imputé automatiquement à une autre facture. Un éventuel crédit déjà associé à cette vente fait partie du paiement net considéré. Un état déjà annulé est refusé par le calcul. Les montants sont en millimes et les débordements sont refusés.

Ce calcul pur est une préparation uniquement : aucun avoir, numéro, remboursement ou mouvement comptable n'est créé. Il n'est pas relié aux écrans, au stockage, aux droits administrateur/commercial, aux protections concurrentes, à la synchronisation hors ligne, aux exports ni aux clôtures. Ces éléments et les règles fiscales/numérotation doivent être traités avant de présenter la fonction comme disponible ou de l'utiliser avec des données réelles.

Le domaine prépare aussi une commande d'avoir à identifiant UUID v4 stable : elle capture la version de la vente, l'acteur, le choix et la date de l'opération. Une reprise identique peut retourner le même accusé même si la journée a depuis été clôturée ; un identifiant réutilisé avec un contenu ou un acteur différent est refusé. Une nouvelle commande est refusée si une journée concernée est fermée ou inconnue, si la version est périmée ou si la facture est déjà annulée. Les montants du crédit, du remboursement et l'effet sur le solde sont calculés à partir de l'état de la vente.

Ces règles pures ne fournissent aucune protection concurrente par elles-mêmes. Avant activation, le serveur doit authentifier l'acteur et enregistrer atomiquement l'avoir et ses mouvements en verrouillant l'opération, la vente et toutes les journées concernées ; le mobile doit conserver et renvoyer la même commande hors ligne. Ni table, ni route, ni bouton d'avoir ne sont encore fournis.

Une préparation serveur non exposée peut désormais verrouiller l'identifiant de l'opération et la vente, puis relire la version et les montants enregistrés au serveur et contrôler les clôtures concernées. Elle refuse pour l'instant les ventes issues de l'ancien espace. Elle doit être appelée dans une transaction par un service qui authentifie l'acteur ; elle ne constitue pas à elle seule un service d'avoir. Les reprises, la détection d'avoir déjà créé et les écritures atomiques restent à construire. Un test sur PostgreSQL réel vérifie que la modification de vente attend le verrou et qu’une clôture concurrente est respectée. Ce test ne prouve pas encore l’absence de double avoir : le registre et les écritures atomiques ne sont pas construits.

Un registre expérimental est testé uniquement dans une base isolée : il conserve la demande et le résultat, refuse un second avoir sur la même vente et reprend une demande identique après clôture. Deux demandes simultanées et une reprise simultanée ont été testées sur PostgreSQL réel. Ce registre n'est pas dans les migrations de l'application et aucune route ne l'utilise : il ne modifie ni vente, ni solde, ni remboursement. Avant toute activation, il faut notamment raccorder ces effets dans la même transaction, bloquer toute modification ultérieure de facture annulée, protéger l'unicité des UUID dans les autres flux et traiter la synchronisation mobile.

Le registre expérimental écrit maintenant, dans sa transaction de test, un mouvement d'annulation et, si nécessaire, un mouvement de remboursement. Le crédit conservé correspond au paiement restant et ne crée pas un deuxième mouvement de solde. Une projection isolée teste leur effet, avec refus si une version ou un mouvement est incohérent. Ces écritures et cette projection restent strictement expérimentales et ne sont pas reliées à la base ou aux soldes de l'application.
