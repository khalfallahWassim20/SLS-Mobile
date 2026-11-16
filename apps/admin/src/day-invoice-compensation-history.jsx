import React from 'react';
const formatMoney=value=>`${Math.floor(value/1000)},${String(value%1000).padStart(3,'0')}`;

/** Un choix enregistré n'atteste ni le mode ni le versement du remboursement. */
export function DayInvoiceCompensationHistory({compensation}){
 if(compensation===undefined)return null;
 if(!compensation||!['refund','credit'].includes(compensation.choice)||!Number.isSafeInteger(compensation.amount)||compensation.amount<=0)return <p className="error">Choix de compensation incohérent : rapprochement nécessaire.</p>;
 return <p className="notice">Facture du jour · choix enregistré : {compensation.choice==='refund'?'remboursement':'crédit client'} de {formatMoney(compensation.amount)} DT. Ce choix ne prouve pas un versement physique.</p>;
}
