import {checkServerIdentity,type PeerCertificate} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {isIP} from 'node:net';

/** Vérification système ET SAN explicite, sans repli sur le seul CN. */
export function checkStrictServerIdentity(host:string,peer:PeerCertificate):Error|undefined {
 const standard=checkServerIdentity(host,peer);if(standard)return standard;
 try{
  const leaf=new X509Certificate(peer.raw);
  const match=isIP(host)?leaf.checkIP(host):leaf.checkHost(host,{subject:'never',partialWildcards:false,multiLabelWildcards:false,singleLabelSubdomains:false});
  if(!match)return Error('Le certificat ne couvre pas cette adresse dans son SAN.');
 }catch{return Error('Certificat serveur invalide.');}
 return undefined;
}
/** N'accepter qu'une origine canonique, sans chemin, identifiants ou paramètres. */
export function parseHttpsOrigin(origin:string):{host:string;port:number} {
 let url:URL;try{url=new URL(origin);}catch{throw Error('Adresse HTTPS invalide.');}
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.origin!==origin)throw Error('Indiquer uniquement une origine HTTPS canonique, sans chemin ni identifiants.');
 return {host:url.hostname.replace(/^\[|\]$/g,''),port:url.port?Number(url.port):443};
}
