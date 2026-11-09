/** Liste préparatoire ; l'appelant doit recalculer l'aperçu et confirmer dans
 * une transaction. Les factures distantes ne sont pas copiées localement. */
import React from 'react';
import {StyleSheet,Text,TouchableOpacity,View} from 'react-native';
import type {readCreditSourceChoices} from './credit-note-source-choices-prototype';
type Choices=Awaited<ReturnType<typeof readCreditSourceChoices>>;
const money=(value:number)=>{const n=BigInt(value),v=n<0n?-n:n;return `${n<0n?'-':''}${v/1000n},${String(v%1000n).padStart(3,'0')} DT`;};
export function CreditSourceChoicesView({choices,busy,onSelect,onRefresh}:{choices:Choices;busy:boolean;onSelect:(item:Choices['items'][number])=>void;onRefresh:()=>void}){
 return <View style={styles.list}>
  <Text style={styles.title}>Choisir une facture à annuler</Text>
  <Text style={styles.notice}>L’avoir annule la facture entière. Actualisez quand le réseau est disponible ; hors ligne, d’autres appareils ont pu modifier ces données.</Text>
  {!choices.remoteAvailable&&<Text style={styles.notice}>Factures des autres appareils indisponibles sur ce téléphone : actualisez en ligne pour les consulter.</Text>}
  {!choices.active&&<Text style={styles.notice}>Client inactif : son historique reste consultable.</Text>}
  <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onRefresh} style={styles.refresh}><Text style={styles.refreshText}>Actualiser les factures</Text></TouchableOpacity>
  {choices.items.length===0&&<Text style={styles.notice}>Aucune facture éligible dans les données disponibles.</Text>}
  {choices.items.map(item=><View key={`${item.kind}:${item.invoiceId}`} style={styles.card}>
   <Text style={styles.name}>{item.kind==='sale'?'Vente SLS':'Facture préétablie'} · {item.invoiceDay} · {item.origin==='local'?'Ce téléphone':'Autre appareil'}</Text>
   <Text>Montant : {money(item.total)} · Payé : {money(item.paid)}</Text>
   {item.kind==='preinvoice'&&<Text>Ancienne dette réglée : {money(item.oldDebtPaid)} (conservée)</Text>}
   {item.blocked&&<Text style={styles.notice}>{item.blocked==='avoir-existant'?'Un avoir existe déjà sur ce téléphone.':'Modification locale à synchroniser ou à rapprocher avant de continuer.'}</Text>}
   <TouchableOpacity accessibilityRole="button" disabled={busy||!!item.blocked} onPress={()=>onSelect(item)} style={[styles.button,(busy||!!item.blocked)&&styles.disabled]}><Text style={styles.buttonText}>Préparer l’avoir</Text></TouchableOpacity>
  </View>)}
 </View>;
}
const styles=StyleSheet.create({list:{gap:10},title:{fontSize:20,fontWeight:'700',color:'#173c32'},notice:{color:'#89511e',backgroundColor:'#fff4de',padding:10,borderRadius:8},refresh:{padding:10,alignSelf:'flex-start'},refreshText:{color:'#176745',fontWeight:'700'},card:{backgroundColor:'#fff',padding:15,borderRadius:12,gap:8},name:{fontWeight:'700',color:'#173c32'},button:{backgroundColor:'#176745',padding:12,borderRadius:8,alignItems:'center'},buttonText:{color:'#fff',fontWeight:'700'},disabled:{opacity:0.5}});
