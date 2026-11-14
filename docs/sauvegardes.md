# Sauvegardes : préparation pour le PC de la société

Cette fiche ne lance aucune commande et ne modifie aucune donnée. La mise en place, l'automatisation et les essais de restauration restent à réaliser avant l'exploitation. Ne pas utiliser une base de production pour essayer une restauration.

## Ce qu'il faut protéger

- La base PostgreSQL contient notamment les clients, articles, soldes, opérations synchronisées et comptes. Un export PostgreSQL complet et cohérent en format personnalisé (`pg_dump -Fc`) peut être contrôlé avec `pg_restore --list` et utilisé lors d'une restauration.
- Les opérations encore hors ligne ne sont **pas** dans cette sauvegarde : elles restent sur les téléphones. Ne pas désinstaller l'application, effacer son stockage ou remplacer un appareil avant d'avoir rapproché ses files locales.
- Conserver séparément et de manière protégée les éléments nécessaires à une réinstallation : configuration, secrets, clé de signature Android et, quand il existera, certificat et clé TLS. Ne pas les placer dans Git ni les transmettre dans une conversation. Un dump ne sauvegarde pas tous les rôles et privilèges globaux PostgreSQL : leur recréation doit être prévue et testée séparément.

## Procédure à organiser

1. Identifier explicitement le serveur, le conteneur et la base à sauvegarder ; vérifier la base réellement utilisée par l'API. Ne pas supposer que deux bases de noms proches contiennent les mêmes données.
2. Faire un export avec `pg_dump` compatible avec la version du serveur. Choisir un fichier nouveau hors du dépôt, dans un emplacement avec espace suffisant et accès limité. Ne jamais écraser une sauvegarde existante. Les opérations validées après le début de l'instantané ne figurent pas dans cet export ; noter sa date et son périmètre.
3. Vérifier le code de retour de l'export, sa taille et la lecture de son catalogue avec `pg_restore --list`. Calculer son empreinte SHA-256 ; comparer l'empreinte de toute copie à l'original. Ces vérifications détectent certains problèmes mais **ne démontrent pas** qu'une restauration complète réussira.
4. Conserver plusieurs générations, dont une copie chiffrée hors du PC et hors site. Protéger la clé de chiffrement séparément et tester l'accès autorisé. Définir une fréquence, une durée de conservation et une personne responsable ; surveiller et signaler les échecs.
5. Tester périodiquement une restauration **dans une base isolée**, jamais sur `sls` ni sur la base utilisée par les téléphones. Vérifier les clients, articles, comptes et opérations, ainsi que le fonctionnement de l'application de test. Documenter le résultat et la durée de reprise. Ne pas connecter des téléphones réels à cette copie : une restauration conserve l'identité de lignée et peut diverger de l'original.
6. Avant tout déplacement ou retour arrière réel, arrêter et coordonner les écritures, préserver les files des téléphones, identifier les opérations postérieures à la sauvegarde et prévoir leur rapprochement. Une restauration ancienne peut perdre des opérations déjà synchronisées ; elle n'est pas un retour arrière automatique sûr.

Sur Windows, éviter de rediriger directement un flux binaire `docker exec` vers un fichier avec PowerShell. Si PostgreSQL est dans Docker, une méthode déjà employée consiste à créer un dump dans le conteneur, utiliser `docker cp`, puis vérifier le catalogue et comparer les empreintes. Le fichier temporaire dans le conteneur contient aussi des données sensibles : le protéger et le supprimer uniquement après copie et vérifications réussies. Adapter les commandes au conteneur et à la base effectivement identifiés, sans afficher de mot de passe.

Le fichier `.gitignore` exclut les extensions courantes `.dump` et `.backup` et les fichiers SQLite courants, mais ce n'est pas une protection des données : d'autres noms ou fichiers déjà suivis peuvent être ajoutés à Git. Ne pas stocker de sauvegardes dans le dépôt.
