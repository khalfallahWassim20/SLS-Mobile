# Préparation de la facture du jour

La migration PostgreSQL relançable inclut les registres préparatoires des paiements unifiés, règlements d'ancienne dette et compensations. Elle ne transforme pas les opérations existantes et **n'active ni les routes v6 ni les écrans mobiles normaux**. Si un registre contient déjà des opérations, les anciens traitements incompatibles restent bloqués plutôt que de présenter un solde erroné.

Les essais automatisés utilisent des bases fictives. Ils vérifient notamment une migration répétée avec conservation des clients, articles, commerciaux, ventes, préétablies, clôtures et de la lignée ; ils vérifient aussi le maintien des gardes et l'absence de routes v6 sur le routeur normal. Ils ne prouvent pas que tous les téléphones réels ont synchronisé leurs opérations.

Avant toute migration réelle, conserver une sauvegarde vérifiée de la base et les données locales des téléphones. Une restauration, une base copiée ou un téléphone non synchronisé peut nécessiter un rapprochement. Cette préparation ne vaut pas autorisation d'activer le paiement unique, les compensations ou la clôture v6 en production ; les projections normales, les conflits et les tests sur téléphone restent à terminer.
