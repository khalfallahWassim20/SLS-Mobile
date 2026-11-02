import type { SavedSale, TourPreInvoice } from './storage';
/** Date civile de la tournée en Tunisie, indépendamment du fuseau du téléphone. */
export function tunisDay(date: Date): string {
 const parts = new Intl.DateTimeFormat('en-US', {timeZone:'Africa/Tunis', year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(date);
 const part = (type: string) => parts.find(p => p.type === type)?.value;
 const y=part('year'), m=part('month'), d=part('day');
 if (!y || !m || !d) throw new Error('Date de tournée indisponible');
 return `${y}-${m}-${d}`;
}
export type JournalRow = { clientId: string; clientName: string; sector: string; preInvoice: TourPreInvoice | null; sales: SavedSale[]; total: number };
/** Agrégation provisoire par client et date, sur cet appareil uniquement. */
export function buildJournal(day: string, preInvoices: TourPreInvoice[], sales: SavedSale[], sectors: Map<string,string>): JournalRow[] {
 const rows = new Map<string,JournalRow>();
 const row = (clientId: string, clientName: string, sector: string) => {
   let current=rows.get(clientId); if (!current) { current={clientId,clientName,sector,preInvoice:null,sales:[],total:0}; rows.set(clientId,current); } return current;
 };
 for (const p of preInvoices) {
   if (p.journalDate !== day) continue;
   if (!Number.isSafeInteger(p.amount) || p.amount <= 0) throw new Error('Montant préétabli invalide');
   const r=row(p.clientId,p.clientName,p.sector); if(r.preInvoice) throw new Error('Facture préétablie dupliquée');
   r.preInvoice=p; r.total += p.amount;
 }
 for (const s of sales) {
   if (!/^[0-9a-f-]{36}$/i.test(s.clientId) || tunisDay(new Date(s.createdAt)) !== day) continue;
   if (!Number.isSafeInteger(s.total) || s.total < 0) throw new Error('Vente invalide');
   const r=row(s.clientId,s.clientName,sectors.get(s.clientId) ?? ''); r.sales.push(s); r.total += s.total;
 }
 for (const r of rows.values()) if (!Number.isSafeInteger(r.total)) throw new Error('Total trop élevé');
 return [...rows.values()].sort((a,b)=>a.clientName.localeCompare(b.clientName));
}
export function journalTotal(rows: JournalRow[]): number {
 const total=rows.reduce((n,r)=>n+BigInt(r.total),0n);
 if(total>BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Total trop élevé');
 return Number(total);
}
