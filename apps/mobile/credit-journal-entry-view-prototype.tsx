/** Saisie préétablie/paiement v5, isolée de l'application active. */
import React,{useRef,useState} from 'react';
import {ScrollView,StyleSheet,Switch,Text,TextInput,TouchableOpacity,View} from 'react-native';
import {summarizePreInvoice,parseDinars} from '@sls/domain';
import {savePreInvoice,saveTourReceipt,type TourPreInvoice,type TourJournalReceipt} from './storage';
import type {CreditWriteContext} from './credit-note-write-guard-prototype';
import type {CreditFormClient} from './credit-sale-settlement-prototype';
import {prepareCreditPreInvoice,prepareCreditJournalReceipt} from './credit-journal-entry-prototype';
type Props={kind:'preinvoice'|'receipt';client:CreditFormClient;context:CreditWriteContext;day:string;invoice?:TourPreInvoice;receipts:TourJournalReceipt[];onDone:()=>void;onCancel:()=>void};
export function CreditJournalEntryViewPrototype({kind,client,context,day,invoice,receipts,onDone,onCancel}:Props){
 const [amount,setAmount]=useState(''),[prePaid,setPrePaid]=useState(''),[oldPaid,setOldPaid]=useState(''),[creditFull,setCreditFull]=useState(false),[mode,setMode]=useState<'Espèces'|'Chèque'|'Virement'>('Espèces'),[number,setNumber]=useState(''),[bank,setBank]=useState(''),[due,setDue]=useState(''),[busy,setBusy]=useState(false),[complete,setComplete]=useState(false),[error,setError]=useState('');
 const lock=useRef(false),saved=useRef(false);
 const mayCredit=(()=>{try{return !!invoice&&!summarizePreInvoice(invoice.amount,receipts).declared&&(!prePaid.trim()||parseDinars(prePaid)===0);}catch{return false;}})();
 const submit=async()=>{if(lock.current||saved.current)return;lock.current=true;setBusy(true);setError('');try{
  const now=new Date().toISOString();
  if(kind==='preinvoice')await savePreInvoice(prepareCreditPreInvoice(client,context,day,amount,now),context);
  else {if(!invoice||invoice.journalDate!==day)throw Error('Facture introuvable.');const prepared=prepareCreditJournalReceipt(client,context,invoice,receipts,{prePaid,oldDebtPaid:oldPaid,creditFull,mode,chequeNumber:number,chequeBank:bank,chequeDue:due},now);await saveTourReceipt(prepared.value,prepared.availableOldDebt,context);}
  saved.current=true;setComplete(true);onDone();
 }catch(e){setError(saved.current?'Opération enregistrée. Revenez au journal pour actualiser.':e instanceof Error?e.message:'Enregistrement impossible.');}finally{lock.current=false;setBusy(false);}};
 return <ScrollView contentContainerStyle={styles.container}>
  <Text style={styles.title}>{kind==='preinvoice'?'Facture préétablie':'Paiement du journal'} · {client.name}</Text>
  <Text style={styles.notice}>La préétablie existe aussi dans le système principal. Le paiement de facture et le règlement d’ancienne dette sont conservés séparément.</Text>
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  {kind==='preinvoice'?<><Text>Montant TTC de la facture</Text><TextInput accessibilityLabel="Montant TTC préétabli" style={styles.input} keyboardType="decimal-pad" value={amount} onChangeText={setAmount} placeholder="Montant en DT"/></>:<>
   <Text>Paiement de cette facture</Text><TextInput accessibilityLabel="Paiement de la préétablie" style={styles.input} keyboardType="decimal-pad" value={prePaid} onChangeText={value=>{setPrePaid(value);if(value.trim()&&!/^0+(?:[.,]0{1,3})?$/.test(value.trim()))setCreditFull(false);}} placeholder="0,000"/>
   <Text>Règlement d’ancienne dette</Text><TextInput accessibilityLabel="Règlement de l’ancienne dette" style={styles.input} keyboardType="decimal-pad" value={oldPaid} onChangeText={setOldPaid} placeholder="0,000"/>
   {mayCredit&&<View style={styles.actions}><Switch accessibilityLabel="Crédit total si facture entièrement impayée" disabled={busy||complete} value={creditFull} onValueChange={setCreditFull}/><Text>Crédit total uniquement si la facture est entièrement impayée</Text></View>}
   <Text>Mode de paiement</Text><View style={styles.actions}>{(['Espèces','Chèque','Virement'] as const).map(value=><TouchableOpacity accessibilityRole="button" accessibilityState={{selected:mode===value}} disabled={busy||complete} key={value} onPress={()=>setMode(value)}><Text style={styles.link}>{mode===value?'✓ ':''}{value}</Text></TouchableOpacity>)}</View>
   {mode==='Chèque'&&<><TextInput accessibilityLabel="Numéro du chèque" style={styles.input} value={number} onChangeText={setNumber} placeholder="Numéro du chèque"/><TextInput accessibilityLabel="Banque" style={styles.input} value={bank} onChangeText={setBank} placeholder="Banque"/><TextInput accessibilityLabel="Échéance" style={styles.input} value={due} onChangeText={setDue} placeholder="Échéance"/></>}
  </>}
  <View style={styles.actions}><TouchableOpacity accessibilityRole="button" disabled={busy||complete} onPress={()=>void submit()} style={styles.button}><Text style={styles.buttonText}>{busy?'Enregistrement…':'Enregistrer'}</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onCancel}><Text style={styles.link}>Retour</Text></TouchableOpacity></View>
 </ScrollView>;
}
const styles=StyleSheet.create({container:{padding:16,gap:12},title:{fontSize:20,fontWeight:'700',color:'#173c32'},notice:{backgroundColor:'#fff4de',padding:10,borderRadius:8,color:'#89511e'},error:{backgroundColor:'#ffebe8',padding:10,borderRadius:8,color:'#842c23'},input:{backgroundColor:'#fff',borderWidth:1,borderColor:'#c5d7cc',padding:10,borderRadius:8},actions:{flexDirection:'row',flexWrap:'wrap',gap:16,alignItems:'center'},link:{color:'#176745',fontWeight:'700',paddingVertical:8},button:{backgroundColor:'#176745',padding:14,borderRadius:10},buttonText:{color:'#fff',fontWeight:'700'}});
