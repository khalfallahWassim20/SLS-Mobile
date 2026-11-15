/** Calcul préparatoire d'une facture du jour. Tous les montants sont en millimes.
 * Ne lit ni n'écrit de données et n'est pas branché au protocole de synchronisation.
 * Les paiements globaux non attribués ne doivent PAS être passés comme dayPayments.
 */
export type DayInvoiceInput = {
  preInvoice: { id: string; total: number; paid: number; declared: boolean } | null;
  sales: readonly { id: string; total: number; paid: number }[];
  /** Paiements explicitement attribués à la facture du jour, jamais à l'ancienne dette. */
  dayPayments: readonly { id: string; amount: number }[];
};
function amount(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Montant invalide');
  return BigInt(value);
}
function number(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError('Montant trop élevé');
  return Number(value);
}
export function calculateDayInvoice(input: DayInvoiceInput) {
  const sales = new Set<string>(), payments = new Set<string>();
  let total = 0n, paid = 0n, unrecognized = 0n;
  if (input.preInvoice) {
    const p = input.preInvoice;
    if (!p.id.trim() || typeof p.declared !== 'boolean') throw new RangeError('Facture préétablie invalide');
    const bill = amount(p.total), payment = amount(p.paid);
    if (bill === 0n || payment > bill || (!p.declared && payment !== 0n)) throw new RangeError('Facture préétablie incohérente');
    total += bill; paid += payment;
    if (!p.declared) unrecognized = bill;
  }
  for (const sale of input.sales) {
    if (!sale.id.trim() || sales.has(sale.id)) throw new RangeError('Vente invalide ou dupliquée');
    sales.add(sale.id); total += amount(sale.total); paid += amount(sale.paid);
  }
  let allocated = 0n;
  for (const payment of input.dayPayments) {
    if (!payment.id.trim() || payments.has(payment.id)) throw new RangeError('Paiement invalide ou dupliqué');
    payments.add(payment.id);
    const value = amount(payment.amount);
    if (value === 0n) throw new RangeError('Paiement nul');
    allocated += value;
  }
  // Un remboursement/crédit existant peut rendre le reste négatif, mais un nouveau
  // règlement de journée ne peut pas dépasser le reste disponible.
  if (allocated > 0n && allocated > total - paid) throw new RangeError('Paiement supérieur au reste de la journée');
  return { total: number(total), alreadyPaid: number(paid), dayPayments: number(allocated),
    remaining: number(total - paid - allocated), unrecognizedPreInvoice: number(unrecognized) };
}

/** Un paiement du jour est un événement unique et immuable, distinct de l'ancienne dette.
 * Ce contrat n'est pas encore raccordé aux files mobile ni aux routes serveur. */
