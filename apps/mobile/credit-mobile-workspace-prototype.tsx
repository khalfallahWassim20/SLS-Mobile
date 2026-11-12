/** Composition v5 montée uniquement avec l’option explicite de test isolé.
 * Les formulaires utilisent CreditWriteContext et les gardes transactionnelles. */
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Alert,ScrollView,StyleSheet,Text,TouchableOpacity,View} from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import type {CommercialSession} from './commercial-login';
import type {DeviceIdentity} from './identified-device';
import type {comparePendingRemoteEditPrototype} from './credit-remote-sale-confirm-prototype';
import type {CreditWriteContext} from './credit-note-write-guard-prototype';
import {CreditSaleSettlementViewPrototype} from './credit-sale-settlement-view-prototype';
import {CreditJournalEntryViewPrototype} from './credit-journal-entry-view-prototype';
import type {TourPreInvoice,TourJournalReceipt} from './storage';
import {CreditHistoryViewPrototype} from './credit-history-view-prototype';
import {CreditClientsViewPrototype} from './credit-clients-view-prototype';
import {CreditJournalViewPrototype} from './credit-note-journal-view-prototype';
import {CreditNoteWorkflowView} from './credit-note-workflow-view';
import {shareCreditJournalPrototype} from './credit-note-share-prototype';
import {getAbandonedCreditNotesPrototype,getLocalCreditPrototypes,getPendingRemoteEditPrototype,getCreditClientsPrototype,getCreditMobileWorkspacePrototype,getCreditSourceChoicesPrototype,previewCreditReviewPrototype,confirmCreditReviewPrototype,createExperimentalCreditMobileTransport} from './storage';

type Snapshot=Awaited<ReturnType<typeof getCreditMobileWorkspacePrototype>>;
type Client=Snapshot['clients']['clients'][number];
type Props={identity:DeviceIdentity;day:string;commercialName:string;session:CommercialSession|null;onUnauthorized:()=>void;};
/** Les formulaires transmettent le contexte à SQLite, qui revérifie le solde
 * et l'identité dans la transaction avant d'enregistrer l'opération. */
