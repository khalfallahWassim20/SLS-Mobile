/** Comparaison informative des seuls flux de ventes. Ne prouve ni la caisse
 * physique ni la cohérence des autres encaissements et ne débloque pas de clôture. */
import {z} from 'zod';
import {tunisDay} from './journal';
import {readCreditJournalExportPrototype} from './credit-note-journal-export-prototype';
import {journalCsv} from './journal-export';
import type {DeviceIdentity} from './identified-device';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
const id=z.string().uuid(),at=z.string().datetime(),money=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fields={operationId:id,saleId:id,clientId:id,recordedAt:at};
const initial=z.object({...fields,paid:money}).strict(),refund=z.object({...fields,refund:money.refine(x=>x>0)}).strict();
const payload=z.object({version:z.literal(5),commercialId:id,day:z.string(),initialEvents:z.array(initial).max(200),refundEvents:z.array(refund).max(40000)}).strict();
type Event={operationId:string;saleId:string;clientId:string;recordedAt:string;amount:number;kind:'initial'|'refund'};
function normalize(value:unknown,identity:DeviceIdentity,day:string):Event[]{
 const date=new Date(`${day}T00:00:00.000Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day)throw Error('Date de comparaison invalide.');
 const result=payload.safeParse(value);if(!result.success||result.data.commercialId!==identity.commercialId||result.data.day!==day)throw Error('Comparaison de caisse : réponse invalide ou identité différente.');
 const d=result.data,items:Event[]=[...d.initialEvents.map(e=>({...e,amount:e.paid,kind:'initial' as const})),...d.refundEvents.map(e=>({...e,amount:e.refund,kind:'refund' as const}))];
 const seen=new Set<string>();for(const item of items){if(tunisDay(new Date(item.recordedAt))!==day||seen.has(item.operationId))throw Error('Comparaison de caisse : événements invalides ou doublés.');seen.add(item.operationId);}
 return items;
}
/** Compare les identifiants et montants, pas seulement les totaux : deux
 * omissions de même montant ne doivent jamais être déclarées concordantes. */
export function compareSaleCashEvents(local:unknown,server:unknown,identity:DeviceIdentity,day:string){
 const left=normalize(local,identity,day),right=normalize(server,identity,day),byId=new Map(right.map(e=>[e.operationId,e]));
 let onlyLocal=0,changed=0;for(const item of left){const other=byId.get(item.operationId);if(!other){onlyLocal++;continue;}byId.delete(item.operationId);if(item.kind!==other.kind||item.saleId!==other.saleId||item.clientId!==other.clientId||Date.parse(item.recordedAt)!==Date.parse(other.recordedAt)||item.amount!==other.amount)changed++;}
 return {matches:onlyLocal===0&&changed===0&&byId.size===0,onlyLocal,onlyServer:byId.size,changed};
}
/** À appeler sous transaction SQLite exclusive. Le journal effectue d'abord
 * ses validations habituelles ; aucune donnée locale n'est modifiée. */
export async function readLocalSaleCashComparison(tx:Tx,identity:DeviceIdentity,day:string,digest:(text:string)=>Promise<string>){
 const journal=await readCreditJournalExportPrototype(tx,identity,day,'Comparaison',digest);journalCsv(journal);
 const sales=await tx.getAllAsync<{id:number;payload:string}>('SELECT id,payload FROM sales');
 const byId=new Map(sales.map(s=>[s.id,JSON.parse(s.payload) as {syncSaleId:string;clientId:string;createdAt:string}]));
 async function operation(saleId:string,recordedAt:string){
  const rows=await tx.getAllAsync<{operationId:string}>(`SELECT operation_id AS operationId FROM identified_local_operations WHERE operation_kind='sale' AND entity_id=? AND commercial_id=? AND recorded_at=?`,saleId,identity.commercialId,recordedAt);
  if(rows.length!==1)throw Error('Origine de vente ambiguë : comparaison impossible.');return rows[0].operationId;
 }
 const initialEvents=[];for(const payment of journal.initialSalePayments??[]){const sale=byId.get(payment.saleId);if(!sale)throw Error('Vente locale indisponible.');initialEvents.push({operationId:await operation(sale.syncSaleId,sale.createdAt),saleId:sale.syncSaleId,clientId:sale.clientId,recordedAt:sale.createdAt,paid:payment.paid});}
 const refundEvents=[];for(const r of journal.saleRefunds??[]){const sale=byId.get(r.saleId);if(!sale||sale.clientId!==r.clientId)throw Error('Remboursement local incohérent.');refundEvents.push({operationId:await operation(sale.syncSaleId,r.recordedAt),saleId:sale.syncSaleId,clientId:r.clientId,recordedAt:r.recordedAt,refund:r.refund});}
 for(const r of journal.remoteSaleRefunds??[])refundEvents.push({operationId:r.operationId,saleId:r.invoiceId,clientId:r.clientId,recordedAt:r.recordedAt,refund:r.refund});
 const local={version:5 as const,commercialId:identity.commercialId,day,initialEvents,refundEvents};normalize(local,identity,day);return local;
}
