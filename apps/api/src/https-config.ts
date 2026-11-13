import {readFileSync} from 'node:fs';
import {X509Certificate,createPrivateKey,createPublicKey} from 'node:crypto';
import type {ServerOptions} from 'node:https';

type Environment=Record<string,string|undefined>;
export type TransportConfig={tls:ServerOptions|null;addressHttps:boolean};

/** Configuration explicite, sans proxy ni repli HTTP en cas d'erreur TLS.
 * La confiance de l'appareil et le nom du certificat restent à vérifier côté client. */
export function readTransportConfig(env:Environment):TransportConfig {
 const test=env.SLS_ADDRESS_TEST_ONLY==='DONNEES_FICTIVES_ISOLEES';
 const privateHttp=env.SLS_ADDRESS_PRIVATE_HTTP==='J_ACCEPTE_LES_RISQUES_HTTP';
 const addressHttps=env.SLS_ADDRESS_HTTPS==='J_ACTIVE_HTTPS';
 const testKey=env.SLS_ADDRESS_TEST_TLS_KEY,testCert=env.SLS_ADDRESS_TEST_TLS_CERT;
 const keyPath=env.SLS_TLS_KEY,certPath=env.SLS_TLS_CERT;
 if(test&&privateHttp||addressHttps&&(test||privateHttp))throw Error('Modes de changement d’adresse incompatibles.');
 if(test&&env.SLS_V5_TEST_ONLY!=='DONNEES_FICTIVES_ISOLEES')throw Error('Le mode TLS de test exige une base fictive v5.');
 if((testKey||testCert)&&!test)throw Error('Les paramètres TLS de test exigent SLS_ADDRESS_TEST_ONLY.');
 if(test&&(keyPath||certPath))throw Error('Ne pas mélanger certificats de test et certificats HTTPS.');
 if(privateHttp&&(keyPath||certPath))throw Error('Le mode HTTP privé ne peut pas être combiné avec le serveur HTTPS.');
 const keyFile=test?testKey:keyPath,certFile=test?testCert:certPath;
 if((keyFile&&!certFile)||(!keyFile&&certFile)||((test||addressHttps)&&(!keyFile||!certFile)))throw Error('Configurer ensemble une clé et un certificat TLS.');
 if(!keyFile||!certFile)return {tls:null,addressHttps:false};
 // Les fichiers PEM peuvent contenir la chaîne complète, certificat serveur en premier.
 const key=readFileSync(keyFile),cert=readFileSync(certFile),leaf=new X509Certificate(cert);
 const now=Date.now();
 if(now<Date.parse(leaf.validFrom)||now>=Date.parse(leaf.validTo))throw Error('Certificat TLS expiré ou pas encore valide.');
 const a=createPublicKey(createPrivateKey(key)).export({type:'spki',format:'der'}),b=leaf.publicKey.export({type:'spki',format:'der'});
 if(!a.equals(b))throw Error('La clé TLS ne correspond pas au certificat.');
 return {tls:{key,cert,minVersion:'TLSv1.2'},addressHttps};
}
