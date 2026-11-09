/** Parcours mobile préparatoire, volontairement non monté dans App.tsx.
 * Les calculs et les soldes actifs doivent d'abord être migrés ensemble en v5. */
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {ScrollView,StyleSheet,Text,TouchableOpacity,View} from 'react-native';
import type {FullCreditChoice} from '@sls/domain';
import type {DeviceIdentity} from './identified-device';
import type {CreditReview} from './credit-note-review-prototype';
import type {readCreditSourceChoices} from './credit-note-source-choices-prototype';
import {CreditSourceChoicesView} from './credit-note-source-choices-view';
import {CreditNoteReviewView} from './credit-note-review-view';

type Choices=Awaited<ReturnType<typeof readCreditSourceChoices>>;
type Item=Choices['items'][number];
type Props={identity:DeviceIdentity;clientId:string;
 readChoices:(identity:DeviceIdentity,clientId:string)=>Promise<Choices>;
 refreshSources:((clientId:string)=>Promise<void>)|null;
 preview:(identity:DeviceIdentity,clientId:string,kind:Item['kind'],id:string,version:number,choice:FullCreditChoice|null)=>Promise<CreditReview>;
 confirm:(identity:DeviceIdentity,review:CreditReview)=>Promise<unknown>;
 onDone:()=>void;onCancel:()=>void;};
/** Remonter le composant avec une clé liée à identity/clientId lorsque le
 * client change ; les callbacks transactionnels restent la source de vérité. */
export function CreditNoteWorkflowView(props:Props){
 const {identity,clientId,readChoices,refreshSources,preview,confirm,onDone,onCancel}=props;
 const [choices,setChoices]=useState<Choices|null>(null),[selected,setSelected]=useState<Item|null>(null),[review,setReview]=useState<CreditReview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const running=useRef(false),mounted=useRef(false),context=useRef(`${identity.serverOrigin}\n${identity.commercialId}\n${clientId}`);
 const current=`${identity.serverOrigin}\n${identity.commercialId}\n${clientId}`,liveContext=useRef(current);liveContext.current=current;
 const alive=()=>mounted.current&&context.current===current&&liveContext.current===current;
 const run=async(action:()=>Promise<void>)=>{if(running.current||!alive())return;running.current=true;setBusy(true);setError('');try{await action();}catch(e){if(alive())setError(e instanceof Error?e.message:'Opération impossible.');}finally{running.current=false;if(alive())setBusy(false);}};
 const load=useCallback(async()=>{const value=await readChoices(identity,clientId);if(alive())setChoices(value);},[identity.commercialId,identity.serverOrigin,clientId,readChoices]);
 useEffect(()=>{mounted.current=true;void run(load);return()=>{mounted.current=false;};},[]);
 const update=()=>void run(async()=>{if(!refreshSources)throw Error('Connectez-vous pour actualiser les factures des autres appareils.');await refreshSources(clientId);await load();});
 const prepare=(choice:FullCreditChoice|null)=>void run(async()=>{if(!selected||selected.blocked)throw Error('Facture non disponible.');const value=await preview(identity,clientId,selected.kind,selected.invoiceId,selected.version,choice);if(alive())setReview(value);});
 const save=()=>void run(async()=>{if(!review)throw Error('Aperçu indisponible.');await confirm(identity,review);if(alive())onDone();});
 if(context.current!==current)return <Text>Client ou téléphone modifié : rouvrez le parcours.</Text>;
 return <ScrollView contentContainerStyle={styles.container}>
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  {review?<CreditNoteReviewView review={review} busy={busy} onConfirm={save} onCancel={()=>{if(!busy)setReview(null);}}/>:
   selected?<View style={styles.card}>
    <Text style={styles.title}>{selected.kind==='sale'?'Vente SLS':'Facture préétablie'} du {selected.invoiceDay}</Text>
    {selected.paid>0?<><Text>Que faire du paiement de cette facture ?</Text>
     <TouchableOpacity disabled={busy} accessibilityRole="button" style={styles.button} onPress={()=>prepare('refund')}><Text style={styles.buttonText}>Rembourser le client</Text></TouchableOpacity>
     <TouchableOpacity disabled={busy} accessibilityRole="button" style={styles.button} onPress={()=>prepare('credit')}><Text style={styles.buttonText}>Conserver en crédit client</Text></TouchableOpacity></>:
     <><Text>Aucun paiement de cette facture à rembourser.</Text><TouchableOpacity disabled={busy} accessibilityRole="button" style={styles.button} onPress={()=>prepare(null)}><Text style={styles.buttonText}>Voir l’aperçu</Text></TouchableOpacity></>}
    {selected.kind==='preinvoice'&&<Text>Le règlement de l’ancienne dette reste conservé. La facture doit être corrigée séparément dans le système principal.</Text>}
    <TouchableOpacity disabled={busy} accessibilityRole="button" onPress={()=>setSelected(null)}><Text style={styles.link}>Retour aux factures</Text></TouchableOpacity>
   </View>:
   <>{choices?<CreditSourceChoicesView choices={choices} busy={busy} onSelect={item=>{if(!busy&&!item.blocked)setSelected(item);}} onRefresh={update}/>:<Text>{busy?'Chargement…':'Liste indisponible.'}</Text>}
    {!choices&&!busy&&<TouchableOpacity accessibilityRole="button" onPress={()=>void run(load)}><Text style={styles.link}>Réessayer la lecture locale</Text></TouchableOpacity>}
    <TouchableOpacity disabled={busy} accessibilityRole="button" onPress={onCancel}><Text style={styles.link}>Retour</Text></TouchableOpacity></>}
 </ScrollView>;
}
const styles=StyleSheet.create({container:{padding:16,gap:12},card:{backgroundColor:'#fff',padding:18,borderRadius:14,gap:12},title:{fontWeight:'700',fontSize:18,color:'#173c32'},button:{backgroundColor:'#176745',padding:14,borderRadius:10,alignItems:'center'},buttonText:{color:'#fff',fontWeight:'700'},link:{color:'#176745',fontWeight:'700',padding:10},error:{color:'#842c23',backgroundColor:'#ffebe8',padding:12,borderRadius:8}});
