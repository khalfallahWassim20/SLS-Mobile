/** Reprise du registre de modification v6, non activé dans App. */
import React,{useEffect,useRef,useState} from 'react';
import {StyleSheet,Text,TouchableOpacity,View} from 'react-native';
import type {StoredSaleEditAttempt} from './day-invoice-sale-edit-attempt';
import {resumeSaleEditAttempt,finishSaleEditAttempt,abandonSaleEditAttempt,type SaleEditAttemptIO} from './day-invoice-sale-edit-attempt-flow';
type Props={bindingKey:string;clientId:string;day:string;saleId:number;attempts:SaleEditAttemptIO;onDone:()=>void};
const money=(n:number)=>`${(n/1000).toFixed(3)} DT`;
export function DayInvoiceSaleEditRecoveryScreen({bindingKey,clientId,day,saleId,attempts,onDone}:Props){
 const [stored,setStored]=useState<StoredSaleEditAttempt|null>(null),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0);
 const epoch=useRef(0),working=useRef(false),mounted=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;};},[]);
 useEffect(()=>{const current=++epoch.current;setLoaded(false);setStored(null);setError('');
  void attempts.read().then(value=>{if(mounted.current&&epoch.current===current){setStored(value);setLoaded(true);}},e=>{if(mounted.current&&epoch.current===current)setError(e instanceof Error?e.message:'Lecture de la modification impossible.');});
  return()=>{epoch.current++;};
 },[bindingKey,clientId,day,saleId,reload]);
 const other=!!stored&&(stored.attempt.clientId!==clientId||stored.attempt.day!==day||stored.attempt.saleId!==saleId);
 const run=(action:(current:()=>boolean)=>Promise<void>)=>{if(working.current)return;working.current=true;setBusy(true);setError('');const current=epoch.current;
  void action(()=>mounted.current&&epoch.current===current).catch(e=>{if(mounted.current&&epoch.current===current){setLoaded(false);setError(e instanceof Error?e.message:'Résultat inconnu : vérifiez à nouveau.');}}).finally(()=>{working.current=false;if(mounted.current)setBusy(false);});
 };
 const resume=()=>{if(!stored||other||stored.result)return;const attempt=stored.attempt;run(async current=>{const result=await resumeSaleEditAttempt(attempts,attempt);if(current())setStored(result);});};
 const finish=()=>{if(!stored||other||!stored.result)return;const attempt=stored.attempt;run(async current=>{await finishSaleEditAttempt(attempts,attempt);if(current())onDone();});};
 const cancel=()=>{if(!stored||other||stored.result)return;const attempt=stored.attempt;run(async current=>{await abandonSaleEditAttempt(attempts,attempt);if(current())onDone();});};
 const button=(label:string,action:()=>void)=><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={action} style={[styles.button,busy&&styles.disabled]}><Text style={styles.buttonText}>{label}</Text></TouchableOpacity>;
 return <View style={styles.card}><Text style={styles.title}>Modification de vente à vérifier</Text><Text style={styles.muted}>Journée de facture : {day}. La même tentative est conservée après une interruption.</Text>
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  {!loaded&&button('Vérifier à nouveau',()=>setReload(n=>n+1))}
  {loaded&&!stored&&<><Text style={styles.muted}>Aucune tentative restante sur ce téléphone.</Text>{button('Retour aux clients',onDone)}</>}
  {loaded&&stored&&(other?<Text style={styles.error}>La tentative appartient à une autre vente, un autre client ou une autre journée. Rapprochement nécessaire.</Text>:<><Text style={styles.title}>{stored.result?'Modification enregistrée':'Modification à confirmer'}</Text>{stored.result&&<><Text style={styles.muted}>Vente modifiée : {money(stored.result.updated.total)}</Text><Text style={styles.muted}>Facture du jour : {money(stored.result.assessment.total)} · reste : {money(stored.result.assessment.remaining)}</Text></>}{stored.result?button('Terminer',finish):<>{button('Reprendre la confirmation',resume)}{button('Abandonner la tentative non confirmée',cancel)}</>}</>)}
 </View>;
}
const styles=StyleSheet.create({card:{backgroundColor:'#FFFFFF',borderRadius:18,padding:16,gap:10},title:{fontSize:17,fontWeight:'800',color:'#0F1B3D'},muted:{color:'#66758C',lineHeight:19},error:{color:'#A02D34',fontWeight:'700'},button:{padding:14,borderRadius:14,backgroundColor:'#2DD4BF',alignItems:'center'},buttonText:{fontWeight:'800',color:'#0F1B3D'},disabled:{opacity:0.45}});
