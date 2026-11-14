# HTTPS pour l’API — préparation et limites

Cette configuration active TLS directement dans le processus API, sans proxy et sans port HTTP de secours. Elle est **désactivée par défaut**. Elle ne rend pas à elle seule l’application prête pour la production et ne prouve pas que la base candidate est la bonne. Aucun certificat ni changement de données n’est fourni ou installé automatiquement.

## Certificat et nom

Choisir un nom DNS accessible depuis le téléphone et le PC et obtenir auprès d’une autorité de confiance un certificat serveur valide pour ce nom (SAN), avec sa chaîne intermédiaire et la clé privée correspondante. Une adresse IP nécessite un SAN IP exact ; un certificat pour un nom DNS ne valide pas une IP. Les autorités publiques ne délivrent généralement pas de certificat pour des IP privées. Un nom public peut résoudre vers une IP privée sur le réseau local, mais son contrôle et la délivrance du certificat doivent être réalisés correctement.

Une autorité privée est envisageable uniquement si **chaque client** lui fait effectivement confiance : installer un certificat utilisateur sur Android ne garantit pas qu’Expo Go ou une application Android lui fera confiance. Ne jamais contourner la validation, désactiver TLS, ajouter `NODE_TLS_REJECT_UNAUTHORIZED=0`, ni enregistrer les clés dans Git. Protéger la clé privée par les permissions du système, hors du dépôt ; un certificat autosigné de test n'est pas une solution automatiquement fiable pour Android.

## API

Après obtention et vérification du certificat, configurer dans l’environnement du processus API :

- `SLS_TLS_KEY` : chemin du fichier PEM de la clé privée non chiffrée, accessible uniquement au compte serveur.
- `SLS_TLS_CERT` : chemin du certificat serveur PEM suivi des éventuels intermédiaires (full chain).
- `SLS_REQUIRE_HTTPS=1` : garde recommandée une fois HTTPS déployé. Si la clé, le certificat ou le nom attendu manquent, l’API refuse de démarrer au lieu de démarrer en HTTP. Une valeur différente de `1` est une erreur ; supprimer la variable pour conserver le mode HTTP temporaire de test. Ce réglage est incompatible avec le mode HTTP privé et le mode TLS fictif.
- `SLS_TLS_EXPECTED_HOST` : nom DNS ou adresse IP utilisé pour joindre l’API, sans protocole ni port (par exemple `api.example.com`). Obligatoire si `SLS_REQUIRE_HTTPS=1`, facultatif sinon. Au démarrage, le certificat serveur doit porter ce nom ou cette IP dans son extension SAN ; le seul nom commun CN ne suffit pas. Si plusieurs noms sont utilisés, ils doivent tous être contrôlés séparément côté clients : ce paramètre ne valide que le nom configuré.
- `API_HOST` et `PORT` : interface et port appropriés. L’accès réseau et le pare-feu doivent être limités.
- Pour exposer **en plus** les routes de rapprochement d’adresse sur HTTPS : `SLS_ADDRESS_HTTPS=J_ACTIVE_HTTPS`.

Les deux fichiers sont obligatoires ensemble. Un certificat expiré ou pas encore valide, une clé différente ou une configuration contradictoire empêche le démarrage ; l’API ne revient pas automatiquement à HTTP. TLS 1.2 minimum est imposé. Quand `SLS_TLS_EXPECTED_HOST` est défini, le SAN du certificat est contrôlé localement pour ce seul nom. Le serveur ne vérifie pas si Android fait confiance à l’autorité ou si le certificat est révoqué : cela doit être vérifié côté client. Prévoir une procédure de renouvellement du certificat et un redémarrage contrôlé pour le charger.

Les réponses sous `/api` portent `Cache-Control: no-store` et `X-Content-Type-Options: nosniff`, y compris les erreurs d’authentification. Ces en-têtes réduisent certains risques de cache et d’interprétation du contenu mais ne chiffrent pas les échanges ni le stockage du téléphone.

### HSTS facultatif

Après validation du nom DNS, du certificat et de leur renouvellement, `SLS_HSTS_MAX_AGE` peut fixer une durée en secondes de `0` à `31536000`. Il exige `SLS_REQUIRE_HTTPS=1` et un `SLS_TLS_EXPECTED_HOST` DNS (pas une IP) valide dans le SAN. L’en-tête `Strict-Transport-Security` est émis uniquement sur HTTPS pour ce nom, sans `includeSubDomains` ni `preload` ; il est absent par défaut et le HTTP temporaire reste inchangé. Il concerne les clients qui respectent HSTS, pas nécessairement l’application Android native ; il ne protège pas la première connexion ni ne remplace la validation du certificat. Un navigateur peut garder cette règle jusqu’à son expiration : choisir une durée courte au départ. Supprimer la variable n’efface pas une règle déjà mémorisée ; `0` demande son effacement uniquement si le navigateur reçoit cette réponse en HTTPS valide sur le même nom. Ne pas activer HSTS avant d’être sûr de pouvoir maintenir HTTPS sur ce nom.

Ne pas associer `SLS_ADDRESS_HTTPS` au mode HTTP privé `SLS_ADDRESS_PRIVATE_HTTP`, ni aux paramètres de test `SLS_ADDRESS_TEST_ONLY` / `SLS_ADDRESS_TEST_TLS_*`. Le mode d’essai v5 HTTPS préexistant reste réservé aux données fictives. Une activation HTTPS ne synchronise ni ne migre automatiquement le téléphone ; l’approbation et les autres contrôles de continuité restent nécessaires. Une copie ou restauration de base peut passer ces contrôles. Ne pas utiliser la procédure avec des données réelles tant que l’identité de la base et la protection complète des flux ne sont pas établies.

