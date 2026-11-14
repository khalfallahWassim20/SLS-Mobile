import {connect as tlsConnect} from 'node:tls';
import {isIP} from 'node:net';
import {checkStrictServerIdentity,parseHttpsOrigin} from './https-identity.js';

/** Contrôle réseau depuis Node seulement. Aucun identifiant ni requête HTTP. */
export async function probeHttps(origin:string,ca?:Buffer,timeoutMs=5000):Promise<{origin:string;protocol:string;expiresAt:string;fingerprint256:string}>{
 const {host,port}=parseHttpsOrigin(origin);
 return new Promise((resolve,reject)=>{
  const socket=tlsConnect({host,port,servername:isIP(host)?undefined:host,ca,rejectUnauthorized:true,minVersion:'TLSv1.2',checkServerIdentity:(_name,peer)=>checkStrictServerIdentity(host,peer)});
  socket.setTimeout(timeoutMs,()=>socket.destroy(Error('Délai de connexion HTTPS dépassé.')));
  socket.once('error',reject);
  socket.once('secureConnect',()=>{
   try{
    if(!socket.authorized)throw Error('Certificat non reconnu.');
    const peer=socket.getPeerCertificate(),protocol=socket.getProtocol();
    if(!peer.fingerprint256||!peer.valid_to||!protocol)throw Error('Certificat ou protocole indisponible.');
    resolve({origin,protocol,expiresAt:new Date(peer.valid_to).toISOString(),fingerprint256:peer.fingerprint256});
   }catch(e){reject(e);}finally{socket.end();}
  });
 });
}