export type DayInvoicePayment = {
  operationId: string; clientId: string; day: string; recordedAt: string;
  amount: number; mode: 'Espèces' | 'Chèque' | 'Virement';
  chequeNumber: string; chequeBank: string; chequeDue: string;
  /** Preuves des versions connues lors de l'enregistrement : à vérifier côté serveur. */
  preInvoice: {id:string;version:number;total:number;declare:boolean} | null;
  sales: readonly {id:string;version:number}[];
};
export function validateDayPayment(p: DayInvoicePayment): void {
  const keys=['operationId','clientId','day','recordedAt','amount','mode','chequeNumber','chequeBank','chequeDue','preInvoice','sales'];
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length !== keys.length || keys.some(k => !Object.prototype.hasOwnProperty.call(p,k))) throw new RangeError('Contenu de paiement invalide');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof p.operationId !== 'string' || typeof p.clientId !== 'string' || !uuid.test(p.operationId) || !uuid.test(p.clientId)) throw new RangeError('Identifiant de paiement invalide');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.day)) throw new RangeError('Date de journée invalide');
  const day = new Date(`${p.day}T00:00:00.000Z`), recorded = new Date(p.recordedAt);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0,10) !== p.day || !Number.isFinite(recorded.getTime()) || recorded.toISOString() !== p.recordedAt) throw new RangeError('Date de paiement invalide');
  if (amount(p.amount) === 0n || !['Espèces', 'Chèque', 'Virement'].includes(p.mode)) throw new RangeError('Paiement invalide');
  for (const text of [p.chequeNumber,p.chequeBank,p.chequeDue]) if (typeof text !== 'string' || text.length > 100) throw new RangeError('Informations de paiement invalides');
  if (p.mode === 'Chèque' && (!p.chequeNumber.trim() || !p.chequeBank.trim() || !p.chequeDue.trim())) throw new RangeError('Informations du chèque incomplètes');
  if (p.mode !== 'Chèque' && (p.chequeNumber || p.chequeBank || p.chequeDue)) throw new RangeError('Informations de chèque inattendues');
  const version = (v:unknown) => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= 1000000;
  if (p.preInvoice !== null && (typeof p.preInvoice !== 'object' || !p.preInvoice || Object.keys(p.preInvoice).sort().join(',') !== 'declare,id,total,version' || typeof p.preInvoice.id !== 'string' || !uuid.test(p.preInvoice.id) || !version(p.preInvoice.version) || amount(p.preInvoice.total) === 0n || typeof p.preInvoice.declare !== 'boolean')) throw new RangeError('Preuve de facture invalide');
  if (!Array.isArray(p.sales) || p.sales.length > 1000) throw new RangeError('Preuves de vente invalides');
  let previous = '';
  for (const s of p.sales) {
    if (!s || typeof s !== 'object' || Object.keys(s).sort().join(',') !== 'id,version' || typeof s.id !== 'string' || !uuid.test(s.id) || !version(s.version) || s.id <= previous) throw new RangeError('Preuves de vente invalides ou dupliquées');
    previous = s.id;
  }
  if (p.preInvoice === null && !p.sales.length) throw new RangeError('Aucune source de facture');
}
const paymentFields: readonly (keyof DayInvoicePayment)[] = ['operationId','clientId','day','recordedAt','amount','mode','chequeNumber','chequeBank','chequeDue'];
function sameSources(a:DayInvoicePayment,b:DayInvoicePayment):boolean {
 return a.preInvoice?.id === b.preInvoice?.id && a.preInvoice?.version === b.preInvoice?.version && a.preInvoice?.total === b.preInvoice?.total && a.preInvoice?.declare === b.preInvoice?.declare && a.sales.length === b.sales.length && a.sales.every((sale,i)=>sale.id===b.sales[i].id && sale.version===b.sales[i].version);
}
function paymentMap(values: readonly DayInvoicePayment[]): Map<string,DayInvoicePayment> {
  const map = new Map<string,DayInvoicePayment>();
  for (const value of values) {
    validateDayPayment(value);
    if (map.has(value.operationId)) throw new RangeError('Paiement du jour dupliqué');
    map.set(value.operationId,value);
  }
  return map;
}
/** Le solde serveur contient déjà tous ses paiements. Ne soustraire que les
 * événements locaux absents de cet instantané ; refuser toute identité divergente. */
export function reconcileDayInvoicePayments(serverBalance: number, clientId: string, day: string, local: readonly DayInvoicePayment[], remote: readonly DayInvoicePayment[], serverPreInvoices: readonly {id:string;total:number;declared:boolean}[]) {
  if (!Number.isSafeInteger(serverBalance)) throw new RangeError('Solde serveur invalide');
  const localMap = paymentMap(local), remoteMap = paymentMap(remote);
  if ([...localMap.values(), ...remoteMap.values()].some(p => p.clientId !== clientId || p.day !== day)) throw new RangeError('Paiement rattaché à un autre client ou une autre journée');
  const preStates = new Map<string,{id:string;total:number;declared:boolean}>();
  for (const pre of serverPreInvoices) {
    if (!pre.id || preStates.has(pre.id) || typeof pre.declared !== 'boolean' || amount(pre.total) === 0n) throw new RangeError('Facture serveur invalide');
    preStates.set(pre.id,pre);
  }
  let pending = 0n, declaredPending = 0n;
  const declarations = new Map<string,string>();
  for (const event of [...remoteMap.values(),...localMap.values()]) {
    if (!event.preInvoice?.declare) continue;
    const prior = declarations.get(event.preInvoice.id);
    if (prior && prior !== event.operationId) throw new RangeError('Déclarations de facture divergentes');
    declarations.set(event.preInvoice.id,event.operationId);
  }
  for (const [id, event] of localMap) {
    const found = remoteMap.get(id);
    if (found && (paymentFields.some(field => found[field] !== event[field]) || !sameSources(found,event))) throw new RangeError('Paiement du jour divergent');
    if (!found) {
      pending += BigInt(event.amount);
      if (event.preInvoice?.declare) {
        const pre = preStates.get(event.preInvoice.id);
        if (!pre || pre.declared || pre.total !== event.preInvoice.total) throw new RangeError('Déclaration serveur divergente : rapprochement nécessaire');
        declaredPending += BigInt(event.preInvoice.total);
      }
    }
  }
  for (const event of remoteMap.values()) if (event.preInvoice?.declare) {
    const pre = preStates.get(event.preInvoice.id);
    if (!pre || !pre.declared || pre.total !== event.preInvoice.total) throw new RangeError('Instantané de déclaration serveur incohérent');
  }
  return { balance: number(BigInt(serverBalance) + declaredPending - pending), pendingAmount: number(pending), pendingDeclaration: number(declaredPending),
    remoteOnly: [...remoteMap.keys()].filter(id => !localMap.has(id)) };
}

