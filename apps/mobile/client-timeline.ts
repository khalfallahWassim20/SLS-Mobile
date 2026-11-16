/** Chronologie de présentation uniquement : ne modifie aucun calcul de solde. */
export function chronologicalOperations<T extends { date: string; key: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const left = Date.parse(a.date), right = Date.parse(b.date);
    // Une date illisible reste visible à la fin, jamais silencieusement supprimée.
    if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : a.key.localeCompare(b.key);
    if (!Number.isFinite(right)) return -1;
    return right - left || a.key.localeCompare(b.key);
  });
}

/** Journée de l'opération en Tunisie, indépendamment du fuseau du téléphone. */
export function operationDay(date:string):string | null {
 const time=Date.parse(date);if(!Number.isFinite(time))return null;
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(time));
 const get=(type:string)=>parts.find(part=>part.type===type)?.value;
 const year=get('year'),month=get('month'),day=get('day');
 return year&&month&&day?`${year}-${month}-${day}`:null;
}
export function operationDayLabel(date:string):string {
 if(operationDay(date)===null)return 'Date indisponible';
 return new Intl.DateTimeFormat('fr-FR',{timeZone:'Africa/Tunis',day:'2-digit',month:'long',year:'numeric'}).format(new Date(date));
}

/** Les modifications et règlements appartiennent à leur jour d'opération,
 * pas nécessairement au jour de création de la vente ou de la facture. */
export function operationsOnTunisDay<T extends {createdAt:string}>(items:readonly T[],day:string):T[]{
 return items.filter(item=>operationDay(item.createdAt)===day);
}

/** Excédent supplémentaire conservé lors d'une modification de vente locale.
 * Les anciens historiques n'enregistrent pas un choix séparé : on ne déduit un
 * crédit que si le paiement est inchangé, sans remboursement, et si l'excédent
 * augmente. Ce n'est pas nécessairement le solde global du client. */
export function revisionCreditAdded(revision:{previous:{total:number;paid:number};current:{total:number;paid:number};refund:number}):number|null {
 const {previous,current,refund}=revision;
 if(!previous||!current||![previous.total,previous.paid,current.total,current.paid,refund].every(n=>Number.isSafeInteger(n)&&n>=0)||refund!==0||previous.paid!==current.paid)return null;
 const before=Math.max(0,previous.paid-previous.total),after=Math.max(0,current.paid-current.total);
 return after>before?after-before:null;
}
