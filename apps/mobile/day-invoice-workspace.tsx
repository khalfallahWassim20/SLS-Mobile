/** Composition préparatoire des écrans v6. Non montée dans App : la transition
 * de protocole, la session et la lignée doivent être validées avant activation. */
import * as Print from 'expo-print';
import {randomUUID} from 'expo-crypto';
import {operationDay} from './client-timeline';
import type {SavedSale} from './storage';
import {DayInvoiceSaleEditScreen} from './day-invoice-sale-edit-screen';
import {DayInvoiceCompensationRecoveryScreen} from './day-invoice-compensation-recovery-screen';
import {confirmCompensationTestPrototype,readCompensationViewPrototype} from './storage';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import {journalHtml,journalCsv} from './journal-export';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Alert,ScrollView,StyleSheet,Text,TextInput,TouchableOpacity,View} from 'react-native';
import type {DeviceIdentity} from './identified-device';
import {readDayInvoiceClientsPrototype,captureDayInvoiceWorkspacePrototype,readEditableDaySalePrototype,captureDayInvoiceSaleEditPrototype,readDayInvoiceFormPrototype,getDayInvoiceDetailPrototype,getDayInvoiceJournalExportPrototype,captureNewDayInvoiceSalePrototype,captureNewDayPreinvoicePrototype,captureOldDebtFormPrototype,daySaleAttemptIOPrototype,saleEditAttemptIOPrototype,dayPaymentAttemptIOPrototype,oldDebtAttemptIOPrototype,preinvoiceAttemptIOPrototype} from './storage';
import {DayInvoiceSaleEditRecoveryScreen} from './day-invoice-sale-edit-recovery-screen';
import {DayInvoiceSaleCreateScreen} from './day-invoice-sale-create-screen';
import {DayInvoicePreinvoiceScreen} from './day-invoice-preinvoice-screen';
import {DayInvoicePaymentScreen} from './day-invoice-payment-screen';
import {DayInvoiceOldDebtScreen} from './day-invoice-old-debt-screen';
import type {DayTimelineItem} from './day-invoice-timeline';
import {type PendingDayWork} from './day-invoice-workspace-state';
type Snapshot=Awaited<ReturnType<typeof readDayInvoiceClientsPrototype>>;
type Invoice=Awaited<ReturnType<typeof readDayInvoiceFormPrototype>>;
type Props={identity:DeviceIdentity;day:string;commercial:string;onSynchronize?:()=>Promise<void>;onClose?:()=>Promise<void>;compensationTestOnly?:'DONNEES_FICTIVES_ISOLEES';onSynchronizeCompensation?:()=>Promise<void>;onReconcileCompensation?:()=>ReturnType<typeof import('./day-invoice-compensation-reconcile').reconcileCompensatedInvoice>;onReadCompensatedJournal?:()=>ReturnType<typeof import('./day-invoice-compensation-journal').readVerifiedCompensatedJournal>};
type Client={id:string;name:string};
type Screen='clients'|'detail'|'saleEditDraft'|PendingDayWork['kind'];
const money=(value:number)=>`${(value/1000).toFixed(3)} DT`;
export function DayInvoiceWorkspace({identity,day,commercial,onSynchronize,onClose,compensationTestOnly,onSynchronizeCompensation,onReconcileCompensation,onReadCompensatedJournal}:Props){
 const [editing,setEditing]=useState<SavedSale|null>(null);
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[invoice,setInvoice]=useState<Invoice|null>(null),[timeline,setTimeline]=useState<DayTimelineItem[]>([]),[selected,setSelected]=useState<Client|null>(null),[work,setWork]=useState<PendingDayWork|null>(null),[screen,setScreen]=useState<Screen>('clients'),[query,setQuery]=useState(''),[limit,setLimit]=useState(40),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const mounted=useRef(false),running=useRef(0),generation=useRef(0),key=`${identity.commercialId}\n${identity.serverOrigin}`;
 const io=useMemo(()=>({sale:daySaleAttemptIOPrototype(identity),saleEdit:saleEditAttemptIOPrototype(identity),preinvoice:preinvoiceAttemptIOPrototype(identity),payment:dayPaymentAttemptIOPrototype(identity),oldDebt:oldDebtAttemptIOPrototype(identity)}),[identity.commercialId,identity.serverOrigin]);
 const refresh=async(isCurrent:()=>boolean)=>{
  // Une lecture échouée garde les boutons bloqués : ne jamais supposer que le
  // registre est vide après une erreur SQLite ou un changement de liaison.
  const state=await captureDayInvoiceWorkspacePrototype(identity);if(!isCurrent())return;
  if(state.pending){const pending=state.pending;setWork(pending);setSelected({id:pending.clientId,name:'Client à vérifier'});setSnapshot(null);setInvoice(null);setTimeline([]);setScreen(pending.kind);return;}
  setWork(null);setSnapshot(state.clients);setSelected(null);setInvoice(null);setTimeline([]);setScreen('clients');
 };
 const run=async(action:(current:()=>boolean)=>Promise<void>,force=false)=>{if(running.current&&!force)return;running.current++;setBusy(true);setError('');const g=++generation.current;const current=()=>mounted.current&&generation.current===g;try{await action(current);}catch(e){if(current()){setSnapshot(null);setInvoice(null);setTimeline([]);setEditing(null);setSelected(null);setWork(null);setScreen('clients');setError(e instanceof Error?e.message:'Lecture impossible.');}}finally{running.current--;if(mounted.current&&!running.current)setBusy(false);}};
 useEffect(()=>{mounted.current=true;setSnapshot(null);setInvoice(null);setSelected(null);setWork(null);setScreen('clients');setQuery('');setLimit(40);void run(refresh,true);return()=>{mounted.current=false;generation.current++;};},[key,day]);
 const choose=(client:Client)=>void run(async current=>{const value=await getDayInvoiceDetailPrototype(identity,client.id,day);if(current()){setSelected(client);setInvoice(value.invoice);setTimeline(value.timeline);setScreen('detail');}});
 const retry=()=>void run(refresh);
 const editSale=(saleId:number)=>{if(!selected)return;const client=selected;void run(async current=>{const value=await readEditableDaySalePrototype(identity,client.id,day,saleId);if(current()){setEditing(value);setScreen('saleEditDraft');}});};
 const sync=()=>void run(async current=>{if(!onSynchronize)throw Error('Synchronisation non configurée.');await onSynchronize();if(current())await refresh(current);});
 const closeDay=()=>{if(!onClose||busy)return;Alert.alert('Clôturer la journée',`Clôturer la journée du ${day} ? La réouverture nécessitera un administrateur.`,[{text:'Annuler',style:'cancel'},{text:'Clôturer',style:'destructive',onPress:()=>void run(async current=>{await onClose();if(current()){await refresh(current);if(current())Alert.alert('Journée clôturée','La clôture a été confirmée par le serveur.');}})}]);};
 const exportJournal=(format:'pdf'|'csv')=>void run(async current=>{
  if(!await Sharing.isAvailableAsync())throw Error('Partage de fichiers indisponible sur ce téléphone.');
  const data=await getDayInvoiceJournalExportPrototype(identity,day,commercial);if(!current())return;
  if(!FileSystem.cacheDirectory)throw Error('Stockage temporaire indisponible.');
  const uri=`${FileSystem.cacheDirectory}journal-v6-local-${day}-${Date.now()}.${format}`;
  if(format==='pdf'){const pdf=await Print.printToFileAsync({html:journalHtml(data),base64:true});if(!current())return;if(!pdf.base64)throw Error('PDF indisponible.');await FileSystem.writeAsStringAsync(uri,pdf.base64,{encoding:FileSystem.EncodingType.Base64});}
  else await FileSystem.writeAsStringAsync(uri,journalCsv(data),{encoding:FileSystem.EncodingType.UTF8});
  if(!current())return;await Sharing.shareAsync(uri,{mimeType:format==='pdf'?'application/pdf':'text/csv',dialogTitle:'Partager le journal local',UTI:format==='pdf'?'com.adobe.pdf':'public.comma-separated-values-text'});
 });
 const backToDetail=()=>{if(!selected)return retry();void choose(selected);};
 const detailsDay=work?.day??day,detailsClient=selected;
 const search=query.trim().toLocaleLowerCase('fr'),matches=snapshot?.clients.filter(c=>!search||`${c.name} ${c.sector}`.toLocaleLowerCase('fr').includes(search))??[];
 const button=(label:string,action:()=>void,disabled=false)=><TouchableOpacity accessibilityRole="button" disabled={disabled||busy} onPress={action} style={[styles.button,(disabled||busy)&&styles.disabled]}><Text style={styles.buttonText}>{label}</Text></TouchableOpacity>;
 return <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"><View style={styles.header}><Text style={styles.title}>Facture du jour</Text><Text style={styles.subtitle}>{day} · heure de Tunisie</Text></View>
  <Text style={styles.notice}>Espace préparatoire non activé. Les opérations hors ligne des autres téléphones ne sont pas visibles avant synchronisation.</Text>
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}{!!error&&screen==='detail'&&!invoice&&button('Vérifier à nouveau',retry)}{busy&&<Text style={styles.muted}>Vérification en cours…</Text>}
  {screen==='clients'&&<>{!snapshot?button('Vérifier à nouveau',retry):<>{onSynchronize&&button('Synchroniser',sync)}{onClose&&button('Clôturer la journée',closeDay)}{button('Partager le journal local PDF',()=>exportJournal('pdf'))}{button('Partager le journal local CSV',()=>exportJournal('csv'))}<TextInput accessibilityLabel="Rechercher un client" value={query} onChangeText={v=>{setQuery(v);setLimit(40);}} placeholder="Client ou secteur" style={styles.input}/><Text style={styles.muted}>{matches.length} client(s)</Text>{matches.slice(0,limit).map(c=><TouchableOpacity accessibilityRole="button" key={c.id} disabled={busy||c.conflict} onPress={()=>choose({id:c.id,name:c.name})} style={[styles.card,c.conflict&&styles.disabled]}><Text style={styles.name}>{c.name}</Text><Text style={styles.muted}>{c.sector||'Secteur non renseigné'}</Text><Text style={styles.value}>{c.balance===null?'Solde à rapprocher':money(c.balance)}</Text></TouchableOpacity>)}{matches.length>limit&&button('Afficher plus de clients',()=>setLimit(n=>n+40))}</>}</>}
  {screen==='detail'&&detailsClient&&invoice&&<><Text style={styles.name}>{detailsClient.name}</Text><View style={styles.card}><Text style={styles.label}>Préétablie</Text><Text style={styles.value}>{money(invoice.view.preInvoiceTotal)}</Text><Text style={styles.label}>Ventes sur place</Text><Text style={styles.value}>{money(invoice.view.salesTotal)}</Text><Text style={styles.label}>Facture du jour</Text><Text style={styles.total}>{money(invoice.view.total)}</Text><Text style={styles.label}>Payé · reste</Text><Text style={styles.value}>{money(invoice.view.paid)} · {money(invoice.view.remaining)}</Text></View><Text style={styles.name}>Chronologie des opérations</Text><Text style={styles.muted}>Historique local uniquement ; les opérations des autres téléphones ne sont pas toutes visibles ici.</Text>{!timeline.length&&<Text style={styles.muted}>Aucune opération locale.</Text>}{timeline.map(item=>{const date=Number.isFinite(Date.parse(item.date))?new Date(item.date).toLocaleString('fr-FR',{timeZone:'Africa/Tunis'}):'Date indisponible';let label='',detail='';
   if(item.type==='invoice'){label='Facture préétablie';detail=money(item.amount);}
   else if(item.type==='sale'){label='Vente sur place';detail=`À la création : ${money(item.originalTotal)} · actuel : ${money(item.currentTotal)}`;}
   else if(item.type==='revision'){label='Modification de vente';detail=`${money(item.previousTotal)} → ${money(item.currentTotal)}${item.refund?` · remboursement ${money(item.refund)}`:''}`;}
   else if(item.type==='payment'){label=`Règlement facture du jour · ${item.mode}`;detail=`${money(item.amount)} · facture du ${item.invoiceDay}${item.pending?' · en attente de synchronisation':''}`;}
   else if(item.type==='settlement'){label=item.oldDebt?'Règlement ancienne dette':'Règlement global historique';detail=`${money(item.amount)} · ${item.mode}`;}
   else{label='Reçu du journal historique';detail=`Facture ${money(item.prePaid)} · dette ${money(item.oldDebtPaid)} · ${item.mode}${item.creditFull?' · crédit total':''}`;}
   return <View key={item.key} style={styles.card}><Text style={styles.name}>{label}</Text><Text style={styles.muted}>{date} · heure de Tunisie</Text><Text style={styles.value}>{detail}</Text>{item.type==='sale'&&operationDay(item.date)===day&&button('Modifier cette vente',()=>editSale(Number(item.key.slice(5))))}</View>;})}
  {button('Nouvelle préétablie',()=>setScreen('preinvoice'))}{button('Nouvelle vente sur place',()=>setScreen('sale'))}{button('Régler la facture du jour',()=>setScreen('payment'))}{button('Régler l’ancienne dette',()=>setScreen('oldDebt'))}{button('Retour aux clients',retry)}</>}
  {screen==='saleEditDraft'&&editing&&detailsClient&&<DayInvoiceSaleEditScreen sale={editing} articles={snapshot?.articles??[]} capture={(id,lines)=>captureDayInvoiceSaleEditPrototype(identity,id,lines)} confirm={input=>io.saleEdit.prepare({...input,clientId:detailsClient.id,day,operationId:randomUUID()})} confirmCompensation={compensationTestOnly==='DONNEES_FICTIVES_ISOLEES'?input=>confirmCompensationTestPrototype(identity,input,compensationTestOnly):undefined} onBack={backToDetail} onSaved={retry}/>}
  {screen==='compensation'&&work?.kind==='compensation'&&<DayInvoiceCompensationRecoveryScreen bindingKey={key} clientId={work.clientId} day={work.day} read={()=>readCompensationViewPrototype(identity)} synchronize={compensationTestOnly==='DONNEES_FICTIVES_ISOLEES'?onSynchronizeCompensation:undefined} reconcile={compensationTestOnly==='DONNEES_FICTIVES_ISOLEES'?onReconcileCompensation:undefined} readJournal={compensationTestOnly==='DONNEES_FICTIVES_ISOLEES'?onReadCompensatedJournal:undefined} onCheck={retry}/>}
  {screen==='saleEdit'&&work?.kind==='saleEdit'&&work.saleId!==undefined&&<DayInvoiceSaleEditRecoveryScreen bindingKey={key} clientId={work.clientId} day={work.day} saleId={work.saleId} attempts={io.saleEdit} onDone={retry}/>}
  {screen==='preinvoice'&&detailsClient&&<DayInvoicePreinvoiceScreen bindingKey={key} clientId={detailsClient.id} clientName={detailsClient.name} day={detailsDay} capture={(id,d,amount)=>captureNewDayPreinvoicePrototype(identity,id,d,amount)} attempts={io.preinvoice} onBack={work?retry:backToDetail} onSaved={retry} onAbandoned={retry}/>}
  {screen==='sale'&&detailsClient&&<DayInvoiceSaleCreateScreen bindingKey={key} clientId={detailsClient.id} clientName={detailsClient.name} day={detailsDay} articles={snapshot?.articles??[]} capture={(id,d,lines)=>captureNewDayInvoiceSalePrototype(identity,id,d,lines)} attempts={io.sale} onBack={work?retry:backToDetail} onSaved={retry} onAbandoned={retry}/>}
  {screen==='payment'&&detailsClient&&<DayInvoicePaymentScreen bindingKey={key} clientId={detailsClient.id} clientName={detailsClient.name} day={detailsDay} read={()=>readDayInvoiceFormPrototype(identity,detailsClient.id,detailsDay)} attempts={io.payment} onBack={work?retry:backToDetail} onSaved={retry} onAbandoned={retry}/>}
  {screen==='oldDebt'&&detailsClient&&<DayInvoiceOldDebtScreen bindingKey={key} clientId={detailsClient.id} day={detailsDay} read={()=>captureOldDebtFormPrototype(identity,detailsClient.id,detailsDay)} attempts={io.oldDebt} onBack={work?retry:backToDetail} onSaved={retry} onAbandoned={retry}/>}
 </ScrollView>;
}
const styles=StyleSheet.create({content:{padding:16,gap:12},header:{backgroundColor:'#0F1B3D',borderRadius:24,padding:18},title:{fontSize:22,fontWeight:'800',color:'#FFFFFF'},subtitle:{color:'#A3AECB',marginTop:4},notice:{color:'#506178',lineHeight:19},muted:{color:'#66758C'},error:{color:'#A02D34',fontWeight:'700'},card:{backgroundColor:'#FFFFFF',borderRadius:18,padding:16,gap:4},name:{fontWeight:'800',color:'#0F1B3D',fontSize:17},label:{color:'#506178',fontWeight:'600'},value:{color:'#0F1B3D',fontWeight:'700'},total:{color:'#0F1B3D',fontSize:22,fontWeight:'800'},input:{backgroundColor:'#FFFFFF',borderColor:'#B6C4CD',borderWidth:1,borderRadius:12,padding:12,color:'#0F1B3D'},button:{padding:14,borderRadius:14,backgroundColor:'#2DD4BF',alignItems:'center'},buttonText:{fontWeight:'800',color:'#0F1B3D'},disabled:{opacity:0.45}});