/** Contrôle préparatoire sous verrou transactionnel. Le serveur doit lire
 * l'ensemble des sources et paiements de ce client/jour dans le même instantané,
 * puis garder les verrous jusqu'au commit. Un renvoi identique déjà enregistré
 * doit être reconnu AVANT cette vérification des versions. */
export function validateDayInvoiceWrite(payment: DayInvoicePayment, source: {
  clientId:string; day:string;
  preInvoice:{id:string;version:number;total:number;paid:number;declared:boolean}|null;
  sales:readonly {id:string;version:number;total:number;paid:number}[];
  dayPayments:readonly {id:string;amount:number}[];
}) {
 validateDayPayment(payment);
 if(payment.clientId!==source.clientId || payment.day!==source.day) throw new RangeError('Client ou journée incohérent');
 const pre=source.preInvoice, proof=payment.preInvoice;
 if((pre===null)!==(proof===null) || (pre && proof && (pre.id!==proof.id || pre.version!==proof.version || pre.total!==proof.total || proof.declare===pre.declared))) throw new RangeError('Facture préétablie modifiée : actualisation nécessaire');
 const sorted=[...source.sales].sort((a,b)=>a.id.localeCompare(b.id));
 if(sorted.length!==payment.sales.length || sorted.some((s,i)=>s.id!==payment.sales[i].id || s.version!==payment.sales[i].version)) throw new RangeError('Ventes modifiées : actualisation nécessaire');
 const result=calculateDayInvoice({preInvoice:pre,sales:sorted,dayPayments:[...source.dayPayments,{id:payment.operationId,amount:payment.amount}]});
 return {...result,declaresPreInvoice:!!proof?.declare};
}

/** Plafond du règlement d'ancienne dette : le reste de la facture courante
 * est exclu du solde global ; une préétablie non déclarée n'y figure pas. */
export function availablePriorDebt(balance:number,invoice:{remaining:number;unrecognizedPreInvoice:number}):number {
 if(!Number.isSafeInteger(balance)||!Number.isSafeInteger(invoice.remaining)||!Number.isSafeInteger(invoice.unrecognizedPreInvoice)||invoice.unrecognizedPreInvoice<0)throw new RangeError('Solde ou facture invalide');
 const current=BigInt(invoice.remaining)-BigInt(invoice.unrecognizedPreInvoice);
 const available=BigInt(balance)-(current>0n?current:0n);
 return number(available>0n?available:0n);
}

/** Prépare une modification d'une vente composant la facture du jour, sans
 * ventiler les anciens paiements. Un excédent impose un choix explicite ;
 * cette fonction n'effectue ni remboursement ni écriture de crédit. */
export function assessDayInvoiceSaleRevision(input:DayInvoiceInput,saleId:string,newSaleTotal:number){
 const current=calculateDayInvoice(input);
 const sale=input.sales.find(s=>s.id===saleId);
 if(!sale||input.sales.filter(s=>s.id===saleId).length!==1)throw new RangeError('Vente à modifier indisponible');
 const next=amount(newSaleTotal),difference=next-amount(sale.total);
 const total=BigInt(current.total)+difference;
 const paid=BigInt(current.alreadyPaid)+BigInt(current.dayPayments);
 if(total<0n)throw new RangeError('Total modifié invalide');
 const remaining=total>paid?total-paid:0n,excess=paid>total?paid-total:0n;
 return {previousTotal:current.total,total:number(total),paid:number(paid),balanceDelta:number(difference),remaining:number(remaining),excess:number(excess),requiresChoice:excess>0n};
}
