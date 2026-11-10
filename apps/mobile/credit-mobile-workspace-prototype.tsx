/** Composition expérimentale v5 : non montée dans App.tsx. Les écrans de vente,
 * de règlement et de journal doivent utiliser CreditWriteContext avant activation. */
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Alert,ScrollView,StyleSheet,Text,TouchableOpacity,View} from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import type {CommercialSession} from './commercial-login';
import type {DeviceIdentity} from './identified-device';
import type {CreditWriteContext} from './credit-note-write-guard-prototype';
import {CreditSaleSettlementViewPrototype} from './credit-sale-settlement-view-prototype';
import {CreditJournalEntryViewPrototype} from './credit-journal-entry-view-prototype';
import type {TourPreInvoice,TourJournalReceipt} from './storage';
import {CreditHistoryViewPrototype} from './credit-history-view-prototype';
import {CreditClientsViewPrototype} from './credit-clients-view-prototype';
import {CreditJournalViewPrototype} from './credit-note-journal-view-prototype';
import {CreditNoteWorkflowView} from './credit-note-workflow-view';
import {shareCreditJournalPrototype} from './credit-note-share-prototype';
import {getCreditMobileWorkspacePrototype,getCreditSourceChoicesPrototype,previewCreditReviewPrototype,confirmCreditReviewPrototype,createExperimentalCreditMobileTransport} from './storage';

type Snapshot=Awaited<ReturnType<typeof getCreditMobileWorkspacePrototype>>;
type Client=Snapshot['clients']['clients'][number];
type Props={identity:DeviceIdentity;day:string;commercialName:string;session:CommercialSession|null;onUnauthorized:()=>void;};
/** Les formulaires transmettent le contexte à SQLite, qui revérifie le solde
 * et l'identité dans la transaction avant d'enregistrer l'opération. */