export function CreditMobileWorkspacePrototype({identity,day,commercialName,session,onUnauthorized}:Props){
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[tab,setTab]=useState<'clients'|'journal'>('journal'),[creditClient,setCreditClient]=useState<{id:string;scope:string}|null>(null),[form,setForm]=useState<{kind:'sale'|'settlement'|'preinvoice'|'receipt';client:Client;context:CreditWriteContext;articles:Snapshot['clients']['articles'];scope:string;invoice?:TourPreInvoice;receipts?:TourJournalReceipt[]}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [comparison,setComparison]=useState<Awaited<ReturnType<typeof comparePendingRemoteEditPrototype>>|null>(null);
 const [pendingClients,setPendingClients]=useState<Snapshot['clients']|null>(null);
 const [abandonedNotes,setAbandonedNotes]=useState<Awaited<ReturnType<typeof getAbandonedCreditNotesPrototype>>>([]);
 const [pendingNotes,setPendingNotes]=useState<Awaited<ReturnType<typeof getLocalCreditPrototypes>>>([]);
 const [pendingRemote,setPendingRemote]=useState<Awaited<ReturnType<typeof getPendingRemoteEditPrototype>>>(null);
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
 const run=async(fn:(seq:number)=>Promise<void>)=>{if(running.current)return;running.current=true;const seq=++generation.current;setBusy(true);setError('');try{await fn(seq);}catch(e){if(alive(seq)){setSnapshot(null);setError(e instanceof Error?e.message:'Opération impossible.');try{const notes=await getLocalCreditPrototypes(identity);if(alive(seq))setPendingNotes(notes.filter(x=>x.pending));const pending=await getPendingRemoteEditPrototype(identity);if(alive(seq)){setPendingRemote(pending);setPendingClients(null);}const clients=await getCreditClientsPrototype(identity);if(alive(seq))setPendingClients(clients);}catch{/* conserver l’erreur principale */}}}finally{running.current=false;if(mounted.current)setBusy(false);}};
 const load=async(seq:number)=>{const archives=await getAbandonedCreditNotesPrototype(identity);if(!alive(seq))return;setAbandonedNotes(archives);const notes=await getLocalCreditPrototypes(identity);if(!alive(seq))return;setPendingNotes(notes.filter(x=>x.pending));const pending=await getPendingRemoteEditPrototype(identity);if(!alive(seq))return;setPendingRemote(pending);setPendingClients(null);if(pending){setSnapshot(null);const clients=await getCreditClientsPrototype(identity);if(alive(seq))setPendingClients(clients);return;}try{const value=await getCreditMobileWorkspacePrototype(identity,day,commercialName);if(alive(seq))setSnapshot(value);}catch(e){const clients=await getCreditClientsPrototype(identity);if(alive(seq)){setSnapshot(null);setPendingClients(clients);setError(`${e instanceof Error?e.message:'Journal indisponible.'} Le journal, ses exports et la clôture restent bloqués ; vérifiez les clients concernés.`);}}};
 useEffect(()=>{
  mounted.current=true;const seq=++generation.current;setSnapshot(null);setPendingRemote(null);setPendingNotes([]);setAbandonedNotes([]);setComparison(null);setPendingClients(null);setCreditClient(null);setForm(null);setHistoryClient(null);setError('');setBusy(true);
  void load(seq).catch(e=>{if(alive(seq))setError(e instanceof Error?e.message:'Données v5 indisponibles.');}).finally(()=>{if(alive(seq)&&!running.current)setBusy(false);});
  return()=>{mounted.current=false;generation.current++;};
 },[identity.commercialId,identity.serverOrigin,day,commercialName]);
 const refresh=()=>void run(load);
 useEffect(()=>{setComparison(null);},[session?.token,session?.expiresAt,session?.serverOrigin]);
 const synchronize=()=>{setComparison(null);void run(async seq=>{if(!transport)throw Error('Reconnectez-vous pour synchroniser.');await transport.synchronize();await load(seq);});};
 const compare=()=>{setComparison(null);void run(async seq=>{if(!transport||!pendingRemote)throw Error('Reconnectez-vous pour comparer.');const result=await transport.compareRemoteEdit(pendingRemote.operationId,pendingRemote.clientId);if(alive(seq))setComparison(result);});};
 const recover=()=>{setComparison(null);void run(async seq=>{if(!transport||!pendingRemote)throw Error('Reconnectez-vous pour vérifier.');const result=await transport.recoverRemoteEdit(pendingRemote.operationId);await load(seq);if(alive(seq))Alert.alert('Modification vérifiée',result.status==='cancelled'?'La modification avait été reçue, puis la facture a été annulée par avoir. Vérifiez les mouvements avant tout remboursement.':result.status==='superseded'?'La modification avait été reçue, puis la facture a été modifiée à nouveau. Récupérez la version actuelle avant toute nouvelle modification.':'La modification a été reçue et vérifiée.');});};
 const abandon=()=>{if(!transport||busy)return;Alert.alert('Abandonner cette modification ?', 'La facture elle-même ne sera pas annulée. Le serveur vérifiera si la modification a déjà été reçue. Si elle est abandonnée, vous pourrez refaire une modification après actualisation.',[{text:'Retour',style:'cancel'},{text:'Abandonner la modification',style:'destructive',onPress:()=>{setComparison(null);void run(async seq=>{const result=await transport.abandonRemoteEdit();if(result==='already-received')throw Error('Cette modification a déjà été reçue par le serveur. Elle ne peut pas être abandonnée : utilisez Synchroniser pour terminer la vérification.');await load(seq);});}}]);};
 const abandonCredit=(operationId:string)=>{if(!transport||busy)return;Alert.alert('Abandonner cette demande d’avoir ?', 'Le serveur vérifiera d’abord si l’avoir a déjà été reçu. Si la demande est abandonnée, la facture reste active ou conserve son état actuel sur le serveur. Vérifiez tout remboursement physique avec l’administrateur.',[{text:'Retour',style:'cancel'},{text:'Vérifier et abandonner',style:'destructive',onPress:()=>void run(async seq=>{const result=await transport.abandonCredit(operationId);if(result==='already-received')throw Error('Cet avoir a déjà été reçu : ne le refaites pas. Synchronisez pour récupérer son accusé.');await load(seq);if(alive(seq))Alert.alert('Demande abandonnée','Aucun nouvel avoir ne sera envoyé avec cet identifiant. Actualisez la facture avant de créer une autre demande. Vérifiez les remboursements physiques.');})}]);};
 const compareCash=()=>void run(async seq=>{
  if(!transport)throw Error('Reconnectez-vous pour comparer les ventes.');
  const result=await transport.compareSaleCash(day);if(!alive(seq))return;
  Alert.alert('Comparaison des ventes',result.matches?'Les paiements initiaux et remboursements de ventes de ce téléphone correspondent aux opérations reçues pour ce commercial à cet instant. Les autres encaissements et avoirs ne sont pas comparés ici ; ce contrôle ne valide pas la clôture.':'Écarts détectés : '+result.onlyLocal+' opération(s) seulement sur ce téléphone, '+result.onlyServer+' seulement sur le serveur, '+result.changed+' différente(s). Synchronisez et vérifiez les autres appareils avec l’administrateur.' + '\n\nLes autres encaissements et avoirs ne sont pas comparés ici.');
 });
 const compareJournalCash=()=>void run(async seq=>{
  if(!transport)throw Error('Reconnectez-vous pour comparer le journal.');
  const result=await transport.compareJournalCash(day);if(!alive(seq))return;
  const labels={invoice:'Préétablie',receipt:'Paiement journal',settlement:'Règlement de dette',credit:'Avoir', 'admin-refund':'Remboursement admin'} as const;
  const detail=result.differences.length?'\n\nExemples d’opérations à vérifier :\n'+result.differences.map(d=>`${labels[d.kind]} · ${d.status==='local'?'téléphone seulement':d.status==='server'?'serveur seulement':'différente'}\n${d.operationId}`).join('\n'):'';
  Alert.alert('Comparaison journal et avoirs',result.matches?'Les préétablies, paiements du journal, règlements de dette, avoirs commerciaux et remboursements administrateur attribués présents sur ce téléphone correspondent à la capture du serveur. Les deux captures peuvent être prises à des instants différents. Les ventes sont comparées séparément. Les données hors ligne d’un autre téléphone et les remboursements administrateur non attribués ne sont pas prouvés. Ce contrôle ne prouve pas le versement physique et ne valide pas la clôture.':'Écarts détectés : '+result.onlyLocal+' opération(s) seulement sur ce téléphone, '+result.onlyServer+' seulement sur le serveur, '+result.changed+' différente(s). Synchronisez et vérifiez avec l’administrateur.' + detail+'\n\nLes ventes sont comparées séparément. Les données hors ligne d’un autre téléphone et les remboursements administrateur non attribués ne sont pas prouvés. Ce contrôle ne prouve pas le versement physique et ne valide pas la clôture.') ;

 });
 const close=()=>{if(!transport||busy)return;Alert.alert('Clôturer la journée ?', 'Synchronisez tous les téléphones utilisés pour cette journée, puis vérifiez le journal et les remboursements. Le serveur compare les opérations reçues à ce téléphone, mais ne voit pas les données encore hors ligne et ne prouve pas les versements physiques. Seul un administrateur pourra rouvrir cette journée.',[{text:'Annuler',style:'cancel'},{text:'Clôturer',onPress:()=>void run(async seq=>{await transport.closeDay(day);await load(seq);})}]);};
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
 const clientList=(clients:Snapshot['clients'])=><CreditClientsViewPrototype snapshot={clients} busy={busy}
   onCredit={c=>selectCredit(c.id)} onHistory={c=>setHistoryClient({id:c.id,scope:context})} onPreInvoice={c=>setForm({kind:'preinvoice',client:c,context:writeContext(c),articles:[],scope:context})} onSell={c=>setForm({kind:'sale',client:c,context:writeContext(c),articles:clients.articles,scope:context})} onSettle={c=>setForm({kind:'settlement',client:c,context:writeContext(c),articles:[],scope:context})}/>;
 if(historyClient?.scope===context)return <CreditHistoryViewPrototype key={`${context}:${historyClient.id}`} identity={identity} clientId={historyClient.id} sessionKey={session?.token??null} inspectLocal={transport?(id,saleId)=>transport.inspectLocalSale(id,saleId):null} reconcileLocal={transport?(id,saleId,proof)=>transport.reconcileLocalSale(id,saleId,proof):null} refreshSources={transport?(clientId)=>transport.refreshSources(clientId):null} onBack={()=>{setHistoryClient(null);refresh();}} onChanged={()=>setSnapshot(null)}/>;
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
  <View style={styles.actions}><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={refresh}><Text style={styles.link}>Actualiser localement</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={busy||!transport} onPress={synchronize}><Text style={styles.link}>Synchroniser</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={busy||!transport||!!pendingRemote||!currentSnapshot} onPress={compareCash}><Text style={styles.link}>Comparer ventes et remboursements</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={busy||!transport||!!pendingRemote||!currentSnapshot} onPress={compareJournalCash}><Text style={styles.link}>Comparer journal et avoirs</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={busy||!transport||!!pendingRemote||!currentSnapshot} onPress={close}><Text style={styles.link}>Clôturer</Text></TouchableOpacity></View>
  {pendingNotes.map(({note})=>{const source=note.source as any,invoice=note.kind==='sale'?source:source.invoice;return <View key={note.command.operationId} style={styles.pending}>
   <Text style={styles.heading}>Avoir en attente · {invoice?.clientName??'Client'}</Text><Text>{note.kind==='sale'?'Vente':'Préétablie'} · facture {note.command.invoiceId} · version {note.command.expectedVersion}</Text>
   <Text>Remboursement prévu : {(note.refund/1000).toFixed(3)} DT · crédit prévu : {(note.retainedCredit/1000).toFixed(3)} DT. Vérifiez tout versement réel.</Text>
   <Text>Une réponse perdue est possible. Le serveur doit confirmer l’absence de réception avant tout abandon.</Text>
   <TouchableOpacity accessibilityRole="button" disabled={busy||!transport} onPress={()=>abandonCredit(note.command.operationId)}><Text style={styles.link}>Vérifier et abandonner cette demande en ligne</Text></TouchableOpacity>
  </View>;})}
  {abandonedNotes.length>0&&<View style={styles.pending}><Text style={styles.heading}>Demandes d’avoir abandonnées</Text><Text>Les 100 plus récentes, archivées sur ce téléphone. Elles ne sont ni des avoirs ni des remboursements confirmés.</Text>{abandonedNotes.map(({note,abandonedAt})=><Text key={note.command.operationId}>{note.kind==='sale'?'Vente':'Préétablie'} · {note.command.invoiceId} · abandon du {abandonedAt.slice(0,10)} · remboursement prévu {(note.refund/1000).toFixed(3)} DT à vérifier</Text>)}</View>}
  {pendingRemote&&<View style={styles.pending}>
   <Text style={styles.heading}>Modification en attente · {pendingRemote.clientName}</Text>
   <Text>Facture {pendingRemote.invoiceId} · opération {pendingRemote.operationId}</Text>
   <Text>Ancien total : {(pendingRemote.originalTotal/1000).toFixed(3)} DT · nouveau total : {(pendingRemote.newTotal/1000).toFixed(3)} DT</Text>
   {pendingRemote.refund>0&&<Text>Remboursement prévu (versement à vérifier) : {(pendingRemote.refund/1000).toFixed(3)} DT</Text>}{pendingRemote.retainedCredit>0&&<Text>Crédit prévu : {(pendingRemote.retainedCredit/1000).toFixed(3)} DT</Text>}
   <Text>{pendingRemote.status==='awaiting-reference'?'Envoi acquitté ; la vérification finale du serveur reste nécessaire.':'Envoi non confirmé. Reconnectez-vous et utilisez Synchroniser pour reprendre la même opération.'}</Text>
   {pendingRemote.failure?.reason==='closed'&&<Text>Dernier refus du serveur : journée {pendingRemote.failure.day} clôturée (commercial : {pendingRemote.failure.commercialId}). Demandez sa réouverture à l’administrateur, puis synchronisez de nouveau.</Text>}
   {pendingRemote.failure?.reason==='conflict'&&<Text>Dernier refus du serveur : conflit de version ou de données. Contactez l’administrateur pour un rapprochement.</Text>}
   <TouchableOpacity accessibilityRole="button" disabled={busy||!transport} onPress={recover}><Text style={styles.link}>Vérifier si le serveur a reçu cette modification</Text></TouchableOpacity>
   {pendingRemote.status==='awaiting-upload'&&<View style={styles.actions}><TouchableOpacity accessibilityRole="button" disabled={busy||!transport} onPress={compare}><Text style={styles.link}>Comparer avec le serveur</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={busy||!transport} onPress={abandon}><Text style={styles.link}>Abandonner cette modification en ligne</Text></TouchableOpacity></View>}
   {comparison&&comparison.operationId===pendingRemote.operationId&&<View style={styles.comparison}>
    <Text style={styles.heading}>Comparaison indicative</Text><Text>Lecture vérifiée à cet instant, susceptible de changer. Elle ne confirme pas l’envoi et ne fusionne rien. Actualisez avant toute décision.</Text>
    {([['Avant modification',comparison.original],['Votre proposition non confirmée',comparison.proposed],['Dernière version reçue du serveur',comparison.current]] as const).map(([label,sale])=><View key={label} style={styles.compareCard}><Text style={styles.heading}>{label}</Text>{sale?<><Text>Version {sale.syncVersion} · total {(sale.total/1000).toFixed(3)} DT · payé {(sale.paid/1000).toFixed(3)} DT · reste {(sale.remaining/1000).toFixed(3)} DT</Text>{sale.lines.map((line,index)=><Text key={`${index}:${line.code}`}>{line.name} ({line.code}) · quantité {line.quantity} · prix {(line.unitPrice/1000).toFixed(3)} DT HT · remise {line.discount/100} % · TVA {line.vat/100} %</Text>)}</>:<Text>Facture annulée par avoir sur le serveur (version {comparison.currentVersion}). Ne pas refaire cette modification.</Text>}</View>)}
    {comparison.refund>0&&<Text>Remboursement proposé : {(comparison.refund/1000).toFixed(3)} DT ; versement à vérifier, l’application ne verse pas l’argent.</Text>}{comparison.retainedCredit>0&&<Text>Crédit proposé : {(comparison.retainedCredit/1000).toFixed(3)} DT, non confirmé.</Text>}
    <Text>{comparison.cancelled?"L’abandon de votre proposition ne supprime pas l’avoir. Contactez l’administrateur en cas de doute.":"Pour refaire une modification, abandonnez d’abord celle-ci en ligne, récupérez la facture actuelle puis saisissez une nouvelle proposition. En cas de doute, contactez l’administrateur."}</Text>
   </View>}

   <Text>Ne supprimez pas les données de l’application : la réponse du serveur peut avoir été perdue. Le client concerné reste bloqué jusqu’à vérification. Les autres clients restent disponibles hors ligne ; le journal, ses exports et la clôture attendent la synchronisation.</Text>
  </View>}
  {pendingClients&&!currentSnapshot&&<><Text style={styles.notice}>Clients disponibles avec leurs contrôles individuels. Un solde en conflit reste bloqué ; l’historique permet de comparer les versions.</Text>{clientList(pendingClients)}</>}
  {!pendingRemote&&(!pendingClients||!!currentSnapshot)&&<>
  <View style={styles.actions}><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>setTab('journal')}><Text style={styles.link}>Journal</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>setTab('clients')}><Text style={styles.link}>Clients et soldes</Text></TouchableOpacity></View>
  {!currentSnapshot?<Text>{busy?'Chargement…':'Données v5 indisponibles.'}</Text>:tab==='journal'?<CreditJournalViewPrototype model={currentSnapshot.view} busy={busy} onCredit={selectCredit} onExport={exportJournal} onPayment={(clientId,invoiceId)=>{
   const client=currentSnapshot.clients.clients.find(c=>c.id===clientId),invoice=currentSnapshot.journal.rows.find(r=>r.clientId===clientId)?.preInvoice;
   if(!client||client.balance===null||client.conflict||!invoice||invoice.id!==invoiceId){setError('Client ou facture indisponible : actualisez le journal.');return;}
   setForm({kind:'receipt',client,context:writeContext(client),articles:[],scope:context,invoice,receipts:currentSnapshot.journal.receipts.filter(r=>r.preInvoiceId===invoice.id)});
  }}/>:clientList(currentSnapshot.clients)}
  </>}
 </ScrollView>;
}
const styles=StyleSheet.create({container:{padding:16,gap:12},title:{fontSize:20,fontWeight:'700',color:'#173c32'},heading:{fontWeight:'700',fontSize:16},comparison:{gap:8,marginVertical:8},compareCard:{backgroundColor:'#fff',borderRadius:8,padding:10,gap:4},pending:{backgroundColor:'#fff4de',padding:12,borderRadius:10,gap:7},notice:{backgroundColor:'#fff4de',padding:10,borderRadius:8,color:'#89511e'},error:{backgroundColor:'#ffebe8',padding:10,borderRadius:8,color:'#842c23'},actions:{flexDirection:'row',gap:16,flexWrap:'wrap'},link:{color:'#176745',fontWeight:'700',paddingVertical:8}});
