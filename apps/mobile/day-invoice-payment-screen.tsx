/** Écran de paiement v6 expérimental, non monté dans l'application active. */
import React,{useEffect,useRef,useState} from 'react';
import {StyleSheet,Text,TextInput,TouchableOpacity,View} from 'react-native';
import {makeDayPaymentAttempt} from './day-invoice-payment-input';
import {randomUUID} from 'expo-crypto';
import type {captureDayInvoiceForm} from './day-invoice-form';
import type {DayInvoicePayment} from '../../packages/domain/src/day-invoice';
import type {StoredPaymentAttempt} from './day-invoice-payment-attempt';
import {startPaymentAttempt,resumePaymentAttempt,finishPaymentAttempt,abandonPaymentAttempt,type PaymentAttemptIO} from './day-invoice-payment-attempt-flow';
type Form=Awaited<ReturnType<typeof captureDayInvoiceForm>>;
/** bindingKey change à chaque changement de commercial ou serveur lié. */
type Props={bindingKey:string;clientId:string;clientName:string;day:string;read:()=>Promise<Form>;attempts:PaymentAttemptIO;onBack:()=>void;onSaved:()=>void;onAbandoned?:()=>void};
const money=(value:number)=>`${(value/1000).toFixed(3)} DT`;
export function DayInvoicePaymentScreen({bindingKey,clientId,clientName,day,read,attempts,onBack,onSaved,onAbandoned}:Props){
 const [form,setForm]=useState<Form|null>(null),[amount,setAmount]=useState(''),[mode,setMode]=useState<DayInvoicePayment['mode']>('Espèces');
 const [number,setNumber]=useState(''),[bank,setBank]=useState(''),[due,setDue]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0),[loaded,setLoaded]=useState(false),[stored,setStored]=useState<StoredPaymentAttempt|null>(null);
 const working=useRef(false),generation=useRef(0),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
 useEffect(()=>{const current=++generation.current;setLoaded(false);setStored(null);setForm(null);setError('');setAmount('');setMode('Espèces');setNumber('');setBank('');setDue('');
  void (async()=>{const pending=await attempts.read();if(pending)return {pending,form:null};return {pending:null,form:await read()};})().then(value=>{if(mounted.current&&generation.current===current){if(value.form&&(value.form.view.clientId!==clientId||value.form.view.day!==day))throw Error('Client ou journée incohérent.');setStored(value.pending);setForm(value.form);setLoaded(true);}},e=>{if(mounted.current&&generation.current===current){setError(e instanceof Error?e.message:'Lecture impossible.');setLoaded(false);}}).catch(e=>{if(mounted.current&&generation.current===current){setError(e instanceof Error?e.message:'Lecture impossible.');setLoaded(false);}});
  return()=>{generation.current++;};
 },[bindingKey,clientId,day,reload]);
 const other=!!stored&&(stored.attempt.clientId!==clientId||stored.attempt.day!==day);
 const run=async(work:(current:()=>boolean)=>Promise<void>)=>{if(working.current)return;working.current=true;setBusy(true);setError('');const current=generation.current;
  try{await work(()=>mounted.current&&generation.current===current);}catch(e){if(mounted.current&&generation.current===current){setLoaded(false);setError(e instanceof Error?e.message:'Résultat inconnu : vérifiez la tentative.');}}finally{working.current=false;if(mounted.current)setBusy(false);}
 };
 const submit=()=>{if(working.current||!loaded||stored||!form)return;
  try{const input=makeDayPaymentAttempt(form,clientId,day,{amount,mode,chequeNumber:number,chequeBank:bank,chequeDue:due},randomUUID(),new Date().toISOString());
   void run(async current=>{const result=await startPaymentAttempt(attempts,input);if(current()){setStored(result);setForm(null);}});
  }catch(e){setError(e instanceof Error?e.message:'Montant invalide.');}
 };
 const resume=()=>{if(!stored||other||stored.result)return;void run(async current=>{const result=await resumePaymentAttempt(attempts,stored.attempt);if(current())setStored(result);});};
 const finish=()=>{if(!stored||other||!stored.result)return;void run(async current=>{await finishPaymentAttempt(attempts,stored.attempt);if(current()){setStored(null);onSaved();}});};
 const cancel=()=>{if(!stored||other||stored.result)return;void run(async current=>{await abandonPaymentAttempt(attempts,stored.attempt);if(current()){if(onAbandoned)onAbandoned();else setReload(n=>n+1);}});};
 return <View style={styles.container}>
  <View style={styles.header}><TouchableOpacity accessibilityRole="button" accessibilityLabel="Retour" onPress={onBack} disabled={busy||!loaded}><Text style={styles.back}>‹</Text></TouchableOpacity><View style={styles.grow}><Text style={styles.title}>Facture du jour</Text><Text style={styles.subtitle}>{clientName} · {day}</Text></View></View>
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  {!loaded&&<><Text style={styles.muted}>Vérification du règlement enregistré…</Text><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>setReload(n=>n+1)}><Text style={styles.link}>Vérifier à nouveau</Text></TouchableOpacity></>}
  {loaded&&stored&&<View style={styles.card}>{other?<Text style={styles.error}>Un règlement attend vérification pour un autre client ou une autre journée ({stored.attempt.clientId} · {stored.attempt.day}). Revenez à ce règlement avant d’en créer un nouveau.</Text>:<><Text style={styles.total}>{stored.result?'Règlement enregistré':'Règlement à confirmer'}</Text><Text style={styles.value}>{money(stored.attempt.amount)} · {stored.attempt.mode}</Text><Text style={styles.muted}>Le même identifiant sera conservé en cas de reprise.</Text><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={stored.result?finish:resume} style={[styles.button,busy&&styles.disabled]}><Text style={styles.buttonText}>{stored.result?'Terminer':'Reprendre le règlement'}</Text></TouchableOpacity>{!stored.result&&<TouchableOpacity accessibilityRole="button" disabled={busy} onPress={cancel}><Text style={styles.link}>Abandonner cette tentative non confirmée</Text></TouchableOpacity>}</>}</View>}
  {loaded&&!stored&&form&&<><View style={styles.card}><Text style={styles.label}>Facture préétablie</Text><Text style={styles.value}>{money(form.view.preInvoiceTotal)}</Text><Text style={styles.label}>Ventes sur place</Text><Text style={styles.value}>{money(form.view.salesTotal)}</Text><Text style={styles.label}>Total de la facture du jour</Text><Text style={styles.total}>{money(form.view.total)}</Text><Text style={styles.label}>Déjà payé</Text><Text style={styles.value}>{money(form.view.paid)}</Text><Text style={styles.label}>Reste à payer</Text><Text style={styles.total}>{money(form.view.remaining)}</Text></View>
   <Text style={styles.muted}>Un seul règlement pour la facture complète. Le paiement n’est pas réparti entre préétablie et ventes. L’ancienne dette est réglée séparément.</Text>
   <Text style={styles.label}>Montant du règlement</Text><TextInput accessibilityLabel="Montant du règlement de la facture du jour" editable={!busy&&mode!=='Crédit'} keyboardType="decimal-pad" value={mode==='Crédit'?'0,000':amount} onChangeText={setAmount} placeholder="0,000" style={styles.input}/>
   <View style={styles.row}>{(['Espèces','Chèque','Virement',...(form.source.preInvoice&&!form.view.declared&&form.view.paid===0?['Crédit' as const]:[])] as DayInvoicePayment['mode'][]).map(value=><TouchableOpacity accessibilityRole="button" accessibilityState={{selected:mode===value,disabled:busy}} key={value} disabled={busy} onPress={()=>setMode(value)} style={[styles.mode,mode===value&&styles.selected]}><Text style={styles.modeText}>{value}</Text></TouchableOpacity>)}</View>
   {mode==='Crédit'&&<Text style={styles.muted}>Facture entièrement impayée : aucun encaissement, le montant reste en dette.</Text>}
   {mode==='Chèque'&&<><TextInput accessibilityLabel="Numéro du chèque" editable={!busy} value={number} onChangeText={setNumber} placeholder="Numéro du chèque" maxLength={100} style={styles.input}/><TextInput accessibilityLabel="Banque du chèque" editable={!busy} value={bank} onChangeText={setBank} placeholder="Banque" maxLength={100} style={styles.input}/><TextInput accessibilityLabel="Échéance du chèque" editable={!busy} value={due} onChangeText={setDue} placeholder="Échéance" maxLength={100} style={styles.input}/></>}
   <TouchableOpacity accessibilityRole="button" accessibilityState={{disabled:busy||form.view.remaining<=0}} disabled={busy||form.view.remaining<=0} onPress={submit} style={[styles.button,(busy||form.view.remaining<=0)&&styles.disabled]}><Text style={styles.buttonText}>{busy?'Enregistrement…':'Enregistrer le règlement'}</Text></TouchableOpacity>
   <Text style={styles.muted}>L’opération est conservée sur ce téléphone. Synchronisez dès que le réseau et la session sont disponibles.</Text></>}
 </View>;
}
const styles=StyleSheet.create({container:{gap:12},header:{backgroundColor:'#0F1B3D',borderRadius:24,padding:16,flexDirection:'row',alignItems:'center',gap:12},grow:{flex:1},back:{fontSize:30,color:'#FFFFFF'},title:{fontSize:21,fontWeight:'800',color:'#FFFFFF'},subtitle:{color:'#A3AECB'},card:{backgroundColor:'#FFFFFF',borderRadius:20,padding:16,gap:5},label:{color:'#506178',fontWeight:'600',marginTop:4},value:{color:'#0F1B3D',fontWeight:'700',fontSize:16},total:{color:'#0F1B3D',fontWeight:'800',fontSize:21},muted:{color:'#66758C',lineHeight:19},error:{color:'#A02D34',fontWeight:'700'},link:{color:'#087D73',fontWeight:'700'},input:{backgroundColor:'#FFFFFF',borderColor:'#B6C4CD',borderWidth:1,borderRadius:12,padding:12,color:'#0F1B3D'},row:{flexDirection:'row',gap:6},mode:{flex:1,padding:10,borderRadius:10,backgroundColor:'#E9EEF2',alignItems:'center'},selected:{backgroundColor:'#2DD4BF'},modeText:{fontWeight:'700',color:'#0F1B3D'},button:{padding:15,borderRadius:14,backgroundColor:'#2DD4BF',alignItems:'center'},buttonText:{fontWeight:'800',color:'#0F1B3D'},disabled:{opacity:0.45}});
