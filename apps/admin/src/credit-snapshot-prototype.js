/** Adaptateur v5 préparatoire. Ne pas utiliser avec les anciennes routes qui
 * ignorent les avoirs ; le serveur courant ne fournit pas encore cet instantané. */
import {canonicalJson,prepareFullCreditNote} from '@sls/domain';
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const money=(x,signed=false)=>typeof x==='string'&&(signed?/^-?\d+$/:/^\d+$/).test(x)&&BigInt(x)<=BigInt(Number.MAX_SAFE_INTEGER)&&BigInt(x)>=BigInt(Number.MIN_SAFE_INTEGER);
export function adaptCreditAdminSnapshot(value){
 if(!value||value.version!==5||!Array.isArray(value.balances)||!Array.isArray(value.sales))throw Error('Instantané administratif invalide.');
 const clients=new Set();
 const balances=value.balances.map(c=>{
  if(!c||!uuid(c.id)||clients.has(c.id)||typeof c.name!=='string'||typeof c.active!=='boolean'||!money(c.openingBalance,true)||!money(c.creditLimit)||!money(c.balance,true))throw Error('Solde administratif invalide.');
  clients.add(c.id);return {...c,creditVersion:5};
 });
 const ids=new Set();
 const sales=value.sales.map(row=>{
  const s=row?.sale,n=row?.creditNote;
  if(!row||!uuid(row.saleId)||ids.has(row.saleId)||!Number.isSafeInteger(row.version)||row.version<1||!s||s.syncSaleId!==row.saleId||s.syncVersion!==row.version||!clients.has(s.clientId)||typeof s.clientName!=='string'||!Number.isSafeInteger(s.total)||s.total<0||!Number.isSafeInteger(s.paid)||s.paid<0||!Number.isSafeInteger(s.remaining)||s.remaining!==Math.max(0,s.total-s.paid)||typeof row.cancelled!=='boolean'||(row.cancelled?(!n||n.command?.invoiceId!==row.saleId||n.command.expectedVersion!==row.version||n.source?.total!==s.total||n.source?.netPaid!==s.paid):n!==null))throw Error('Vente administrative invalide.');
  if(row.cancelled){
   try {
    const expected=prepareFullCreditNote({actor:n.actor,command:n.command,source:n.source,daysOpen:true,previous:null}).event;
    if(canonicalJson(expected)!==canonicalJson(n))throw Error();
   } catch {throw Error('Avoir administratif incohérent.');}
  }
  ids.add(row.saleId);return {...row,creditVersion:5};
 });
 return {balances,sales};
}
