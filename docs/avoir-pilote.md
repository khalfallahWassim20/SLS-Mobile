# Pilote des avoirs — un seul commercial

Le pilote permet d'essayer les avoirs avec des données réelles pour **un seul commercial** nommé. Les autres téléphones gardent l'ancien parcours. Le passage d'un téléphone est **à sens unique** : les anciennes écritures sont bloquées ensuite.

Ce pilote ne remplace pas la validation métier, comptable et fiscale du document d'avoir. Tant que ce document n'est pas défini, ne remettre aucun avoir au client.

## Activation sur le serveur

Dans `apps/api/.env`, sans `SLS_V5_TEST_ONLY` :

```
SLS_V5_PILOT_COMMERCIAL_ID=<identifiant du commercial, visible dans l'administration>
SLS_V5_PILOT_ACK=J_ACCEPTE_UN_PILOTE_AVOIRS
```

Le serveur refuse de démarrer si l'identifiant est invalide, si la confirmation manque, ou si le pilote est combiné au mode d'essai fictif. Le serveur doit être en mode tournées individuelles et en HTTPS (`docs/https-api.md`).

## Liste de contrôle

**A. Avant**
1. Sauvegarde `pg_dump -Fc` vers un nouveau fichier hors du dépôt (`docs/sauvegardes.md`).
2. Contrôle : code de retour 0, taille non nulle, `pg_restore --list`, empreinte SHA-256 notée, copie sur un autre support.
3. Serveur redémarré avec les deux variables ci-dessus.

**B. Téléphone du pilote**
4. Même application, même identifiant ; ne rien désinstaller (Expo Go et APK ont des bases locales distinctes).
5. Aucune opération en attente (ventes, règlements, journal, dépenses).
6. Tous les autres téléphones du même commercial sont synchronisés.
7. Journée dans un état clair (ouverte ou clôturée). Connexion stable, application ouverte pendant la vérification.

**C. Passage**
8. Le bouton « Passer aux avoirs » n'apparaît que chez le pilote. S'il apparaît ailleurs : arrêter. Tant que le correctif de `apps/mobile/App.tsx` (fichier `avoirs-pilote-ecran.patch`) n'est pas appliqué, le bouton et l'alerte affichent encore « essai fictif » : ignorer ce libellé, les données sont bien réelles.
9. Valider l'alerte et attendre le message « Espace avoirs activé ».

**D. Premier essai réel**
10. Un seul avoir, sur une vente de faible montant ; noter le solde du client avant et après.
11. Solde, historique, journal et exports PDF/CSV concordent.
12. Un nouvel essai de la même opération ne crée pas un deuxième avoir.
13. Clôture de la tournée : comparer la caisse et le journal.
14. Lancer `npm run audit:avoirs -- <idCommercial> <AAAA-MM-JJ>` (jour de l'avoir) : le résultat attendu est « Anomalies : 0 » pour les ventes, les préétablies et le journal.

## Audit des avoirs

`npm run audit:avoirs` relit, en lecture seule, chaque avoir enregistré (ventes et factures préétablies), le recalcule avec les règles du domaine et le rapproche de ses mouvements de solde. Code de sortie 0 : aucune anomalie ; 2 : anomalies listées ; 1 : audit impossible.

Pour une préétablie, il contrôle aussi que seul le paiement de la facture est remboursé ou conservé en crédit (jamais un règlement d'ancienne dette), que l'avoir n'est pas daté avant la facture ou un paiement, et que le mouvement d'annulation vaut −montant si la facture était déclarée, 0 sinon.

Avec `-- <idCommercial> <AAAA-MM-JJ>`, il vérifie aussi que les totaux du journal de ce jour découlent de leurs lignes : encaissé = préétablie + ancienne dette + ventes, facturé après avoirs = facturé − avoirs, encaissé après remboursements = encaissé − remboursements d'avoirs − remboursements de ventes. Des totaux « après avoirs » négatifs sont normaux quand l'avoir annule la facture d'un autre jour.

Il ne vérifie pas la clôture de tournée elle-même, ni la caisse physique, ni la correction de la facture dans le système externe : une préétablie doit être corrigée séparément là-bas.
