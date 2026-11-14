# Préparation de l’APK Android

Le profil `preview` dans `apps/mobile/eas.json` demande un **APK interne de test**, pas une version de production. Il conserve le package Android `com.slsmobile.app` défini dans `app.json`. La construction n’a pas été lancée : elle nécessite un projet EAS associé, un compte Expo et une clé de signature. Elle ne remplace pas la validation sur un téléphone et ne règle pas la sécurité de production.

## Avant toute installation

- **Expo Go et l’APK sont deux applications distinctes.** Leurs bases SQLite et leur stockage sécurisé ne sont pas partagés. Installer l’APK ne reprend pas les ventes, dépenses ou files enregistrées dans Expo Go. Une procédure de transfert fiable n’est pas encore fournie. Ne pas désinstaller Expo Go, effacer ses données ou supposer que synchroniser seul transfère tout l’historique local.
- Utiliser d’abord un appareil et des données fictifs ; vérifier les files sur tous les appareils avant toute transition. Une opération hors ligne d’un téléphone absent n’est pas visible sur le serveur.
- Ne pas utiliser l’APK sur les données de la société avant validation métier, sécurité et tests physiques. L’application locale n’est pas chiffrée. Les fonctions expérimentales d’avoir restent désactivées et hors périmètre.
- L’APK et l’API doivent utiliser une origine cohérente. Préparer HTTPS avec un nom et certificat reconnus par Android, selon `docs/https-api.md`. Ce profil ne désactive pas les contrôles TLS et n’installe aucune autorité. Ne pas présumer qu’un APK de version autorise le HTTP en clair utilisé auparavant dans Expo Go.

## Construire un APK de test

Depuis un poste autorisé, après installation de Node et des dépendances, associer d’abord `apps/mobile` à un projet Expo/EAS contrôlé par la société avec `eas build:configure`. Cette opération peut modifier la configuration locale et exige une décision sur le compte et le projet ; vérifier les changements avant de les enregistrer. Ne pas transmettre de mots de passe, jetons, clés ou fichiers de signature dans le dépôt ou une conversation.

Une fois le projet associé, depuis `apps/mobile` :

```sh
eas build --platform android --profile preview
```

EAS produit un APK signé destiné aux essais internes ; son téléchargement et l’installation nécessitent l’accès approprié. Les variables `EXPO_PUBLIC_*` sont intégrées au code distribué : elles ne doivent contenir **aucun secret**. Ne pas activer les indicateurs `*_TEST_ONLY` pour un build normal.

## Signature et mises à jour

L’identifiant `com.slsmobile.app` et la clé de signature déterminent si Android accepte une mise à jour par-dessus l’APK installé. La société doit conserver le contrôle et une sauvegarde protégée de la clé et de ses autorisations. Une autre clé ou un autre identifiant peut imposer une nouvelle installation distincte ou une désinstallation, qui risque de perdre les données locales. Ne jamais désinstaller pour contourner un échec d’installation.

Avant diffusion, définir une politique de versions et de sauvegarde, vérifier qu’une mise à jour signée conserve les données et files locales sur un appareil de test, et valider HTTPS ainsi que les scénarios hors ligne. La migration Expo Go → APK nécessite sa propre procédure vérifiée ; elle n’est pas réalisée ici.
