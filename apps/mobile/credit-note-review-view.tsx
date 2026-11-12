/** Écran de confirmation préparatoire, non monté dans App.tsx.
 * L'appelant doit recalculer et enregistrer atomiquement via
 * confirmCreditReviewPrototype, puis actualiser toutes les vues v5. */
import React from 'react';
import {StyleSheet,Text,TouchableOpacity,View} from 'react-native';
import type {CreditReview} from './credit-note-review-prototype';
import {describeCreditReview} from './credit-note-review-display';

const money=(value:number)=>{const n=BigInt(value),v=n<0n?-n:n;return `${n<0n?'-':''}${v/1000n},${String(v%1000n).padStart(3,'0')} DT`;};
function Line({label,value}:{label:string;value:string}){return <View style={styles.row}><Text style={styles.label}>{label}</Text><Text style={styles.value}>{value}</Text></View>;}
export function CreditNoteReviewView({review,busy,onConfirm,onCancel}:{review:CreditReview;busy:boolean;onConfirm:()=>void;onCancel:()=>void}){
 const data=describeCreditReview(review);
 return <View style={styles.card}>
  <Text style={styles.title}>Confirmer l’avoir intégral</Text>
  <Text style={styles.warning}>La facture entière sera annulée. La facture d’origine et son historique restent conservés.</Text>
  <Line label="Client" value={data.clientName}/><Line label="Facture du" value={data.invoiceDay}/>
  <Line label="Montant de la facture" value={money(data.invoiceTotal)}/><Line label="Paiement de cette facture" value={money(data.paid)}/>
  {data.kind==='preinvoice'&&<Line label="Ancienne dette réglée, conservée" value={money(data.oldDebtPaid)}/>}
  <Line label="Remboursement" value={money(data.refund)}/><Line label="Crédit conservé pour le client" value={money(data.retainedCredit)}/>
  <Line label="Solde avant" value={money(data.beforeBalance)}/><Line label="Solde après" value={money(data.afterBalance)}/>
  {data.kind==='preinvoice'&&<Text style={styles.warning}>Cette facture préétablie doit aussi être corrigée séparément dans le système principal.</Text>}
  <Text style={styles.note}>L’avoir est d’abord enregistré sur ce téléphone. Les autres appareils ne le verront qu’après synchronisation.</Text>
  <View style={styles.buttons}>
   <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onCancel} style={[styles.button,styles.secondary,busy&&styles.disabled]}><Text style={styles.secondaryText}>Retour</Text></TouchableOpacity>
   <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onConfirm} style={[styles.button,busy&&styles.disabled]}><Text style={styles.buttonText}>{busy?'Enregistrement…':'Confirmer l’avoir'}</Text></TouchableOpacity>
  </View>
 </View>;
}
const styles=StyleSheet.create({card:{backgroundColor:'#fff',padding:20,borderRadius:18,gap:10},title:{fontSize:20,fontWeight:'700',color:'#173c32'},warning:{color:'#89511e',backgroundColor:'#fff4de',padding:10,borderRadius:8},note:{color:'#576d65',fontSize:12},row:{flexDirection:'row',justifyContent:'space-between',gap:10},label:{color:'#526a60',flexShrink:1},value:{color:'#183d32',fontWeight:'600',textAlign:'right',flexShrink:1},buttons:{flexDirection:'row',gap:10,marginTop:10},button:{backgroundColor:'#176745',padding:13,borderRadius:10,flex:1,alignItems:'center'},secondary:{backgroundColor:'#e8f2ec'},buttonText:{color:'#fff',fontWeight:'700'},secondaryText:{color:'#176745',fontWeight:'700'},disabled:{opacity:0.5}});
