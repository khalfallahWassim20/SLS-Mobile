/** Vue v5 préparatoire non raccordée à App.tsx : les actions doivent toutes
 * utiliser CreditWriteContext et revérifier l'instantané dans SQLite. */
import React,{useMemo,useState} from 'react';
import {StyleSheet,Text,TextInput,TouchableOpacity,View} from 'react-native';
import type {readCreditClientsPrototype} from './credit-client-view-prototype';
type Snapshot=Awaited<ReturnType<typeof readCreditClientsPrototype>>;
type Client=Snapshot['clients'][number];
const money=(value:number)=>{const n=BigInt(value),a=n<0n?-n:n;return `${n<0n?'-':''}${a/1000n},${String(a%1000n).padStart(3,'0')} DT`;};
export function CreditClientsViewPrototype({snapshot,busy,onSell,onSettle,onCredit}:{snapshot:Snapshot;busy:boolean;onSell:(client:Client)=>void;onSettle:(client:Client)=>void;onCredit:(client:Client)=>void}){
 const [search,setSearch]=useState('');
 const rows=useMemo(()=>{const query=search.trim().toLocaleLowerCase();return snapshot.clients.filter(c=>`${c.name} ${c.sector}`.toLocaleLowerCase().includes(query)).sort((a,b)=>a.name.localeCompare(b.name));},[snapshot.clients,search]);
 return <View style={styles.container}>
  <Text style={styles.title}>Clients et soldes</Text><Text style={styles.notice}>Solde connu sur ce téléphone, incluant ses opérations et avoirs. Les actions des autres appareils ne sont visibles qu’après synchronisation ; un plafond ne peut pas être garanti hors ligne.</Text>
  <Text>En attente : {snapshot.pendingOperations} opération(s), {snapshot.pendingCredits} avoir(s).</Text>
  <TextInput accessibilityLabel="Rechercher un client" value={search} onChangeText={setSearch} placeholder="Rechercher un client ou secteur" style={styles.input}/>
  {rows.length===0&&<Text>Aucun client dans cette sélection.</Text>}
  {rows.map(c=><View key={c.id} style={styles.card}>
   <Text style={styles.name}>{c.name}{!c.active?' · inactif':''}</Text><Text>{c.sector||'Secteur non renseigné'}</Text>
   {c.balance===null?<Text style={styles.warning}>Solde en conflit : rapprocher les données avant toute nouvelle opération.</Text>:<><Text>{c.balance>0?'Dette':c.balance<0?'Crédit client':'Solde'} : {money(c.balance<0?-c.balance:c.balance)}</Text><Text>Limite : {c.limit===0?'Non définie':money(c.limit)}</Text></>}
   {c.blockReason==='limite'&&<Text style={styles.warning}>Limite atteinte : vente bloquée.</Text>}
   <View style={styles.actions}>
    <TouchableOpacity accessibilityRole="button" disabled={busy||c.saleBlocked} onPress={()=>onSell(c)} style={(busy||c.saleBlocked)&&styles.disabled}><Text style={styles.link}>Nouvelle vente</Text></TouchableOpacity>
    <TouchableOpacity accessibilityRole="button" disabled={busy||!c.canSettle} onPress={()=>onSettle(c)} style={(busy||!c.canSettle)&&styles.disabled}><Text style={styles.link}>Régler la dette</Text></TouchableOpacity>
    <TouchableOpacity accessibilityRole="button" disabled={busy||c.conflict} onPress={()=>onCredit(c)} style={(busy||c.conflict)&&styles.disabled}><Text style={styles.link}>Avoir</Text></TouchableOpacity>
   </View>
  </View>)}
 </View>;
}
const styles=StyleSheet.create({container:{gap:10},title:{fontSize:20,fontWeight:'700',color:'#173c32'},notice:{backgroundColor:'#fff4de',padding:10,borderRadius:8,color:'#89511e'},input:{backgroundColor:'#fff',borderWidth:1,borderColor:'#c5d7cc',padding:10,borderRadius:8},card:{backgroundColor:'#fff',borderRadius:12,padding:14,gap:5},name:{fontWeight:'700',fontSize:16,color:'#173c32'},warning:{color:'#89511e'},actions:{flexDirection:'row',flexWrap:'wrap',gap:15},link:{color:'#176745',fontWeight:'700',paddingVertical:8},disabled:{opacity:0.45}});
