/** Transport expérimental non raccordé à la synchronisation active. L'appelant
 * doit vérifier session et origine avant chaque requête et acquitter sous
 * transaction seulement si la file est encore identique. Le reçu ne prouve
 * pas un remboursement physique. */
import {canonicalJson} from '@sls/domain';
import {tunisDay} from './journal';
import {parseClosedDaySyncError,OperationConflictSyncError} from './identified-upload';

type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const money=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const instant=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;

/** Refuse toute divergence, même si la réponse d'envoi disait « duplicate ». */
export function verifyCompensationReceipt(expected:unknown,receipt:unknown,commercialId:string){
 if(!object(expected)||Object.keys(expected).sort().join(',')!=='compensation,event'||!object(expected.event)||!object(expected.event.sale)||!object(expected.compensation)||!object(receipt)||Object.keys(receipt).sort().join(',')!=='compensation,event,projection'||!object(receipt.projection)||!uuid(commercialId))throw Error('Reçu de compensation invalide : opération conservée.');
 const e=expected.event,c=expected.compensation,p=receipt.projection;
 if(!uuid(e.operationId)||!uuid(e.sale.clientId)||!instant(e.recordedAt)||!instant(e.sale.createdAt)||!['refund','credit'].includes(c.choice)||!money(c.amount)||c.amount===0||!money(c.paid)||!money(c.previousTotal)||c.amount>c.paid||c.paid>c.previousTotal||canonicalJson(receipt.event)!==canonicalJson(e)||canonicalJson(receipt.compensation)!==canonicalJson(c))throw Error('Reçu de compensation divergent : opération conservée.');
 const total=c.paid-c.amount;
 if(p.operationId!==e.operationId||p.clientId!==e.sale.clientId||p.commercialId!==commercialId||p.invoiceDay!==tunisDay(new Date(e.sale.createdAt))||p.eventDay!==tunisDay(new Date(e.recordedAt))||p.recordedAt!==e.recordedAt||p.choice!==c.choice||p.compensation!==c.amount||p.paidBeforeCompensation!==c.paid||p.total!==total||p.applied!==total||p.remaining!==0||p.refund!==(c.choice==='refund'?c.amount:0)||p.credit!==(c.choice==='credit'?c.amount:0)||!Number.isSafeInteger(p.balance))throw Error('Projection de compensation divergente : opération conservée.');
}

/** Aucun acquittement sur réponse perdue, preuve absente ou session changée. */
export async function uploadCompensatedSale(payload:string,identity:{commercialId:string;serverOrigin:string},verified:{commercialId:string;serverOrigin:string},io:{check:()=>void;send:(payload:string)=>Promise<Response>;receipt:(operationId:string)=>Promise<Response>;acknowledge:(payload:string)=>Promise<void>}){
 const check=()=>{io.check();if(identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur différent du téléphone lié.');};
 check();let expected:unknown;try{expected=JSON.parse(payload);}catch{throw Error('Compensation locale illisible : opération conservée.');}
 if(!object(expected)||!object(expected.event)||!uuid(expected.event.operationId))throw Error('Compensation locale invalide : opération conservée.');
 const operationId=expected.event.operationId;
 const response=await io.send(payload);check();const body=await response.json().catch(()=>null);check();
 if(!response.ok){const closed=parseClosedDaySyncError(response.status,body);if(closed)throw closed;const message=object(body)&&typeof body.error==='string'?body.error.slice(0,300):`Erreur serveur (${response.status}).`;if(response.status===409)throw new OperationConflictSyncError(message);throw Error(message);}
 if(!object(body)||!['received','duplicate'].includes(body.status)||body.operationId!==operationId)throw Error('Accusé invalide : opération conservée.');
 const proof=await io.receipt(operationId);check();if(!proof.ok)throw Error('Reçu serveur indisponible : opération conservée.');
 const receipt=await proof.json();check();verifyCompensationReceipt(expected,receipt,identity.commercialId);check();await io.acknowledge(payload);check();
}
