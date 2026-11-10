/** Protocole individuel préparatoire ; le jeton est transmis par l'appelant, jamais conservé ici. */
type Kind='sale'|'settlement'|'journal';
export type IdentifiedEntry={operationId:string;kind:Kind;entityId:string;commercialId:string;recordedAt:string;payload:string};
type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
export class OperationConflictSyncError extends Error {
 constructor(message:string){super(message);}
}
export class ClosedDaySyncError extends Error {
 constructor(readonly day:string,readonly commercialId:string) {super('Journée clôturée : opération conservée en attente.');}
}
const obj=(x:unknown):Record<string,unknown>|null=>typeof x==='object'&&x!==null&&!Array.isArray(x)?x as Record<string,unknown>:null;
const uuid=(x:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
/** Vérifie toute la file avant le premier envoi et ne supprime qu'après un accusé exact. */
export async function uploadIdentifiedOperations(entries:IdentifiedEntry[],identity:{commercialId:string;serverOrigin:string},verified:{commercialId:string;serverOrigin:string},send:(path:string,payload:string)=>Promise<Response>,acknowledge:(operationId:string,kind:Kind)=>Promise<void>):Promise<number> {
 if(!uuid(identity.commercialId)||identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur différent du téléphone lié.');
 const seen=new Set<string>(),requests:{entry:IdentifiedEntry;path:string;body:string}[]=[];
 for(const entry of entries) {
  if(!uuid(entry.operationId)||!uuid(entry.entityId)||entry.commercialId!==identity.commercialId||seen.has(entry.operationId))throw Error('Une opération en attente ne possède pas une identité confirmée.');
  seen.add(entry.operationId);
  let raw:unknown;try{raw=JSON.parse(entry.payload);}catch{throw Error('Opération en attente illisible.');}
  const data=obj(raw);if(!data||data.operationId!==entry.operationId)throw Error('Identifiant de file incohérent.');
  let path:string;
  if(entry.kind==='sale') {
   const sale=obj(data.sale);
   if(data.saleId!==entry.entityId||sale?.syncSaleId!==entry.entityId||!Number.isSafeInteger(data.version)||sale?.syncVersion!==data.version)throw Error('Vente en attente incohérente.');
   const date=new Date(entry.recordedAt);
   if(!Number.isFinite(date.getTime())||date.toISOString()!==entry.recordedAt)throw Error('Date de modification inconnue : rapprochement nécessaire.');
   data.recordedAt=entry.recordedAt;path='sales';
  } else if(entry.kind==='settlement') {
   const settlement=obj(data.settlement);
   if(entry.operationId!==entry.entityId||settlement?.syncOperationId!==entry.operationId)throw Error('Règlement en attente incohérent.');
   path='settlements';
  } else if(entry.kind==='journal') {
   const invoice=obj(data.invoice);
   if(invoice?.id!==entry.entityId||!Number.isSafeInteger(data.version))throw Error('Journal en attente incohérent.');
   path='journal';
  } else throw Error('Type d’opération inconnu.');
  requests.push({entry,path,body:JSON.stringify(data)});
 }
 let count=0;
 for(const request of requests){
  const response=await send(request.path,request.body);const body=obj(await response.json().catch(()=>null));
  if(!response.ok){
   if(response.status===409 && body?.code==='TOUR_DAY_CLOSED' && typeof body.day==='string' && /^\d{4}-\d{2}-\d{2}$/.test(body.day) && typeof body.commercialId==='string' && uuid(body.commercialId)) {
    const date=new Date(`${body.day}T00:00:00.000Z`);
    if(Number.isFinite(date.getTime()) && date.toISOString().slice(0,10)===body.day)throw new ClosedDaySyncError(body.day,body.commercialId);
   }
   const message=typeof body?.error==='string'&&body.error?body.error.slice(0,300):`Erreur de synchronisation (${response.status}).`;
   if(response.status===409)throw new OperationConflictSyncError(message);
   throw Error(message);
  }
  if(!body||(body.status!=='received'&&body.status!=='duplicate')||body.operationId!==request.entry.operationId)throw Error('Accusé invalide : opération conservée.');
  await acknowledge(request.entry.operationId,request.entry.kind);count++;
 }
 return count;
}
