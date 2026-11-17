/** Reprise isolée d'une compensation ; ne débloque jamais les vues anciennes. */
import React,{useEffect,useRef,useState} from 'react';
import {StyleSheet,Text,TouchableOpacity,View} from 'react-native';
import type {readLocalCompensationView} from './day-invoice-compensation-view';
import type {reconcileCompensatedInvoice} from './day-invoice-compensation-reconcile';
import type {CompensatedJournal} from './day-invoice-compensation-journal';
type ViewData=NonNullable<Awaited<ReturnType<typeof readLocalCompensationView>>>;
type Reconciled=Awaited<ReturnType<typeof reconcileCompensatedInvoice>>;
type Props={bindingKey:string;clientId:string;day:string;read:()=>Promise<ViewData|null>;synchronize?:()=>Promise<void>;reconcile?:()=>Promise<Reconciled>;readJournal?:()=>Promise<CompensatedJournal>;onCheck:()=>void};
const money=(n:number)=>{const value=BigInt(n),abs=value<0n?-value:value;return `${value<0n?'-':''}${abs/1000n}.${String(abs%1000n).padStart(3,'0')} DT`;};
export function DayInvoiceCompensationRecoveryScreen({bindingKey,clientId,day,read,synchronize,reconcile,readJournal,onCheck}:Props){
 const [data,setData]=useState<ViewData|null>(null),[server,setServer]=useState<Reconciled|null>(null),[journal,setJournal]=useState<CompensatedJournal|null>(null),[limit,setLimit]=useState(30),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0);
 const generation=useRef(0),working=useRef(false),mounted=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
 useEffect(()=>{const current=++generation.current;setData(null);setServer(null);setJournal(null);setLimit(30);setError('');void read().then(value=>{
  if(!value||value.clientId!==clientId||value.invoiceDay!==day)throw Error('Compensation différente ou indisponible : rapprochement nécessaire.');
  if(mounted.current&&generation.current===current)setData(value);
 }).catch(e=>{if(mounted.current&&generation.current===current)setError(e instanceof Error?e.message:'Lecture impossible.');});return()=>{generation.current++;};},[bindingKey,clientId,day,reload]);
 const sync=async()=>{if(!synchronize||working.current||!data||data.syncStatus!=='pending')return;working.current=true;setBusy(true);setJournal(null);setError('');const current=generation.current;
  try{await synchronize();if(mounted.current&&generation.current===current)setReload(n=>n+1);}
  catch(e){if(mounted.current&&generation.current===current){setData(null);setError(e instanceof Error?e.message:'Synchronisation incertaine : vérifiez à nouveau.');}}
  finally{working.current=false;if(mounted.current)setBusy(false);}
 };
 const verify=async()=>{if(!reconcile||working.current||!data||data.syncStatus!=='proven')return;working.current=true;setBusy(true);setServer(null);setJournal(null);setError('');const current=generation.current;
  try{const value=await reconcile();if(value.operationId!==data.operationId||value.clientId!==clientId||value.day!==day)throw Error('Facture serveur différente : rapprochement nécessaire.');if(mounted.current&&generation.current===current)setServer(value);}
  catch(e){if(mounted.current&&generation.current===current)setError(e instanceof Error?e.message:'Vérification serveur impossible.');}
  finally{working.current=false;if(mounted.current)setBusy(false);}
 };
 const loadJournal=async()=>{if(!readJournal||working.current||!data||data.syncStatus!=='proven')return;working.current=true;setBusy(true);setJournal(null);setError('');const current=generation.current;
  try{const value=await readJournal();if(value.operationId!==data.operationId||value.clientId!==clientId||value.day!==data.eventDay)throw Error('Journal serveur différent : rapprochement nécessaire.');if(mounted.current&&generation.current===current){setJournal(value);setLimit(30);}}
  catch(e){if(mounted.current&&generation.current===current)setError(e instanceof Error?e.message:'Journal serveur indisponible.');}
  finally{working.current=false;if(mounted.current)setBusy(false);}
 };
 return <View style={styles.card}><Text style={styles.title}>Compensation à vérifier</Text><Text style={styles.muted}>Essai isolé : les anciens soldes, le journal et la clôture restent bloqués.</Text>
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  {data&&<><Text style={styles.label}>Facture du {data.invoiceDay} · opération du {data.eventDay}</Text><Text style={styles.label}>Préétablie</Text><Text style={styles.value}>{money(data.preInvoiceTotal)}</Text><Text style={styles.label}>Ventes sur place avant → après</Text><Text style={styles.value}>{money(data.salesTotalBefore)} → {money(data.salesTotalAfter)}</Text><Text style={styles.label}>Facture du jour avant → après</Text><Text style={styles.value}>{money(data.previousTotal)} → {money(data.total)}</Text><Text style={styles.label}>Déjà payé · retenu sur la facture</Text><Text style={styles.value}>{money(data.paid)} · {money(data.paidApplied)}</Text><Text style={styles.muted}>Le paiement reste global : aucun montant n’est attribué séparément à la préétablie ou aux ventes.</Text>{data.payments.map(p=><Text key={p.operationId} style={styles.muted}>{new Date(p.recordedAt).toLocaleString('fr-FR',{timeZone:'Africa/Tunis'})} · {p.mode} · {money(p.amount)}{p.mode==='Chèque'?` · ${p.chequeNumber} · ${p.chequeBank} · ${p.chequeDue}`:''}</Text>)}<Text style={styles.label}>{data.choice==='refund'?'Remboursement choisi':'Crédit client choisi'}</Text><Text style={styles.value}>{money(data.excess)}</Text><Text style={styles.label}>Solde estimé sur ce téléphone</Text><Text style={styles.value}>{money(data.localBalanceAfter)}</Text>
   {data.serverBalanceAtReceipt!==null&&<><Text style={styles.label}>Solde au moment du reçu serveur</Text><Text style={styles.value}>{money(data.serverBalanceAtReceipt)}</Text></>}
   {data.balanceNeedsReview&&<Text style={styles.error}>Les soldes diffèrent : rapprochement nécessaire. Aucun solde actuel n’est confirmé.</Text>}
   <Text style={styles.muted}>{data.syncStatus==='pending'?'En attente de synchronisation.':'Reçu serveur vérifié ; le solde peut avoir changé depuis.'}</Text><Text style={styles.muted}>L’enregistrement du choix ne prouve pas la remise physique d’un remboursement.</Text>
   {server&&<><Text style={styles.label}>Solde lors de la vérification serveur</Text><Text style={styles.value}>{money(server.balance)}</Text><Text style={styles.muted}>Facture et paiements rapprochés à la lecture ; le solde peut évoluer ensuite.</Text>{server.balanceNeedsReview&&<Text style={styles.error}>Le solde diffère de l’estimation locale : rapprochement nécessaire.</Text>}
    <Text style={styles.label}>Journal du commercial · {server.journal.day}</Text><Text style={styles.muted}>Total des encaissements enregistrés, tous modes confondus</Text><Text style={styles.value}>{money(server.journal.gross)}</Text>
    <Text style={styles.muted}>Total des remboursements choisis · total des crédits choisis</Text><Text style={styles.value}>{money(server.journal.refund)} · {money(server.journal.credit)}</Text>
    <Text style={styles.muted}>Total théorique après les remboursements choisis</Text><Text style={styles.value}>{money(server.journal.theoreticalNet)}</Text>
    <Text style={styles.muted}>Ce calcul n’est pas une caisse physique, ne prouve aucun versement et ne remplace pas la clôture.</Text></>}
   {data.syncStatus==='proven'&&reconcile&&<TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>{void verify();}} style={styles.button}><Text style={styles.buttonText}>{busy?'Vérification…':'Vérifier la facture sur le serveur'}</Text></TouchableOpacity>}
   {data.syncStatus==='pending'&&synchronize&&<TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>{void sync();}} style={styles.button}><Text style={styles.buttonText}>{busy?'Synchronisation…':'Synchroniser le choix'}</Text></TouchableOpacity>}
   {data.syncStatus==='proven'&&readJournal&&<TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>{void loadJournal();}} style={styles.button}><Text style={styles.buttonText}>{busy?'Lecture…':'Voir le journal serveur'}</Text></TouchableOpacity>}
   {journal&&<><Text style={styles.title}>Journal serveur · {journal.day}</Text><Text style={styles.muted}>Photographie de la dernière lecture, qui peut devenir périmée : les opérations encore hors ligne sont absentes. Les lignes dépendent de la version du serveur ; un règlement global n’est pas automatiquement classé comme ancienne dette. Les remboursements choisis ne prouvent pas la remise d’argent. Cette vue ne valide pas la clôture.</Text>
    <Text style={styles.label}>Facturé · encaissé enregistré</Text><Text style={styles.value}>{money(journal.totalBilled)} · {money(journal.totalCollected)}</Text><Text style={styles.label}>Remboursements choisis · crédits choisis</Text><Text style={styles.value}>{money(journal.refund)} · {money(journal.credit)}</Text><Text style={styles.label}>Encaissé théorique après remboursements</Text><Text style={styles.value}>{money(journal.theoreticalNet)}</Text>
    {journal.rows.slice(0,limit).map(row=><View key={row.clientId} style={styles.card}><Text style={styles.title}>{row.clientName}</Text><Text style={styles.muted}>{row.sector||'Secteur non renseigné'}</Text><Text style={styles.label}>Préétablie · ventes sur place · facture du jour</Text><Text style={styles.value}>{money(row.preInvoiceTotal)} · {money(row.salesTotal)} · {money(row.totalClient)}</Text><Text style={styles.label}>Paiement unique · ancienne dette</Text><Text style={styles.value}>{money(row.dayInvoicePaid)} · {money(row.oldDebtPaid)}</Text><Text style={styles.label}>Encaissé enregistré</Text><Text style={styles.value}>{money(row.totalCollected)}</Text><Text style={styles.label}>Remboursement choisi · crédit choisi</Text><Text style={styles.value}>{money(row.refund)} · {money(row.credit)}</Text><Text style={styles.label}>Encaissé théorique</Text><Text style={styles.value}>{money(row.theoreticalNet)}</Text></View>)}
    {journal.rows.length>limit&&<TouchableOpacity accessibilityRole="button" onPress={()=>setLimit(n=>n+30)}><Text style={styles.link}>Afficher plus de clients ({limit}/{journal.rows.length})</Text></TouchableOpacity>}</>}
   </>}
  <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>setReload(n=>n+1)}><Text style={styles.link}>Vérifier à nouveau</Text></TouchableOpacity>
  <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onCheck}><Text style={styles.link}>Recharger l’espace</Text></TouchableOpacity>
 </View>;
}
const styles=StyleSheet.create({card:{backgroundColor:'#FFFFFF',borderRadius:20,padding:16,gap:8},title:{fontSize:20,fontWeight:'800',color:'#0F1B3D'},label:{color:'#506178',fontWeight:'600'},value:{color:'#0F1B3D',fontWeight:'700',fontSize:16},muted:{color:'#66758C',lineHeight:19},error:{color:'#A02D34',fontWeight:'700'},button:{padding:15,borderRadius:14,backgroundColor:'#2DD4BF',alignItems:'center'},buttonText:{fontWeight:'800',color:'#0F1B3D'},link:{color:'#087D73',fontWeight:'700'}});
