/** Reprise isolée d'une compensation ; ne débloque jamais les vues anciennes. */
import React,{useEffect,useRef,useState} from 'react';
import {StyleSheet,Text,TouchableOpacity,View} from 'react-native';
import type {readLocalCompensationView} from './day-invoice-compensation-view';
import type {reconcileCompensatedInvoice} from './day-invoice-compensation-reconcile';
type ViewData=NonNullable<Awaited<ReturnType<typeof readLocalCompensationView>>>;
type Reconciled=Awaited<ReturnType<typeof reconcileCompensatedInvoice>>;
type Props={bindingKey:string;clientId:string;day:string;read:()=>Promise<ViewData|null>;synchronize?:()=>Promise<void>;reconcile?:()=>Promise<Reconciled>;onCheck:()=>void};
const money=(n:number)=>`${(n/1000).toFixed(3)} DT`;
export function DayInvoiceCompensationRecoveryScreen({bindingKey,clientId,day,read,synchronize,reconcile,onCheck}:Props){
 const [data,setData]=useState<ViewData|null>(null),[server,setServer]=useState<Reconciled|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0);
 const generation=useRef(0),working=useRef(false),mounted=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
 useEffect(()=>{const current=++generation.current;setData(null);setServer(null);setError('');void read().then(value=>{
  if(!value||value.clientId!==clientId||value.invoiceDay!==day)throw Error('Compensation différente ou indisponible : rapprochement nécessaire.');
  if(mounted.current&&generation.current===current)setData(value);
 }).catch(e=>{if(mounted.current&&generation.current===current)setError(e instanceof Error?e.message:'Lecture impossible.');});return()=>{generation.current++;};},[bindingKey,clientId,day,reload]);
 const sync=async()=>{if(!synchronize||working.current||!data||data.syncStatus!=='pending')return;working.current=true;setBusy(true);setError('');const current=generation.current;
  try{await synchronize();if(mounted.current&&generation.current===current)setReload(n=>n+1);}
  catch(e){if(mounted.current&&generation.current===current){setData(null);setError(e instanceof Error?e.message:'Synchronisation incertaine : vérifiez à nouveau.');}}
  finally{working.current=false;if(mounted.current)setBusy(false);}
 };
 const verify=async()=>{if(!reconcile||working.current||!data||data.syncStatus!=='proven')return;working.current=true;setBusy(true);setServer(null);setError('');const current=generation.current;
  try{const value=await reconcile();if(value.operationId!==data.operationId||value.clientId!==clientId||value.day!==day)throw Error('Facture serveur différente : rapprochement nécessaire.');if(mounted.current&&generation.current===current)setServer(value);}
  catch(e){if(mounted.current&&generation.current===current)setError(e instanceof Error?e.message:'Vérification serveur impossible.');}
  finally{working.current=false;if(mounted.current)setBusy(false);}
 };
 return <View style={styles.card}><Text style={styles.title}>Compensation à vérifier</Text><Text style={styles.muted}>Essai isolé : les anciens soldes, le journal et la clôture restent bloqués.</Text>
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  {data&&<><Text style={styles.label}>Facture du {data.invoiceDay} · opération du {data.eventDay}</Text><Text style={styles.label}>Préétablie</Text><Text style={styles.value}>{money(data.preInvoiceTotal)}</Text><Text style={styles.label}>Ventes sur place avant → après</Text><Text style={styles.value}>{money(data.salesTotalBefore)} → {money(data.salesTotalAfter)}</Text><Text style={styles.label}>Facture du jour avant → après</Text><Text style={styles.value}>{money(data.previousTotal)} → {money(data.total)}</Text><Text style={styles.label}>Déjà payé · retenu sur la facture</Text><Text style={styles.value}>{money(data.paid)} · {money(data.paidApplied)}</Text><Text style={styles.muted}>Le paiement reste global : aucun montant n’est attribué séparément à la préétablie ou aux ventes.</Text>{data.payments.map(p=><Text key={p.operationId} style={styles.muted}>{new Date(p.recordedAt).toLocaleString('fr-FR',{timeZone:'Africa/Tunis'})} · {p.mode} · {money(p.amount)}{p.mode==='Chèque'?` · ${p.chequeNumber} · ${p.chequeBank} · ${p.chequeDue}`:''}</Text>)}<Text style={styles.label}>{data.choice==='refund'?'Remboursement choisi':'Crédit client choisi'}</Text><Text style={styles.value}>{money(data.excess)}</Text><Text style={styles.label}>Solde estimé sur ce téléphone</Text><Text style={styles.value}>{money(data.localBalanceAfter)}</Text>
   {data.serverBalanceAtReceipt!==null&&<><Text style={styles.label}>Solde au moment du reçu serveur</Text><Text style={styles.value}>{money(data.serverBalanceAtReceipt)}</Text></>}
   {data.balanceNeedsReview&&<Text style={styles.error}>Les soldes diffèrent : rapprochement nécessaire. Aucun solde actuel n’est confirmé.</Text>}
   <Text style={styles.muted}>{data.syncStatus==='pending'?'En attente de synchronisation.':'Reçu serveur vérifié ; le solde peut avoir changé depuis.'}</Text><Text style={styles.muted}>L’enregistrement du choix ne prouve pas la remise physique d’un remboursement.</Text>
   {server&&<><Text style={styles.label}>Solde lors de la vérification serveur</Text><Text style={styles.value}>{money(server.balance)}</Text><Text style={styles.muted}>Facture et paiements rapprochés à la lecture ; le solde peut évoluer ensuite.</Text>{server.balanceNeedsReview&&<Text style={styles.error}>Le solde diffère de l’estimation locale : rapprochement nécessaire.</Text>}</>}
   {data.syncStatus==='proven'&&reconcile&&<TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>{void verify();}} style={styles.button}><Text style={styles.buttonText}>{busy?'Vérification…':'Vérifier la facture sur le serveur'}</Text></TouchableOpacity>}
   {data.syncStatus==='pending'&&synchronize&&<TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>{void sync();}} style={styles.button}><Text style={styles.buttonText}>{busy?'Synchronisation…':'Synchroniser le choix'}</Text></TouchableOpacity>}</>}
  <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>setReload(n=>n+1)}><Text style={styles.link}>Vérifier à nouveau</Text></TouchableOpacity>
  <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onCheck}><Text style={styles.link}>Recharger l’espace</Text></TouchableOpacity>
 </View>;
}
const styles=StyleSheet.create({card:{backgroundColor:'#FFFFFF',borderRadius:20,padding:16,gap:8},title:{fontSize:20,fontWeight:'800',color:'#0F1B3D'},label:{color:'#506178',fontWeight:'600'},value:{color:'#0F1B3D',fontWeight:'700',fontSize:16},muted:{color:'#66758C',lineHeight:19},error:{color:'#A02D34',fontWeight:'700'},button:{padding:15,borderRadius:14,backgroundColor:'#2DD4BF',alignItems:'center'},buttonText:{fontWeight:'800',color:'#0F1B3D'},link:{color:'#087D73',fontWeight:'700'}});
