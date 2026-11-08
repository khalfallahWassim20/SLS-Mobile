/** Adaptateur SQLite de la file individuelle. Les lectures et accusés doivent
 * être effectués dans une transaction exclusive, avec l'identité liée. */
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import type {IdentifiedEntry} from './identified-upload';
type Bind=string|number|null;
type Tx={getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
type Row={operationId:string;entityId:string;payload:string;commercialId:string|null;kind:string|null;metadataEntity:string|null;recordedAt:string|null};
async function assertBound(tx:Tx,identity:DeviceIdentity):Promise<void> {
 const bound=await getDeviceIdentity(tx);
 if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur du téléphone incohérent.');
}
export async function readIdentifiedOutbox(tx:Tx,identity:DeviceIdentity):Promise<IdentifiedEntry[]> {
 await assertBound(tx,identity);
 const sales=await tx.getAllAsync<Row>(`SELECT o.operation_id AS operationId,o.sale_id AS entityId,o.payload,
  m.commercial_id AS commercialId,m.operation_kind AS kind,m.entity_id AS metadataEntity,m.recorded_at AS recordedAt
  FROM sales_outbox o LEFT JOIN identified_local_operations m ON m.operation_id=o.operation_id ORDER BY o.sequence`);
 const journals=await tx.getAllAsync<Row>(`SELECT o.operation_id AS operationId,o.invoice_id AS entityId,o.payload,
  m.commercial_id AS commercialId,m.operation_kind AS kind,m.entity_id AS metadataEntity,m.recorded_at AS recordedAt
  FROM journal_sync_outbox o LEFT JOIN identified_local_operations m ON m.operation_id=o.operation_id ORDER BY o.sequence`);
 return [...sales,...journals].map((r,index)=>{
  const validKind=index<sales.length ? r.kind==='sale'||r.kind==='settlement' : r.kind==='journal';
  if(!validKind || r.commercialId!==identity.commercialId || r.metadataEntity!==r.entityId || !r.recordedAt)throw Error('Opération en attente sans identité vérifiée : rapprochement nécessaire.');
  return {operationId:r.operationId,entityId:r.entityId,payload:r.payload,commercialId:r.commercialId,recordedAt:r.recordedAt,kind:r.kind as IdentifiedEntry['kind']};
 });
}
/** La métadonnée d'identité est conservée comme preuve de filiation après l'accusé. */
export async function acknowledgeIdentifiedOutbox(tx:Tx,identity:DeviceIdentity,entry:IdentifiedEntry):Promise<void> {
 await assertBound(tx,identity);
 if(entry.commercialId!==identity.commercialId)throw Error('Identité de file incohérente.');
 const table=entry.kind==='journal'?'journal_sync_outbox':entry.kind==='sale'||entry.kind==='settlement'?'sales_outbox':null;
 if(!table)throw Error('Type de file invalide.');
 const row=await tx.getFirstAsync<{payload:string;commercialId:string;kind:string;entityId:string}>(`SELECT o.payload,m.commercial_id AS commercialId,m.operation_kind AS kind,m.entity_id AS entityId
 FROM ${table} o JOIN identified_local_operations m ON m.operation_id=o.operation_id WHERE o.operation_id=?`,entry.operationId);
 if(!row || row.payload!==entry.payload || row.commercialId!==identity.commercialId || row.kind!==entry.kind || row.entityId!==entry.entityId)throw Error('File modifiée : accusé refusé.');
 await tx.runAsync(`DELETE FROM ${table} WHERE operation_id=?`,entry.operationId);
}
