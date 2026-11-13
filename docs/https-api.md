# HTTPS pour l’API — préparation et limites

Cette configuration active TLS directement dans le processus API, sans proxy et sans port HTTP de secours. Elle est **désactivée par défaut**. Elle ne rend pas à elle seule l’application prête pour la production et ne prouve pas que la base candidate est la bonne. Aucun certificat ni changement de données n’est fourni ou installé automatiquement.

## Certificat et nom

Choisir un nom DNS accessible depuis le téléphone et le PC et obtenir auprès d’une autorité de confiance un certificat serveur valide pour ce nom (SAN), avec sa chaîne intermédiaire et la clé privée correspondante. Une adresse IP nécessite un SAN IP exact ; un certificat pour un nom DNS ne valide pas une IP. Les autorités publiques ne délivrent généralement pas de certificat pour des IP privées. Un nom public peut résoudre vers une IP privée sur le réseau local, mais son contrôle et la délivrance du certificat doivent être réalisés correctement.

Une autorité privée est envisageable uniquement si **chaque client** lui fait effectivement confiance : installer un certificat utilisateur sur Android ne garantit pas qu’Expo Go ou une application Android lui fera confiance. Ne jamais contourner la validation, désactiver TLS, ajouter `NODE_TLS_REJECT_UNAUTHORIZED=0`, ni enregistrer les clés dans Git. Protéger la clé privée par les permissions du système, hors du dépôt ; un certificat autosigné de test n'est pas une solution automatiquement fiable pour Android.

## API

Après obtention et vérification du certificat, configurer dans l’environnement du processus API :

- `SLS_TLS_KEY` : chemin du fichier PEM de la clé privée non chiffrée, accessible uniquement au compte serveur.
- `SLS_TLS_CERT` : chemin du certificat serveur PEM suivi des éventuels intermédiaires (full chain).
- `API_HOST` et `PORT` : interface et port appropriés. L’accès réseau et le pare-feu doivent être limités.
- Pour exposer **en plus** les routes de rapprochement d’adresse sur HTTPS : `SLS_ADDRESS_HTTPS=J_ACTIVE_HTTPS`.

Les deux fichiers sont obligatoires ensemble. Un certificat expiré ou pas encore valide, une clé différente ou une configuration contradictoire empêche le démarrage ; l’API ne revient pas automatiquement à HTTP. TLS 1.2 minimum est imposé. Le serveur ne vérifie pas si Android fait confiance au certificat, si son SAN correspond au nom utilisé, ni si le certificat est révoqué : cela doit être vérifié côté client. Prévoir une procédure de renouvellement du certificat et un redémarrage contrôlé pour le charger.

Ne pas associer `SLS_ADDRESS_HTTPS` au mode HTTP privé `SLS_ADDRESS_PRIVATE_HTTP`, ni aux paramètres de test `SLS_ADDRESS_TEST_ONLY` / `SLS_ADDRESS_TEST_TLS_*`. Le mode d’essai v5 HTTPS préexistant reste réservé aux données fictives. Une activation HTTPS ne synchronise ni ne migre automatiquement le téléphone ; l’approbation et les autres contrôles de continuité restent nécessaires. Une copie ou restauration de base peut passer ces contrôles. Ne pas utiliser la procédure avec des données réelles tant que l’identité de la base et la protection complète des flux ne sont pas établies.

## Administration et mobile

L’administration doit être ouverte en contexte sécurisé (localhost sur le PC ou HTTPS correctement configuré). Pour le serveur de développement admin, `SLS_ADMIN_API_PROXY` peut cibler `https://nom-valide:port` ; le proxy vérifie le certificat et son nom. Si une autorité privée est employée, Node doit la reconnaître au démarrage, par exemple via `NODE_EXTRA_CA_CERTS` pointant vers le certificat **public de l’autorité**, jamais vers sa clé privée. Cela ne configure pas la confiance Android. Ne pas exposer le serveur de développement admin en HTTP à d’autres machines ni saisir de secrets dans une page servie en HTTP sur le réseau.

Sur Android, l’adresse saisie doit correspondre exactement au nom couvert par le certificat. La confiance effective doit être testée dans l’application elle-même, pas seulement dans le navigateur. Pendant le développement avec Expo Go, la distribution du bundle JavaScript et la sécurité du réseau de développement doivent aussi être considérées : HTTPS pour l’API ne sécurise pas automatiquement le chargement d’un bundle Expo servi en HTTP.

## Validation avant utilisation

Sur un environnement fictif isolé : vérifier l’échec avec une autorité inconnue, un nom erroné et un certificat expiré, puis le succès avec le nom et la chaîne reconnus ; vérifier qu’aucun port HTTP n’est exposé en parallèle. Tester le proxy admin et l’application Android réels. Tester séparément la préservation des files locales et l’identification de la bonne base. Une sauvegarde vérifiée et une procédure de retour arrière restent indispensables. Les tests automatisés du dépôt utilisent des certificats jetables ; ils ne constituent pas une validation sur le téléphone ou le réseau de l’utilisateur.

## Vérification technique depuis le PC

Le diagnostic facultatif `npm run verifier:https -- https://nom-serveur:port` établit seulement une connexion TLS, sans envoyer de mot de passe ni requête HTTP. Il vérifie la chaîne et le nom avec les autorités reconnues par Node, puis affiche le protocole, l’expiration et l’empreinte SHA-256 du certificat. Si une autorité privée a été établie et vérifiée par un canal indépendant, son certificat **public** peut être fourni en second argument : `npm run verifier:https -- https://nom-serveur:port chemin-vers-autorite-publique.pem`. Cela remplace les autorités utilisées pour ce diagnostic ; cela n’installe rien et ne modifie ni la base ni le téléphone. Ne jamais fournir une clé privée. Un certificat autosigné accepté volontairement ne devient pas de ce fait authentique.

Un résultat positif n’atteste que la confiance de ce processus Node et la correspondance du nom à ce moment-là. Il ne prouve ni la confiance d’Android, ni l’identité de la base ; l’empreinte n’est pas une preuve si elle n’a pas été comparée par un canal indépendant. Les essais automatisés `npm run test:https` nécessitent OpenSSL et utilisent exclusivement des certificats et serveurs temporaires ; ils vérifient également le proxy de développement admin avec une autorité inconnue, un nom erroné et une autorité reconnue.

Pour un téléphone déjà lié, la connexion commerciale ordinaire vérifie désormais l’origine enregistrée avant de transmettre le mot de passe : une autre adresse, y compris un retour de HTTPS vers HTTP, est refusée. Il faut utiliser le parcours distinct de changement d’adresse. Ce garde-fou ne remplace ni TLS ni la vérification de l’identité de la base, et ne constitue pas une garantie contre une redirection ou une application compromise. Dans le parcours de changement d’adresse, la confirmation des risques HTTP est exigée pour une cible HTTP privée, mais pas pour une cible HTTPS.
