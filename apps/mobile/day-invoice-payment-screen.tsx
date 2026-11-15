/** Composant de paiement v6 préparatoire, pas encore monté dans App.tsx. */
import React,{useEffect,useRef,useState} from 'react';
import {StyleSheet,Text,TextInput,TouchableOpacity,View} from 'react-native';
import {parseDinars} from '@sls/domain';
import type {captureDayInvoiceForm} from './day-invoice-form';
import type {DayInvoicePayment} from '../../packages/domain/src/day-invoice';

type Form=Awaited<ReturnType<typeof captureDayInvoiceForm>>;
type Input={clientId:string;day:string;fingerprint:string;recordedAt:string;amount:number;mode:DayInvoicePayment['mode'];chequeNumber:string;chequeBank:string;chequeDue:string};
type Props={clientId:string;clientName:string;day:string;read:()=>Promise<Form>;confirm:(input:Input)=>Promise<unknown>;onBack:()=>void;onSaved:()=>void};
const money=(value:number)=>`${(value/1000).toFixed(3)} DT`;
export function DayInvoicePaymentScreen({clientId,clientName,day,read,confirm,onBack,onSaved}:Props){
 const [form,setForm]=useState<Form|null>(null),[amount,setAmount]=useState(''),[mode,setMode]=useState<DayInvoicePayment['mode']>('Espèces');
 const [number,setNumber]=useState(''),[bank,setBank]=useState(''),[due,setDue]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0);
 const submitting=useRef(false),generation=useRef(0),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{const current=++generation.current;setForm(null);setError('');setAmount('');void read().then(value=>{if(generation.current===current)setForm(value);},e=>{if(generation.current===current)setError(e instanceof Error?e.message:'Lecture impossible.');});return()=>{generation.current++;};},[clientId,day,reload]);
 const submit=async()=>{
  if(submitting.current||!form)return;
  let value:number;try{value=parseDinars(amount);if(value<=0||value>form.view.remaining)throw Error('Le montant doit être supérieur à zéro et inférieur ou égal au reste de la facture.');if(mode==='Chèque'&&(!number.trim()||!bank.trim()||!due.trim()))throw Error('Renseignez le numéro, la banque et l’échéance du chèque.');}catch(e){setError(e instanceof Error?e.message:'Montant invalide.');return;}
  submitting.current=true;setBusy(true);setError('');const current=generation.current;
  try{await confirm({clientId,day,fingerprint:form.fingerprint,recordedAt:new Date().toISOString(),amount:value,mode,chequeNumber:mode==='Chèque'?number.trim():'',chequeBank:mode==='Chèque'?bank.trim():'',chequeDue:mode==='Chèque'?due.trim():''});if(generation.current===current){setForm(null);onSaved();}}
  catch(e){if(generation.current===current)setError(e instanceof Error?e.message:'Enregistrement impossible.');}
  finally{submitting.current=false;if(mounted.current)setBusy(false);}
 };
 return <View style={styles.container}>
  <View style={styles.header}><TouchableOpacity accessibilityRole="button" accessibilityLabel="Retour" onPress={onBack} disabled={busy}><Text style={styles.back}>‹</Text></TouchableOpacity><View style={styles.grow}><Text style={styles.title}>Facture du jour</Text><Text style={styles.subtitle}>{clientName} · {day}</Text></View></View>
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  {!!error&&!busy&&<TouchableOpacity accessibilityRole="button" onPress={()=>setReload(n=>n+1)}><Text style={styles.link}>Actualiser la facture et recommencer</Text></TouchableOpacity>}
  {!form&&!error&&<Text style={styles.muted}>Chargement de la facture…</Text>}
  {form&&<><View style={styles.card}><Text style={styles.label}>Facture préétablie</Text><Text style={styles.value}>{money(form.view.preInvoiceTotal)}</Text><Text style={styles.label}>Ventes sur place</Text><Text style={styles.value}>{money(form.view.salesTotal)}</Text><Text style={styles.label}>Total de la facture du jour</Text><Text style={styles.total}>{money(form.view.total)}</Text><Text style={styles.label}>Déjà payé</Text><Text style={styles.value}>{money(form.view.paid)}</Text><Text style={styles.label}>Reste à payer</Text><Text style={styles.total}>{money(form.view.remaining)}</Text></View>
   <Text style={styles.muted}>Un seul règlement pour la facture complète. Le paiement n’est pas réparti entre préétablie et ventes. L’ancienne dette est réglée séparément.</Text>
   <Text style={styles.label}>Montant du règlement</Text><TextInput accessibilityLabel="Montant du règlement de la facture du jour" editable={!busy} keyboardType="decimal-pad" value={amount} onChangeText={setAmount} placeholder="0,000" style={styles.input}/>
   <View style={styles.row}>{(['Espèces','Chèque','Virement'] as const).map(value=><TouchableOpacity accessibilityRole="button" accessibilityState={{selected:mode===value,disabled:busy}} key={value} disabled={busy} onPress={()=>setMode(value)} style={[styles.mode,mode===value&&styles.selected]}><Text style={styles.modeText}>{value}</Text></TouchableOpacity>)}</View>
   {mode==='Chèque'&&<><TextInput accessibilityLabel="Numéro du chèque" editable={!busy} value={number} onChangeText={setNumber} placeholder="Numéro du chèque" maxLength={100} style={styles.input}/><TextInput accessibilityLabel="Banque du chèque" editable={!busy} value={bank} onChangeText={setBank} placeholder="Banque" maxLength={100} style={styles.input}/><TextInput accessibilityLabel="Échéance du chèque" editable={!busy} value={due} onChangeText={setDue} placeholder="Échéance" maxLength={100} style={styles.input}/></>}
   <TouchableOpacity accessibilityRole="button" accessibilityState={{disabled:busy||form.view.remaining<=0}} disabled={busy||form.view.remaining<=0} onPress={()=>{void submit();}} style={[styles.button,(busy||form.view.remaining<=0)&&styles.disabled]}><Text style={styles.buttonText}>{busy?'Enregistrement…':'Enregistrer le règlement'}</Text></TouchableOpacity>
   <Text style={styles.muted}>L’opération est conservée sur ce téléphone. Synchronisez dès que le réseau et la session sont disponibles.</Text></>}
 </View>;
}
const styles=StyleSheet.create({container:{gap:12},header:{backgroundColor:'#0F1B3D',borderRadius:24,padding:16,flexDirection:'row',alignItems:'center',gap:12},grow:{flex:1},back:{fontSize:30,color:'#FFFFFF'},title:{fontSize:21,fontWeight:'800',color:'#FFFFFF'},subtitle:{color:'#A3AECB'},card:{backgroundColor:'#FFFFFF',borderRadius:20,padding:16,gap:5},label:{color:'#506178',fontWeight:'600',marginTop:4},value:{color:'#0F1B3D',fontWeight:'700',fontSize:16},total:{color:'#0F1B3D',fontWeight:'800',fontSize:21},muted:{color:'#66758C',lineHeight:19},error:{color:'#A02D34',fontWeight:'700'},link:{color:'#087D73',fontWeight:'700'},input:{backgroundColor:'#FFFFFF',borderColor:'#B6C4CD',borderWidth:1,borderRadius:12,padding:12,color:'#0F1B3D'},row:{flexDirection:'row',gap:6},mode:{flex:1,padding:10,borderRadius:10,backgroundColor:'#E9EEF2',alignItems:'center'},selected:{backgroundColor:'#2DD4BF'},modeText:{fontWeight:'700',color:'#0F1B3D'},button:{padding:15,borderRadius:14,backgroundColor:'#2DD4BF',alignItems:'center'},buttonText:{fontWeight:'800',color:'#0F1B3D'},disabled:{opacity:0.45}});