export function CreditMobileWorkspacePrototype({identity,day,commercialName,session,onUnauthorized}:Props){
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[tab,setTab]=useState<'clients'|'journal'>('journal'),[creditClient,setCreditClient]=useState<{id:string;scope:string}|null>(null),[form,setForm]=useState<{kind:'sale'|'settlement'|'preinvoice'|'receipt';client:Client;context:CreditWriteContext;articles:Snapshot['clients']['articles'];scope:string;invoice?:TourPreInvoice;receipts?:TourJournalReceipt[]}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [historyClient,setHistoryClient]=useState<{id:string;scope:string}|null>(null);
 const mounted=useRef(false),running=useRef(false),generation=useRef(0);
 const context=`${identity.serverOrigin}\n${identity.commercialId}\n${day}\n${commercialName}`,live=useRef(context);live.current=context;
 const liveSession=useRef(session),liveIdentity=useRef(identity);liveSession.current=session;liveIdentity.current=identity;
 const transport=useMemo(()=>{
  if(!session)return null;
  const expected={token:session.token,id:session.id,serverOrigin:session.serverOrigin,expiresAt:session.expiresAt},bound={...identity};
  return createExperimentalCreditMobileTransport(session,identity,onUnauthorized,()=>{
   const current=liveSession.current,id=liveIdentity.current;
   return !!current&&current.token===expected.token&&current.id===expected.id&&current.serverOrigin===expected.serverOrigin&&current.expiresAt===expected.expiresAt&&id.commercialId===bound.commercialId&&id.serverOrigin===bound.serverOrigin;
  });
 },[session?.token,session?.serverOrigin,session?.id,session?.expiresAt,identity.commercialId,identity.serverOrigin,onUnauthorized]);
 const alive=(seq:number)=>mounted.current&&generation.current===seq&&live.current===context;
 const run=async(fn:(seq:number)=>Promise<void>)=>{if(running.current)return;running.current=true;const seq=++generation.current;setBusy(true);setError('');try{await fn(seq);}catch(e){if(alive(seq)){setSnapshot(null);setError(e instanceof Error?e.message:'Opération impossible.');}}finally{running.current=false;if(mounted.current)setBusy(false);}};
 const load=async(seq:number)=>{const value=await getCreditMobileWorkspacePrototype(identity,day,commercialName);if(alive(seq))setSnapshot(value);};
 useEffect(()=>{
  mounted.current=true;const seq=++generation.current;setSnapshot(null);setCreditClient(null);setForm(null);setHistoryClient(null);setError('');setBusy(true);
  void getCreditMobileWorkspacePrototype(identity,day,commercialName).then(value=>{if(alive(seq))setSnapshot(value);}).catch(e=>{if(alive(seq))setError(e instanceof Error?e.message:'Données v5 indisponibles.');}).finally(()=>{if(alive(seq)&&!running.current)setBusy(false);});
  return()=>{mounted.current=false;generation.current++;};
 },[identity.commercialId,identity.serverOrigin,day,commercialName]);
 const refresh=()=>void run(load);
 const synchronize=()=>void run(async seq=>{if(!transport)throw Error('Reconnectez-vous pour synchroniser.');await transport.synchronize();await load(seq);});
 const close=()=>{if(!transport||busy)return;Alert.alert('Clôturer la journée ?', 'Synchronisez toutes les opérations et tous les avoirs. Seul un administrateur pourra rouvrir cette journée.',[{text:'Annuler',style:'cancel'},{text:'Clôturer',onPress:()=>void run(async seq=>{await transport.closeDay(day);await load(seq);})}]);};
 const exportJournal=(format:'csv'|'pdf')=>void run(async seq=>{
  const current=await getCreditMobileWorkspacePrototype(identity,day,commercialName);if(!alive(seq))return;
  await shareCreditJournalPrototype(current.journal,format,{
   cacheDirectory:FileSystem.cacheDirectory,available:()=>Sharing.isAvailableAsync(),now:Date.now,
   print:async html=>{const result=await Print.printToFileAsync({html,base64:true});return {base64:result.base64};},
   write:(uri,data,encoding)=>FileSystem.writeAsStringAsync(uri,data,{encoding:encoding==='base64'?FileSystem.EncodingType.Base64:FileSystem.EncodingType.UTF8}),
   share:(uri,options)=>Sharing.shareAsync(uri,options)
  });if(alive(seq))setSnapshot(current);
 });
 const selectCredit=(id:string)=>{if(!busy)setCreditClient({id,scope:context});};
 const writeContext=(client:Client):CreditWriteContext=>{if(client.balance===null||client.conflict)throw Error('Solde en conflit.');return {identity:{...identity},expectedBalance:client.balance};};
 const currentSnapshot=snapshot&&snapshot.identity.commercialId===identity.commercialId&&snapshot.identity.serverOrigin===identity.serverOrigin&&snapshot.view.day===day&&snapshot.view.commercial===commercialName?snapshot:null;
 if(historyClient?.scope===context)return <CreditHistoryViewPrototype key={`${context}:${historyClient.id}`} identity={identity} clientId={historyClient.id} onBack={()=>{setHistoryClient(null);refresh();}} onChanged={()=>setSnapshot(null)}/>;
 if(form?.scope===context){
  const props={client:form.client,context:form.context,onCancel:()=>setForm(null),onDone:()=>{setForm(null);setSnapshot(null);refresh();}};
  return form.kind==='sale'||form.kind==='settlement'?<CreditSaleSettlementViewPrototype key={`${context}:${form.kind}:${form.client.id}`} kind={form.kind} articles={form.articles} {...props}/>:
   <CreditJournalEntryViewPrototype key={`${context}:${form.kind}:${form.client.id}`} kind={form.kind} day={day} invoice={form.invoice} receipts={form.receipts??[]} {...props}/>;
 }
 if(creditClient?.scope===context)return <CreditNoteWorkflowView key={`${identity.serverOrigin}:${identity.commercialId}:${creditClient.id}`} identity={identity} clientId={creditClient.id}
  readChoices={getCreditSourceChoicesPrototype} refreshSources={transport?(clientId)=>transport.refreshSources(clientId):null}
  preview={previewCreditReviewPrototype} confirm={confirmCreditReviewPrototype} onCancel={()=>setCreditClient(null)} onDone={()=>{setCreditClient(null);refresh();}}/>;
 return <ScrollView contentContainerStyle={styles.container}>
  <Text style={styles.title}>Tournée v5 · {commercialName}</Text><Text style={styles.notice}>Données de ce téléphone. Les opérations des autres appareils ne sont visibles qu’après synchronisation ; une préétablie doit aussi être corrigée dans le système principal.</Text>
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  <View style={styles.actions}><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={refresh}><Text style={styles.link}>Actualiser localement</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={busy||!transport} onPress={synchronize}><Text style={styles.link}>Synchroniser</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={busy||!transport} onPress={close}><Text style={styles.link}>Clôturer</Text></TouchableOpacity></View>
  <View style={styles.actions}><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>setTab('journal')}><Text style={styles.link}>Journal</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>setTab('clients')}><Text style={styles.link}>Clients et soldes</Text></TouchableOpacity></View>
  {!currentSnapshot?<Text>{busy?'Chargement…':'Données v5 indisponibles.'}</Text>:tab==='journal'?<CreditJournalViewPrototype model={currentSnapshot.view} busy={busy} onCredit={selectCredit} onExport={exportJournal} onPayment={(clientId,invoiceId)=>{
   const client=currentSnapshot.clients.clients.find(c=>c.id===clientId),invoice=currentSnapshot.journal.rows.find(r=>r.clientId===clientId)?.preInvoice;
   if(!client||client.balance===null||client.conflict||!invoice||invoice.id!==invoiceId){setError('Client ou facture indisponible : actualisez le journal.');return;}
   setForm({kind:'receipt',client,context:writeContext(client),articles:[],scope:context,invoice,receipts:currentSnapshot.journal.receipts.filter(r=>r.preInvoiceId===invoice.id)});
  }}/>:<CreditClientsViewPrototype snapshot={currentSnapshot.clients} busy={busy}
   onCredit={c=>selectCredit(c.id)} onHistory={c=>setHistoryClient({id:c.id,scope:context})} onPreInvoice={c=>setForm({kind:'preinvoice',client:c,context:writeContext(c),articles:[],scope:context})} onSell={c=>setForm({kind:'sale',client:c,context:writeContext(c),articles:currentSnapshot.clients.articles,scope:context})} onSettle={c=>setForm({kind:'settlement',client:c,context:writeContext(c),articles:[],scope:context})}/>}
 </ScrollView>;
}
const styles=StyleSheet.create({container:{padding:16,gap:12},title:{fontSize:20,fontWeight:'700',color:'#173c32'},notice:{backgroundColor:'#fff4de',padding:10,borderRadius:8,color:'#89511e'},error:{backgroundColor:'#ffebe8',padding:10,borderRadius:8,color:'#842c23'},actions:{flexDirection:'row',gap:16,flexWrap:'wrap'},link:{color:'#176745',fontWeight:'700',paddingVertical:8}});
