# Règles métier — décisions et questions ouvertes

Ce document résume les échanges. Il ne remplace pas une validation fiscale complète.

## Décisions confirmées

- Tunisie, dinar tunisien en millimes ; quantités entières. Plus de 2 000 articles, classés en catégories ; clients filtrés par secteur et partagés entre commerciaux.
- Android, français et arabe (RTL). PDF en français. Internet facultatif en tournée ; synchronisation au retour du réseau.
- L'administrateur seul gère clients, articles et prix. Le prix d'achat reste strictement côté serveur, jamais dans les réponses ou données mobiles. Un prix de vente par article ; remise par ligne autorisée.
- Espèces, chèque, virement et crédit ; paiement partiel et règlement ultérieur. Le solde initial d'un client peut être saisi par l'admin.
- Quand le solde atteint ou dépasse le plafond, la vente est bloquée ; seul l'administrateur peut autoriser la reprise. Le mobile affiche l'état et la décision doit être synchronisée.
- Le commercial peut modifier une facture après validation et partage ; conserver l'historique, recalculer le solde et permettre le partage du nouveau PDF. L'administrateur et le commercial peuvent annuler toute une facture par avoir.
- Si le montant modifié est inférieur au paiement déjà effectué, le commercial choisit le remboursement ou le maintien du trop-perçu en crédit client. Tracer les mouvements.
- Partage manuel du PDF par WhatsApp au client et éventuellement à la direction ; les factures synchronisées sont visibles dans le tableau de bord.
- Aucun arrondi additionnel du net à payer comme sur la facture d'exemple.

## Hypothèses provisoires du moteur

- Montants entiers en millimes ; taux en centièmes de pour cent. Arrondi à la moitié supérieure au millime : net de chaque ligne, puis TVA par taux sur les bases regroupées. Timbre configurable. **À valider par le comptable avec des exemples réels**, notamment taux, timbre et mentions.
- Solde signé : positif = dette, négatif = crédit. Un remboursement est enregistré comme mouvement distinct. La fonction de calcul ne remplace pas un registre transactionnel.
- Le blocage est fondé sur le solde actuel connu, sans préjuger de la règle pour une vente qui ferait dépasser la limite. L'autorisation administrateur est représentée provisoirement par un booléen, sans définir sa durée.

## Questions ouvertes avant mise en production

- Une vente qui fait passer le solde de sous le plafond à au-dessus doit-elle être bloquée avant validation ? L'autorisation admin vaut-elle pour une vente ou jusqu'à révocation ? Comment traiter les ventes comptant d'un client bloqué ?
- Hors ligne, deux appareils peuvent disposer de soldes ou autorisations périmés : une limite globale stricte est impossible sans coordination. Définir politique de blocage, synchronisation et résolution des conflits.
- Peut-on modifier et annuler hors ligne ? Qui peut modifier une facture, et comment résoudre les modifications simultanées ? Numérotation et fiscalité à confirmer avec le comptable.
- Comment utiliser un crédit client sur une facture ultérieure ? Peut-on rembourser partiellement ? Définir les règles d'imputation, d'annulation, d'audit et de soldes d'ouverture.
- La ligne « ancien » de la facture exemple représente-t-elle une dette antérieure ? Définir la présentation et éviter de facturer une dette une seconde fois.
- Liste des secteurs et champs articles ; formats d'import réels ; modèles Android ; modalités de chèque ; définition du bénéfice et conservation historique du coût ; liste et droits des administrateurs.
- Définir authentification hors ligne, révocation, chiffrement local et stockage sécurisé ; confirmer capacités PDF et partage sur appareils réels.
