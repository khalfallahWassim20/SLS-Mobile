# Journal de tournée — cadrage confirmé et limites

## Décisions confirmées
- Le journal du jour est l'accueil du commercial. Une seule facture préétablie TTC par client et par jour ; plusieurs clients et plusieurs ventes supplémentaires par client sont possibles.
- La facture préétablie n'est pas déjà comprise dans le solde client. Une dette antérieure peut être réglée séparément (espèces, chèque ou virement).
- Si la facture préétablie est entièrement impayée, cocher « Crédit » pour ajouter son montant entier à la dette. En cas de paiement partiel, seul le reste impayé devient dette, sans cocher « Crédit ».
- Exemple : ancienne dette 1 000 DT − règlement 300 DT + facture entièrement à crédit 600 DT = nouvelle dette 1 300 DT. Total facturé 600 DT ; total encaissé 300 DT.
- Clôture obligatoire en fin de journée ; exports PDF et Excel/CSV souhaités.

## Étape réalisée
Les fonctions pures du domaine calculent les totaux client/jour, séparent les paiements de facture des règlements d'ancienne dette, contrôlent le paiement et testent le choix crédit total. **Les écrans, l'enregistrement, les comptes commerciaux, la clôture, les exports et la synchronisation du journal ne sont pas encore implémentés.**

## Points de conception à valider avant l'intégration
- Définir l'identité du commercial et le jour local (fuseau Afrique/Tunis) ; garantir l'unicité par commercial, date et client même sur plusieurs appareils.
- Les paiements répétés doivent être imputés une seule fois. Le plafond du règlement d'ancienne dette utilise le dernier solde connu *avant* ajout de la nouvelle facture, diminué des règlements déjà saisis. Hors ligne, ce solde peut être périmé.
- Définir à quel moment une facture non payée doit être validée comme dette, ainsi que les corrections, annulations et la réouverture après clôture ; toutes les modifications doivent être tracées sans double compter les ventes et paiements existants.
- Le traitement d'un trop-perçu sur une vente de tournée, d'un avoir et des paiements ultérieurs doit être spécifié dans les totaux du journal ; le calcul actuel les refuse ou exclut les factures annulées sans gérer leurs remboursements.
- Confirmer si les montants préétablis doivent figurer dans le chiffre d'affaires du dashboard : ces factures existent déjà ailleurs, risque de double comptage. Confirmer si la référence papier est obligatoire.
- Les modes chèque et virement nécessitent des champs et règles de validation ; spécifier l'imputation si une facture de tournée est réglée ultérieurement.
- Clôture et export doivent inclure paiements, corrections et factures de tournée, fonctionner hors ligne et être synchronisés ; un export CSV compatible Excel n'est pas un fichier XLSX natif.
