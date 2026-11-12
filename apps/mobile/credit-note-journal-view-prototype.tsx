/** Vue préparatoire uniquement : la capture et les actions v5 doivent être
 * raccordées en même temps que les soldes et le protocole du serveur. */
import React from 'react';
import {StyleSheet,Text,TouchableOpacity,View} from 'react-native';
import type {describeCreditJournalPrototype} from './credit-note-journal-view-model-prototype';
type Model=ReturnType<typeof describeCreditJournalPrototype>;
const money=(value:number)=>{const n=BigInt(value),v=n<0n?-n:n;return `${n<0n?'-':''}${v/1000n},${String(v%1000n).padStart(3,'0')} DT`;};
const mark=(m:{day:string;origin:'local'|'remote';pending:boolean}|null)=>m?`Annulée par avoir du ${m.day} · ${m.origin==='remote'?'enregistré ailleurs':m.pending?'en attente':'synchronisé'}`:'';
export function CreditJournalViewPrototype({model,onCredit,onPayment,onExport,busy}:{model:Model;onCredit:(clientId:string)=>void;onPayment:(clientId:string,invoiceId:string)=>void;onExport:(format:'pdf'|'csv')=>void;busy:boolean}){
 const t=model.totals;
 return <View style={styles.container}>
  <Text style={styles.title}>Journal du {model.day}</Text>
  <Text style={styles.notice}>Instantané de ce téléphone et des remboursements administrateur attribués reçus à la dernière synchronisation, pas un chiffre d’affaires consolidé. Les factures d’origine et les paiements restent dans l’historique.</Text>
  <View style={styles.card}>
   <Text style={styles.heading}>Totaux du téléphone</Text>
   <Text>Facturé brut : {money(t.billedGross)}</Text><Text>Facture préétablie payée : {money(t.prePaid)}</Text><Text>Ancienne dette réglée : {money(t.oldDebtPaid)}</Text><Text>Encaissé avant remboursements : {money(t.collectedGross)}</Text>
   <Text>Avoirs sur les factures de ce commercial : {money(t.creditNotes)}</Text><Text>Remboursements d’avoirs : {money(t.refunds)}</Text><Text>Crédit client conservé : {money(t.retainedCredit)}</Text>
   <Text>Facturé moins avoirs du commercial : {money(t.billedAfterLocalCredits)}</Text><Text>Encaissé après remboursements de ventes et avoirs : {money(t.collectedAfterLocalRefunds)}</Text>
  </View>
  {model.hasRemoteCancellations&&<Text style={styles.notice}>Des factures ont été annulées ailleurs. Les avoirs reçus sur les factures de ce commercial sont déduits le jour de leur création. Les remboursements administrateur attribués à ce commercial sont indiqués séparément : consultez aussi le journal serveur.</Text>}
  {!model.creditOwnersKnown&&<Text style={styles.warning}>Propriétaires des avoirs indisponibles : synchronisez.</Text>}
  {model.remoteOwnedCredits.length>0&&<View style={styles.card}><Text style={styles.heading}>Avoirs reçus sur vos factures, créés ailleurs</Text><Text style={styles.warning}>Ces avoirs reçus du serveur sont déduits du facturé à leur date de création. Le remboursement n’est pas automatiquement une sortie de votre caisse.</Text>{model.remoteOwnedCredits.map(e=><Text key={e.operationId}>{e.clientName} · {e.kind==='sale'?'vente':'préétablie'} · {money(e.invoiceTotal)} · {e.actorRole==='admin'?'administrateur':'autre appareil ou commercial'}</Text>)}<Text style={styles.notice}>Une préétablie doit aussi être corrigée séparément dans le système principal. L’enregistrement ne prouve pas un versement physique.</Text></View>}
  {model.rows.map(row=><View key={row.clientId} style={styles.card}>
   <Text style={styles.heading}>{row.clientName}</Text><Text>Facturé brut : {money(row.grossTotal)}</Text>
   {row.preInvoice&&<View><Text>Préétablie : {money(row.preInvoice.amount)}</Text>{row.preInvoice.cancellation&&<Text style={styles.warning}>{mark(row.preInvoice.cancellation)}</Text>}</View>}
   {row.sales.map(s=><View key={s.id}><Text>Vente supplémentaire : {money(s.total)}</Text>{s.remoteUpdateDay&&<Text style={styles.warning}>Modification du {s.remoteUpdateDay} enregistrée sur un autre appareil.</Text>}{s.cancellation&&<Text style={styles.warning}>{mark(s.cancellation)}</Text>}</View>)}
   {row.preInvoice&&!row.preInvoice.cancellation&&<TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>onPayment(row.clientId,row.preInvoice!.id)}><Text style={styles.link}>Paiement du journal</Text></TouchableOpacity>}
   <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>onCredit(row.clientId)}><Text style={styles.link}>Préparer un avoir</Text></TouchableOpacity>
  </View>)}
  {!model.adminRefundAssignmentsKnown&&<Text style={styles.warning}>Attributions administrateur indisponibles dans cette ancienne référence : synchronisez pour actualiser.</Text>}
  {model.adminCreditRefunds.length>0&&<View style={styles.card}><Text style={styles.heading}>Remboursements administrateur attribués à ce commercial</Text><Text style={styles.notice}>Reçus lors de la dernière synchronisation et déduits de la caisse. Vérifiez le versement physique ; une nouvelle attribution peut rester inconnue hors ligne.</Text>{model.adminCreditRefunds.map(r=><Text key={r.noteOperationId}>{r.clientName} · {r.kind==='sale'?'vente':'préétablie'} {r.invoiceId} · {money(r.refund)}</Text>)}<Text>Total : {money(model.adminCreditRefundTotal)}</Text></View>}
  {model.saleRefunds.length>0&&<View style={styles.card}><Text style={styles.heading}>Remboursements de modifications</Text><Text style={styles.notice}>Ces remboursements du jour sont déduits du paiement initial. Le versement physique reste à vérifier.</Text>{model.saleRefunds.map(r=><Text key={r.revisionId}>{r.clientName} · vente {r.saleId} · {r.recordedAt} · {money(r.refund)}</Text>)}<Text>Total : {money(model.saleRefundTotal)}</Text></View>}
  {model.remoteSaleRefunds.length>0&&<View style={styles.card}><Text style={styles.heading}>Remboursements sur ventes d’autres appareils</Text><Text style={styles.notice}>Ces sorties ont été enregistrées sur ce téléphone et sont déduites de son encaissé. Le versement physique reste à vérifier.</Text>{model.remoteSaleRefunds.map(r=><Text key={r.operationId}>{r.clientName} · vente {r.invoiceId} · {r.recordedAt} · {money(r.refund)}</Text>)}<Text>Total : {money(model.remoteSaleRefundTotal)}</Text></View>}
  {model.events.length>0&&<View style={styles.card}><Text style={styles.heading}>Avoirs créés ce jour</Text>{model.events.map(e=><View key={e.operationId}><Text>{e.clientName} · {e.kind==='sale'?'vente':'préétablie'} · {money(e.invoiceTotal)}{!e.owned?' · facture hors facturé de ce commercial ou propriété à confirmer':''}</Text><Text>Remboursé {money(e.refund)} · Crédit {money(e.retainedCredit)} · {e.pending?'en attente':'synchronisé'}</Text>{e.kind==='preinvoice'&&<Text style={styles.warning}>Correction séparée nécessaire dans le système principal.</Text>}</View>)}</View>}
  <View style={styles.actions}><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>onExport('csv')}><Text style={styles.link}>Partager CSV</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>onExport('pdf')}><Text style={styles.link}>Partager PDF</Text></TouchableOpacity></View>
 </View>;
}
const styles=StyleSheet.create({container:{gap:12},title:{fontSize:20,fontWeight:'700',color:'#173c32'},heading:{fontSize:16,fontWeight:'700',color:'#173c32'},card:{backgroundColor:'#fff',borderRadius:12,padding:16,gap:6},notice:{backgroundColor:'#fff4de',padding:10,borderRadius:8,color:'#89511e'},warning:{color:'#89511e'},link:{paddingVertical:8,color:'#176745',fontWeight:'700'},actions:{flexDirection:'row',gap:20}});
