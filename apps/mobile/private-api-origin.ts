/** Adresses IPv4 privées uniquement : l'activation HTTP reste explicite et
 * n'offre aucune confidentialité ou authentification du réseau. */
export function isPrivateHttpOrigin(value:string):boolean{
 try{const u=new URL(value);if(u.protocol!=='http:'||u.origin!==value||u.username||u.password||u.pathname!=='/'||u.search||u.hash)return false;
  const p=u.hostname.split('.');if(p.length!==4||p.some(x=>!/^\d+$/.test(x)||String(Number(x))!==x||Number(x)>255))return false;
  const n=p.map(Number);return n[0]===10||(n[0]===172&&n[1]>=16&&n[1]<=31)||(n[0]===192&&n[1]===168);
 }catch{return false;}
}
/** Avant toute connexion de récupération : HTTPS ou HTTP privé explicitement accepté. */
export function assertAddressRecoveryTransport(origin:string,allowPrivateHttp:boolean,acknowledged:boolean):void{
 try{const url=new URL(origin);if(url.protocol==='https:'&&url.origin===origin&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash)return;}catch{/* refus prudent */}
 if(!allowPrivateHttp||!isPrivateHttpOrigin(origin))throw Error('Adresse refusée : HTTPS ou IP privée autorisée requis. Aucun mot de passe envoyé.');
 if(!acknowledged)throw Error('Confirmez les risques du HTTP avant de continuer.');
}
