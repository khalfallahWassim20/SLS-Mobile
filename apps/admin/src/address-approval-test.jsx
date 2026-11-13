import React,{useState} from 'react';
/** Interface d'essai isolé : l'administrateur doit comparer la demande avec le
 * téléphone et confirmer la base ; cela n'authentifie pas une ancienne base. */
export function AddressApprovalTest({request,commercials,allowPrivateHttp=false}){
 const secure=typeof window!=='undefined'&&window.isSecureContext===true;
 const [text,setText]=useState(''),[review,setReview]=useState(null),[confirmed,setConfirmed]=useState(false),[result,setResult]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 function inspect(){setError('');setResult(null);setConfirmed(false);try{
  const data=JSON.parse(text),keys=['commercialId','lineageId','previousOrigin','requestId','targetOrigin'];
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).sort().join(',')!==keys.sort().join(',')||keys.some(k=>typeof data[k]!=='string'))throw Error('Demande invalide.');
  const c=commercials.find(item=>item.id===data.commercialId&&item.active);if(!c)throw Error('Commercial actif introuvable dans cette base.');
  const target=new URL(data.targetOrigin),parts=target.hostname.split('.').map(Number);
  const privateIp=parts.length===4&&target.hostname.split('.').every(x=>/^\d+$/.test(x)&&String(Number(x))===x&&Number(x)<=255)&&(parts[0]===10||parts[0]===192&&parts[1]===168||parts[0]===172&&parts[1]>=16&&parts[1]<=31);
  if(target.origin!==data.targetOrigin||target.protocol!=='https:'&&!(allowPrivateHttp&&target.protocol==='http:'&&privateIp))throw Error('Adresse refusée : HTTPS ou IP privée explicitement autorisée requis.');
  setReview({...data,commercialName:c.name});
 }catch(e){setReview(null);setError(e instanceof Error?e.message:'Demande invalide.');}}
 async function issue(){if(!secure||!review||!confirmed||busy)return;setBusy(true);setError('');try{
  const {commercialName:_name,...data}=review;
  const value=await request('address-approvals',{method:'POST',body:JSON.stringify({...data,confirmation:'J_AI_VERIFIE_LA_BASE_ET_LE_TELEPHONE'})});
  if(value.requestId!==data.requestId||typeof value.code!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.code)||typeof value.expiresAt!=='string'||!Number.isFinite(Date.parse(value.expiresAt)))throw Error('Réponse de serveur invalide.');
  setResult(value);setConfirmed(false);
 }catch(e){setError(e instanceof Error?e.message:'Autorisation impossible.');}finally{setBusy(false);}}
 async function revoke(){if(!result||busy)return;setBusy(true);setError('');try{await request(`address-approvals/${encodeURIComponent(result.requestId)}/revoke`,{method:'POST',body:'{}'});setResult(null);}catch(e){setError(e instanceof Error?e.message:'Révocation impossible.');}finally{setBusy(false);}}
 if(!secure)return <section className="panel"><h2>Changement d’adresse · essai isolé</h2><p role="alert" className="error">Contexte sécurisé requis : HTTPS ou administration locale sur localhost.</p></section>;
 return <section className="panel"><h2>Changement d’adresse</h2><p className="notice warn-box">Une copie ou restauration peut avoir la même lignée : vérifiez la base vous-même. En HTTP, les mots de passe, le code et les données peuvent être interceptés. Utilisez uniquement un réseau privé de confiance.</p>
 <label>Demande affichée sur le téléphone<textarea value={text} onChange={e=>{setText(e.target.value);setReview(null);setResult(null);setConfirmed(false);}} rows={6} style={{width:'100%'}} /></label>
 <button className="secondary" disabled={busy} onClick={inspect}>Vérifier la demande</button>
 {review&&<div className="notice"><p>Commercial : <strong>{review.commercialName}</strong> · {review.commercialId}</p><p>Ancienne adresse : {review.previousOrigin}</p><p>Nouvelle adresse : {review.targetOrigin}</p><p>Lignée candidate : {review.lineageId}</p><p>Demande : {review.requestId}</p><label className="check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> J’ai comparé la demande avec le téléphone, vérifié la base et compris les risques du HTTP.</label><button disabled={!confirmed||busy||!!result} onClick={()=>void issue()}>Autoriser ce changement</button></div>}
 {error&&<p role="alert" className="error">{error}</p>}{result&&<div className="notice ok"><p>Code temporaire à communiquer au téléphone par un canal de confiance :</p><strong style={{overflowWrap:'anywhere'}}>{result.code}</strong><p>Expiration : {new Date(result.expiresAt).toLocaleString('fr-FR')}</p><button className="secondary" disabled={busy} onClick={()=>void revoke()}>Révoquer</button></div>}
 </section>;
}
