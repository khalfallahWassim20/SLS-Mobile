/** Liste préparatoire ; l'appelant doit recalculer l'aperçu et confirmer dans
 * une transaction. Les factures distantes ne sont pas copiées localement. */
import React,{useMemo,useState} from 'react';
import {StyleSheet,Text,TextInput,TouchableOpacity,View} from 'react-native';
import type {readCreditSourceChoices} from './credit-note-source-choices-prototype';
import {indexSearch,searchIndexed,firstPage} from './paged-search';
type Choices=Awaited<ReturnType<typeof readCreditSourceChoices>>;
const money=(value:number)=>{const n=BigInt(value),v=n<0n?-n:n;return `${n<0n?'-':''}${v/1000n},${String(v%1000n).padStart(3,'0')} DT`;};
export function CreditSourceChoicesView({choices,busy,onSelect,onRefresh}:{choices:Choices;busy:boolean;onSelect:(item:Choices['items'][number])=>void;onRefresh:()=>void}){
 const [query,setQuery]=useState(''),[visible,setVisible]=useState(40);
 const index=useMemo(()=>indexSearch(choices.items,item=>`${item.invoiceId} ${item.invoiceDay} ${item.kind==='sale'?'vente SLS':'facture préétablie'} ${item.origin==='local'?'ce téléphone':'autre appareil'}`),[choices.items]);
 const matches=useMemo(()=>searchIndexed(index,query),[index,query]);
 const page=useMemo(()=>firstPage(matches,visible),[matches,visible]);
 return <View style={styles.list}>
  <Text style={styles.title}>Choisir une facture à annuler</Text>
  <Text style={styles.notice}>L’avoir annule la facture entière. Actualisez quand le réseau est disponible ; hors ligne, d’autres appareils ont pu modifier ces données.</Text>
  {!choices.remoteAvailable&&<Text style={styles.notice}>Factures des autres appareils indisponibles sur ce téléphone : actualisez en ligne pour les consulter.</Text>}
  {!choices.active&&<Text style={styles.notice}>Client inactif : son historique reste consultable.</Text>}
  <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onRefresh} style={styles.refresh}><Text style={styles.refreshText}>Actualiser les factures</Text></TouchableOpacity>
  <TextInput accessibilityLabel="Rechercher une facture" value={query} onChangeText={value=>{setQuery(value);setVisible(40);}} placeholder="Date, type ou identifiant" style={styles.input}/>
  <Text>{page.total} facture(s) · {page.items.length} affichée(s)</Text>
  {matches.length===0&&<Text style={styles.notice}>Aucune facture dans cette sélection.</Text>}
  {page.items.map(item=><View key={`${item.kind}:${item.invoiceId}`} style={styles.card}>
   <Text style={styles.name}>{item.kind==='sale'?'Vente SLS':'Facture préétablie'} · {item.invoiceDay} · {item.origin==='local'?'Ce téléphone':'Autre appareil'}</Text>
   <Text>Identifiant : {item.invoiceId}</Text>
   <Text>Montant : {money(item.total)} · Payé : {money(item.paid)}</Text>
   {item.kind==='preinvoice'&&<Text>Ancienne dette réglée : {money(item.oldDebtPaid)} (conservée)</Text>}
   {item.blocked&&<Text style={styles.notice}>{item.blocked==='avoir-existant'?'Un avoir existe déjà pour cette facture.':'Modification locale à synchroniser ou à rapprocher avant de continuer.'}</Text>}
   <TouchableOpacity accessibilityRole="button" disabled={busy||!!item.blocked} onPress={()=>onSelect(item)} style={[styles.button,(busy||!!item.blocked)&&styles.disabled]}><Text style={styles.buttonText}>Préparer l’avoir</Text></TouchableOpacity>
  </View>)}
  {page.hasMore&&<TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>setVisible(v=>v+40)} style={styles.refresh}><Text style={styles.refreshText}>Afficher plus de factures</Text></TouchableOpacity>}
 </View>;
}
const styles=StyleSheet.create({input:{backgroundColor:'#fff',borderWidth:1,borderColor:'#c5d7cc',padding:10,borderRadius:8},list:{gap:10},title:{fontSize:20,fontWeight:'700',color:'#173c32'},notice:{color:'#89511e',backgroundColor:'#fff4de',padding:10,borderRadius:8},refresh:{padding:10,alignSelf:'flex-start'},refreshText:{color:'#176745',fontWeight:'700'},card:{backgroundColor:'#fff',padding:15,borderRadius:12,gap:8},name:{fontWeight:'700',color:'#173c32'},button:{backgroundColor:'#176745',padding:12,borderRadius:8,alignItems:'center'},buttonText:{color:'#fff',fontWeight:'700'},disabled:{opacity:0.5}});
