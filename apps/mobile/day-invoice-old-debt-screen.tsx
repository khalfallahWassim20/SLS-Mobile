/** Écran préparatoire non monté : l'ancienne dette reste distincte de la facture. */
import React,{useEffect,useRef,useState} from 'react';
import {StyleSheet,Text,TextInput,TouchableOpacity,View} from 'react-native';
import {randomUUID} from 'expo-crypto';
import type {captureOldDebtForm} from './day-invoice-old-debt-form';
import {prepareOldDebtInput,type OldDebtDraft} from './day-invoice-old-debt-input';
import type {OldDebtEvent} from './day-invoice-old-debt-queue';

type Form=Awaited<ReturnType<typeof captureOldDebtForm>>;
type Props={clientId:string;day:string;read:()=>Promise<Form>;confirm:(input:{fingerprint:string;event:OldDebtEvent})=>Promise<unknown>;onBack:()=>void;onSaved:()=>void};
const empty:OldDebtDraft={amount:'',mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
const money=(value:number)=>`${(value/1000).toFixed(3)} DT`;
export function DayInvoiceOldDebtScreen({clientId,day,read,confirm,onBack,onSaved}:Props){
 const [form,setForm]=useState<Form|null>(null),[draft,setDraft]=useState<OldDebtDraft>(empty),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0);
 const generation=useRef(0),submitting=useRef(false),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{const current=++generation.current;setForm(null);setDraft(empty);setError('');void read().then(value=>{if(generation.current===current){if(value.clientId!==clientId||value.day!==day){setError('Client ou journée incohérent.');return;}setForm(value);}},e=>{if(generation.current===current)setError(e instanceof Error?e.message:'Lecture impossible.');});return()=>{generation.current++;};},[clientId,day,reload]);
 const submit=async()=>{if(submitting.current||!form)return;let input:{fingerprint:string;event:OldDebtEvent};try{input=prepareOldDebtInput(form,draft,randomUUID(),new Date().toISOString());}catch(e){setError(e instanceof Error?e.message:'Règlement invalide.');return;}
  submitting.current=true;setBusy(true);setError('');const current=generation.current;
  try{await confirm(input);if(generation.current===current){setForm(null);onSaved();}}catch(e){if(generation.current===current)setError(e instanceof Error?e.message:'Enregistrement impossible.');}finally{submitting.current=false;if(mounted.current)setBusy(false);}
 };
 const field=(name:keyof OldDebtDraft,value:string)=>setDraft(current=>({...current,[name]:value}));
 return <View style={styles.container}>
  <View style={styles.header}><TouchableOpacity accessibilityRole="button" accessibilityLabel="Retour" disabled={busy} onPress={onBack}><Text style={styles.back}>‹</Text></TouchableOpacity><View><Text style={styles.title}>Règlement ancienne dette</Text><Text style={styles.subtitle}>{form?.clientName??''} · {day}</Text></View></View>
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  {!form&&!error&&<Text style={styles.muted}>Chargement du solde…</Text>}
  {!!error&&!busy&&<TouchableOpacity accessibilityRole="button" onPress={()=>setReload(n=>n+1)}><Text style={styles.link}>Actualiser le solde et recommencer</Text></TouchableOpacity>}
  {form&&<><View style={styles.card}><Text style={styles.label}>Solde global</Text><Text style={styles.value}>{money(form.balance)}</Text><Text style={styles.label}>Ancienne dette disponible</Text><Text style={styles.total}>{money(form.available)}</Text></View>
   <Text style={styles.muted}>Ce règlement est séparé du paiement de la facture du jour. Le solde est vérifié de nouveau à la confirmation.</Text>
   <Text style={styles.label}>Montant du règlement</Text><TextInput accessibilityLabel="Montant du règlement de l’ancienne dette" editable={!busy} keyboardType="decimal-pad" value={draft.amount} onChangeText={v=>field('amount',v)} placeholder="0,000" style={styles.input}/>
   <View style={styles.row}>{(['Espèces','Chèque','Virement'] as const).map(mode=><TouchableOpacity accessibilityRole="button" accessibilityState={{selected:draft.mode===mode,disabled:busy}} key={mode} disabled={busy} onPress={()=>field('mode',mode)} style={[styles.mode,draft.mode===mode&&styles.selected]}><Text style={styles.modeText}>{mode}</Text></TouchableOpacity>)}</View>
   {draft.mode==='Chèque'&&<><TextInput accessibilityLabel="Numéro du chèque" editable={!busy} value={draft.chequeNumber} onChangeText={v=>field('chequeNumber',v)} placeholder="Numéro du chèque" maxLength={100} style={styles.input}/><TextInput accessibilityLabel="Banque du chèque" editable={!busy} value={draft.chequeBank} onChangeText={v=>field('chequeBank',v)} placeholder="Banque" maxLength={100} style={styles.input}/><TextInput accessibilityLabel="Échéance du chèque" editable={!busy} value={draft.chequeDue} onChangeText={v=>field('chequeDue',v)} placeholder="Échéance" maxLength={100} style={styles.input}/></>}
   <TouchableOpacity accessibilityRole="button" accessibilityState={{disabled:busy||form.available<=0}} disabled={busy||form.available<=0} onPress={()=>{void submit();}} style={[styles.button,(busy||form.available<=0)&&styles.disabled]}><Text style={styles.buttonText}>{busy?'Enregistrement…':'Enregistrer le règlement'}</Text></TouchableOpacity>
   <Text style={styles.muted}>Conservé sur ce téléphone ; synchronisez dès que le réseau et la session sont disponibles.</Text></>}
 </View>;
}
const styles=StyleSheet.create({container:{gap:12},header:{backgroundColor:'#0F1B3D',borderRadius:24,padding:16,flexDirection:'row',alignItems:'center',gap:12},back:{fontSize:30,color:'#FFFFFF'},title:{fontSize:20,fontWeight:'800',color:'#FFFFFF'},subtitle:{color:'#A3AECB'},card:{backgroundColor:'#FFFFFF',borderRadius:20,padding:16,gap:5},label:{color:'#506178',fontWeight:'600',marginTop:4},value:{color:'#0F1B3D',fontWeight:'700',fontSize:16},total:{color:'#0F1B3D',fontWeight:'800',fontSize:21},muted:{color:'#66758C',lineHeight:19},error:{color:'#A02D34',fontWeight:'700'},link:{color:'#087D73',fontWeight:'700'},input:{backgroundColor:'#FFFFFF',borderColor:'#B6C4CD',borderWidth:1,borderRadius:12,padding:12,color:'#0F1B3D'},row:{flexDirection:'row',gap:6},mode:{flex:1,padding:10,borderRadius:10,backgroundColor:'#E9EEF2',alignItems:'center'},selected:{backgroundColor:'#2DD4BF'},modeText:{fontWeight:'700',color:'#0F1B3D'},button:{padding:15,borderRadius:14,backgroundColor:'#2DD4BF',alignItems:'center'},buttonText:{fontWeight:'800',color:'#0F1B3D'},disabled:{opacity:0.45}});