## Administration et mobile

L’administration doit être ouverte en contexte sécurisé (localhost sur le PC ou HTTPS correctement configuré). Pour éviter d’exposer Vite sur le réseau, une option désactivée par défaut permet à l’API HTTPS directe de servir la version construite de l’administration depuis la même origine :

1. Construire les fichiers fiables avec `npm run build --workspace @sls/admin`. Ne pas utiliser de variables `VITE_*_TEST_ONLY` pour un usage normal.
2. Configurer HTTPS comme ci-dessus, avec `SLS_REQUIRE_HTTPS=1` et un `SLS_TLS_EXPECTED_HOST` couvert par le certificat. Configurer `SLS_ADMIN_STATIC_DIR` avec le **chemin absolu** du dossier construit `apps/admin/dist` ; le processus API doit pouvoir le lire, mais seuls les administrateurs du serveur doivent pouvoir le modifier.
3. Redémarrer l’API et ouvrir `https://nom-configuré:port/` sur un client qui reconnaît le certificat. L’interface utilise `/api` sur cette même origine ; aucun proxy Vite ni HTTP supplémentaire n’est requis. Seuls `index.html` et le répertoire `assets` sont servis ; les fichiers cachés ne le sont pas. L’API refuse de démarrer avec cette option si HTTPS obligatoire ou le nom vérifié manquent, ou si les fichiers de construction sont absents ou contiennent des liens symboliques. Elle refuse l’interface pour un autre nom d’hôte. Les contrôles de fichiers au démarrage ne remplacent pas les permissions système : ne pas modifier le dossier en cours d’exécution.
4. Vérifier la connexion et les fonctions sur un environnement isolé avant tout usage réel. Le certificat, la configuration et le serveur réels ne sont pas installés automatiquement par le projet ; l’accès doit rester limité par le réseau et le pare-feu. Un build expérimental ne devient pas une application validée pour la production grâce à HTTPS.

Pour le serveur de développement admin, `SLS_ADMIN_API_PROXY` peut cibler `https://nom-valide:port` ; le proxy vérifie le certificat et son nom. Si une autorité privée est employée, Node doit la reconnaître au démarrage, par exemple via `NODE_EXTRA_CA_CERTS` pointant vers le certificat **public de l’autorité**, jamais vers sa clé privée. Cela ne configure pas la confiance Android. Ne pas exposer le serveur de développement admin en HTTP à d’autres machines ni saisir de secrets dans une page servie en HTTP sur le réseau.

Sur Android, l’adresse saisie doit correspondre exactement au nom couvert par le certificat. La confiance effective doit être testée dans l’application elle-même, pas seulement dans le navigateur. Pendant le développement avec Expo Go, la distribution du bundle JavaScript et la sécurité du réseau de développement doivent aussi être considérées : HTTPS pour l’API ne sécurise pas automatiquement le chargement d’un bundle Expo servi en HTTP.

## Validation avant utilisation

Sur un environnement fictif isolé : vérifier l’échec avec une autorité inconnue, un nom erroné et un certificat expiré, puis le succès avec le nom et la chaîne reconnus ; vérifier qu’aucun port HTTP n’est exposé en parallèle. Tester le proxy admin et l’application Android réels. Tester séparément la préservation des files locales et l’identification de la bonne base. Une sauvegarde vérifiée et une procédure de retour arrière restent indispensables. Les tests automatisés du dépôt utilisent des certificats jetables ; ils ne constituent pas une validation sur le téléphone ou le réseau de l’utilisateur.

## Vérification technique depuis le PC

Le diagnostic facultatif `npm run verifier:https -- https://nom-serveur:port` établit seulement une connexion TLS, sans envoyer de mot de passe ni requête HTTP. Il vérifie la chaîne avec les autorités reconnues par Node et exige que le nom ou l’IP figure dans le SAN, puis affiche le protocole, l’expiration et l’empreinte SHA-256 du certificat. Si une autorité privée a été établie et vérifiée par un canal indépendant, son certificat **public** peut être fourni en second argument : `npm run verifier:https -- https://nom-serveur:port chemin-vers-autorite-publique.pem`. Cela remplace les autorités utilisées pour ce diagnostic ; cela n’installe rien et ne modifie ni la base ni le téléphone. Ne jamais fournir une clé privée. Un certificat autosigné accepté volontairement ne devient pas de ce fait authentique.

Un résultat positif n’atteste que la confiance de ce processus Node et la correspondance du nom à ce moment-là. Il ne prouve ni la confiance d’Android, ni l’identité de la base ; l’empreinte n’est pas une preuve si elle n’a pas été comparée par un canal indépendant. Les essais automatisés `npm run test:https` nécessitent OpenSSL et utilisent exclusivement des certificats et serveurs temporaires ; ils vérifient également le proxy de développement admin avec une autorité inconnue, un nom erroné et une autorité reconnue.

Pour un téléphone déjà lié, la connexion commerciale ordinaire vérifie désormais l’origine enregistrée avant de transmettre le mot de passe : une autre adresse, y compris un retour de HTTPS vers HTTP, est refusée. Il faut utiliser le parcours distinct de changement d’adresse. Ce garde-fou ne remplace ni TLS ni la vérification de l’identité de la base, et ne constitue pas une garantie contre une redirection ou une application compromise. Dans le parcours de changement d’adresse, la confirmation des risques HTTP est exigée pour une cible HTTP privée, mais pas pour une cible HTTPS.
