/** Consultation v5 expérimentale. Ne pas activer dans le serveur courant. */
import type {Pool} from 'pg';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {canonicalJson} from '@sls/domain';
import {assertIdentifiedMode,lockSyncMode} from './tour-sync-mode.js';
import {readPrototypeCreditReferenceInTransaction} from './credit-note-reference-prototype.js';
import {parseJournalSnapshot} from './journal-protocol.js';
import {saleSchema} from './identified-operations.js';
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
/** Le serveur transmet uniquement les dernières sources identifiées actives
 * reconnues par sa référence v5. Les données et les preuves proviennent d'un
 * même instantané. Les sources historiques non attribuées sont exclues. */
export async function readPrototypeCreditSources(pool:Pool,clientId:string) {
 z.string().uuid().parse(clientId);
 const db=await pool.connect();
 try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));
  const reference=await readPrototypeCreditReferenceInTransaction(db);
  const client=reference.clients.find(c=>c.id===clientId);
  if(!client){await db.query('COMMIT');return null;}
  const saleStates=new Map(reference.saleStates.filter(s=>s.clientId===clientId&&!s.cancelled).map(s=>[s.saleId,s]));
  const saleProofs=new Map(reference.eligibleSaleProofs.filter(p=>saleStates.has(p.saleId)).map(p=>[p.saleId,p]));
  const journalStates=new Map(reference.journalStates.filter(s=>s.clientId===clientId&&!s.creditNote&&reference.eligibleJournalIds.includes(s.id)).map(s=>[s.id,s]));
  const journalProofs=new Map(reference.journalProofs.filter(p=>journalStates.has(p.id)).map(p=>[p.id,p]));
  const sales=await db.query(`SELECT DISTINCT ON (sale_id) sale_id,version,payload->'sale' AS source FROM identified_sale_events WHERE client_id=$1 ORDER BY sale_id,version DESC`,[clientId]);
  const journals=await db.query(`SELECT DISTINCT ON (e.invoice_id) e.invoice_id,e.version,e.payload AS source FROM identified_journal_events e JOIN identified_journal_invoices i ON i.id=e.invoice_id WHERE i.client_id=$1 ORDER BY e.invoice_id,e.version DESC`,[clientId]);
  const items:{kind:'sale'|'preinvoice';invoiceId:string;version:number;source:unknown;hash:string}[]=[];
  for(const row of sales.rows){
   const p=saleProofs.get(row.sale_id);if(!p)continue;
   const source=saleSchema.parse(row.source);
   if(row.version!==p.version||source.clientId!==clientId||hash(source)!==p.hash)throw new RangeError('Source de vente incohérente.');
   items.push({kind:'sale',invoiceId:row.sale_id,version:row.version,source,hash:p.hash});saleProofs.delete(row.sale_id);
  }
  for(const row of journals.rows){
   const p=journalProofs.get(row.invoice_id);if(!p)continue;
   const source=parseJournalSnapshot(row.source);
   if(row.version!==p.version||source.invoice.clientId!==clientId||hash(source)!==p.hash)throw new RangeError('Source préétablie incohérente.');
   items.push({kind:'preinvoice',invoiceId:row.invoice_id,version:row.version,source,hash:p.hash});journalProofs.delete(row.invoice_id);
  }
  if(saleProofs.size||journalProofs.size)throw new RangeError('Sources de factures incomplètes.');
  // Une limite explicite protège les appareils et ne masque pas le fait qu'il
  // existe d'autres factures : le client doit demander une sélection plus fine.
  items.sort((a,b)=>a.invoiceId.localeCompare(b.invoiceId)||a.kind.localeCompare(b.kind));
  const truncated=items.length>200;
  await db.query('COMMIT');return {version:5 as const,clientId,active:client.active,truncated,items:items.slice(0,200)};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
