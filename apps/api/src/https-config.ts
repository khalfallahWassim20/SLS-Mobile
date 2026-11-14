import {readFileSync} from 'node:fs';
import {X509Certificate,createPrivateKey,createPublicKey} from 'node:crypto';
import {isIP} from 'node:net';
import type {ServerOptions} from 'node:https';

type Environment=Record<string,string|undefined>;
export type TransportConfig={tls:ServerOptions|null;addressHttps:boolean;hsts:{host:string;maxAge:number}|null};

function validateExpectedHost(value:string):string {
 if(!value||value!==value.trim()||value.length>253)throw Error('Nom TLS attendu invalide : utilisez un nom DNS ou une IP, sans port.');
 if(isIP(value))return value;
 const host=value.toLowerCase(),labels=host.split('.');
 if(labels.some(label=>!/^([a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/.test(label)))throw Error('Nom TLS attendu invalide : utilisez un nom DNS ou une IP, sans port.');
 return host;
}

/** Configuration explicite, sans proxy ni repli HTTP en cas d'erreur TLS.
 * Le SAN local ne prouve ni la confiance des clients ni l'identité du serveur. */
export function readTransportConfig(env:Environment):TransportConfig {
 const test=env.SLS_ADDRESS_TEST_ONLY==='DONNEES_FICTIVES_ISOLEES';
 if(env.SLS_REQUIRE_HTTPS!==undefined&&env.SLS_REQUIRE_HTTPS!=='1')throw Error('SLS_REQUIRE_HTTPS doit valoir 1 ou être absent.');
 const requireHttps=env.SLS_REQUIRE_HTTPS==='1';
 const privateHttp=env.SLS_ADDRESS_PRIVATE_HTTP==='J_ACCEPTE_LES_RISQUES_HTTP';
 const addressHttps=env.SLS_ADDRESS_HTTPS==='J_ACTIVE_HTTPS';
 const testKey=env.SLS_ADDRESS_TEST_TLS_KEY,testCert=env.SLS_ADDRESS_TEST_TLS_CERT;
 const keyPath=env.SLS_TLS_KEY,certPath=env.SLS_TLS_CERT;
 if(test&&privateHttp||addressHttps&&(test||privateHttp))throw Error('Modes de changement d’adresse incompatibles.');
 if(test&&env.SLS_V5_TEST_ONLY!=='DONNEES_FICTIVES_ISOLEES')throw Error('Le mode TLS de test exige une base fictive v5.');
 if((testKey||testCert)&&!test)throw Error('Les paramètres TLS de test exigent SLS_ADDRESS_TEST_ONLY.');
 if(test&&(keyPath||certPath))throw Error('Ne pas mélanger certificats de test et certificats HTTPS.');
 if(privateHttp&&(keyPath||certPath))throw Error('Le mode HTTP privé ne peut pas être combiné avec le serveur HTTPS.');
 if(requireHttps&&(privateHttp||test))throw Error('HTTPS obligatoire incompatible avec le mode HTTP privé ou le mode de test.');
 const keyFile=test?testKey:keyPath,certFile=test?testCert:certPath,hostValue=env.SLS_TLS_EXPECTED_HOST;
 const hstsValue=env.SLS_HSTS_MAX_AGE;
 if(hstsValue!==undefined&&(!/^(0|[1-9][0-9]{0,7})$/.test(hstsValue)||Number(hstsValue)>31536000))throw Error('Durée HSTS invalide : de 0 à 31536000 secondes.');
 if(hstsValue!==undefined&&!requireHttps)throw Error('HSTS exige HTTPS obligatoire et un nom DNS vérifié.');
 if((keyFile&&!certFile)||(!keyFile&&certFile)||((test||addressHttps||requireHttps)&&(!keyFile||!certFile)))throw Error('Configurer ensemble une clé et un certificat TLS.');
 if(requireHttps&&!hostValue)throw Error('Configurer SLS_TLS_EXPECTED_HOST pour vérifier le nom du certificat.');
 if(hostValue!==undefined&&!keyFile)throw Error('Un nom TLS attendu exige une configuration TLS.');
 if(!keyFile||!certFile)return {tls:null,addressHttps:false,hsts:null};
 // Les fichiers PEM peuvent contenir la chaîne complète, certificat serveur en premier.
 const key=readFileSync(keyFile),cert=readFileSync(certFile),leaf=new X509Certificate(cert);
 const now=Date.now();
 if(now<Date.parse(leaf.validFrom)||now>=Date.parse(leaf.validTo))throw Error('Certificat TLS expiré ou pas encore valide.');
 const a=createPublicKey(createPrivateKey(key)).export({type:'spki',format:'der'}),b=leaf.publicKey.export({type:'spki',format:'der'});
 if(!a.equals(b))throw Error('La clé TLS ne correspond pas au certificat.');
 let hsts:TransportConfig['hsts']=null;
 if(hostValue!==undefined){
  const host=validateExpectedHost(hostValue);
  const match=isIP(host)?leaf.checkIP(host):leaf.checkHost(host,{subject:'never',partialWildcards:false,multiLabelWildcards:false,singleLabelSubdomains:false});
  if(!match)throw Error('Le certificat TLS ne couvre pas le nom ou l’adresse attendu dans son SAN.');
  if(hstsValue!==undefined){if(isIP(host))throw Error('HSTS exige un nom DNS, pas une adresse IP.');hsts={host,maxAge:Number(hstsValue)};}
 }
 return {tls:{key,cert,minVersion:'TLSv1.2'},addressHttps,hsts};
}
