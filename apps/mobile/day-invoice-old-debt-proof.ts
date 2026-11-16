/** Vérification des règlements d'ancienne dette conservés localement, y
 * compris après retrait de la file. À appeler sous le même verrou SQLite que
 * la lecture du solde ou de l'historique. */
import {canonicalJson} from '@sls/domain';
import {validateOldDebtEvent,type OldDebtEvent,type OldDebtEntry} from './day-invoice-old-debt-queue';
import type {DeviceIdentity} from './identified-device';
import type {validateDayInvoiceReference} from './day-invoice-reference';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>};
export async function assertLocalOldDebtProofs(tx:Tx,identity:DeviceIdentity,reference:ReturnType<typeof validateDayInvoiceReference>,queue:OldDebtEntry[]):Promise<void>{
 const rows=await tx.getAllAsync<{operationId:string;clientId:string;day:string;payload:string;commercialId:string;serverOrigin:string}>('SELECT operation_id AS operationId,client_id AS clientId,invoice_day AS day,payload,commercial_id AS commercialId,server_origin AS serverOrigin FROM day_invoice_old_debt_local LIMIT 20001');
 if(rows.length>20000)throw Error('Historique ancienne dette trop long.');
 if(!rows.length)return;
 const settlements=await tx.getAllAsync<{clientId:string;payload:string}>('SELECT client_id AS clientId,payload FROM settlements');
 const byId=new Map<string,{clientId:string;value:unknown}[]>();
 for(const row of settlements){let value:any;try{value=JSON.parse(row.payload);}catch{throw Error('Règlement local illisible.');}if(value&&typeof value.syncOperationId==='string'){const all=byId.get(value.syncOperationId)??[];all.push({clientId:row.clientId,value});byId.set(value.syncOperationId,all);}}
 const queued=new Map(queue.map(q=>[q.operationId,q]));
 const remote=new Map(reference.settlementStates!.map(s=>[s.operationId,s]));
 const markers=new Map(reference.oldDebtMarkers.map(m=>[m.operationId,m]));
 for(const row of rows){let event:OldDebtEvent;try{event=JSON.parse(row.payload);validateOldDebtEvent(event);}catch{throw Error('Historique ancienne dette illisible.');}
  const s=event.event.settlement,id=event.event.operationId,matches=byId.get(id)??[],server=remote.get(id),marker=markers.get(id);
  const origin=await tx.getFirstAsync<{commercialId:string;kind:string;entityId:string;recordedAt:string}>('SELECT commercial_id AS commercialId,operation_kind AS kind,entity_id AS entityId,recorded_at AS recordedAt FROM identified_local_operations WHERE operation_id=?',id);
  if(id!==row.operationId||s.clientId!==row.clientId||event.invoiceDay!==row.day||row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin||matches.length!==1||matches[0].clientId!==row.clientId||canonicalJson(matches[0].value)!==canonicalJson(s)||!origin||origin.commercialId!==identity.commercialId||origin.kind!=='settlement'||origin.entityId!==id||origin.recordedAt!==s.createdAt||!queued.has(id)&&!server||server&&(server.clientId!==row.clientId||!marker||marker.invoiceDay!==row.day))throw Error('Preuve ancienne dette indisponible : rapprochement nécessaire.');
 }
}
