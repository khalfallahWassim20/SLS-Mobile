import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { journalCsv, journalHtml } from './journal-export';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, BackHandler, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { calculateInvoice, calculatePayment, reconcileClientBalance, balanceAfterSettlement, isSaleBlocked, parseDinars, revisePayment, reconcileJournalBalance, summarizePreInvoice, validatePreInvoiceReceipt } from '@sls/domain';
import { getAllPreInvoices, getTourReceipts, saveTourReceipt, getJournalOutbox, acknowledgeJournalOutbox, JournalOutboxEntry, TourJournalReceipt, savePreInvoice, TourPreInvoice, getReference, saveReference, getOutbox, acknowledgeOutbox, failOutbox, OutboxEntry, getSales, saveSale, updateSale, getRevisions, getOriginalSales, getSettlements, saveSettlement, SavedSale, Revision, Settlement } from './storage';
import { validateReference, preInvoiceAvailability, hasJournalDayConflict, formatMillimes, unitPriceExcludingVat, ReferenceData, RefClient } from './reference';
import { tunisDay, buildJournal, journalTotal } from './journal';
import { uploadJournalQueue } from './journal-upload';
import { isIdentifiedDeviceBound } from './storage';
import { testCommercialLogin,openCommercialSession } from './commercial-login';
import { clearLocalTestOperations,bindAndCacheIdentified,getBoundIdentity,getIdentifiedOutbox,acknowledgeIdentifiedEntry,observeIdentifiedTour,getLocalCloseAttempt,prepareLocalClose,acknowledgeLocalClose } from './storage';
import { uploadIdentifiedOperations } from './identified-upload';
import { sendPreparedTourClose } from './tour-close-queue';
import { validateIdentifiedReference } from './identified-reference';

// Données de démonstration uniquement. Aucun prix ou client réel n'est enregistré.
type Client = { id: string; name: string; sector: string; balance: number; limit: number };
type Product = { id: string; name: string; code: string; price: number; vat: number };
type CartLine = { product: Product; quantity: number; discount: number };
type Screen = 'clients' | 'products' | 'cart' | 'summary' | 'payment' | 'history' | 'detail' | 'edit' | 'editConfirm' | 'clientBalance' | 'settlement' | 'reference' | 'sync' | 'syncSales' | 'journal' | 'journalAdd' | 'journalDetail' | 'journalPayment' | 'commercialLogin';
const money = (amount: number) => `${(amount / 1000).toFixed(3)} DT`;
const normalize = (s: string) => s.trim().toLocaleLowerCase();

function Button({ label, onPress, secondary = false, disabled = false }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" activeOpacity={0.85} disabled={disabled} onPress={onPress} style={[styles.button, secondary && styles.buttonSecondary, disabled && styles.disabled]}><Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{label}</Text></TouchableOpacity>;
}
const ICONS: [RegExp, string][] = [[/^Journal du jour/, '📒'], [/^Facture préétablie/, '🧾'], [/^Détail du client/, '👤'], [/^Paiement du journal/, '💳'], [/^Accueil/, '🏠'], [/^Données de l/, '🗂️'], [/^Télécharger/, '⬇️'], [/^Envoyer/, '📤'], [/^Solde client/, '💰'], [/^Ajouter des articles/, '🛒'], [/^Votre panier/, '🧺'], [/^Récapitulatif/, '✅'], [/^Paiement/, '💵'], [/^Règlement/, '🤝'], [/^Historique/, '🕘'], [/^Vente démo/, '🧾'], [/^Modifier/, '✏️'], [/^Confirmer/, '✔️']];
function Header({ title, detail, onBack }: { title: string; detail?: string; onBack?: () => void }) {
  const icon = ICONS.find(([pattern]) => pattern.test(title))?.[1] ?? '✨';
  return <View style={styles.header}><View pointerEvents="none" style={styles.headerGlow} /><View pointerEvents="none" style={styles.headerGlow2} /><View pointerEvents="none" style={styles.headerGlow3} /><View style={styles.headerTop}>{onBack ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="Retour à l’écran précédent" hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={onBack} style={styles.backBtn}><Text style={styles.backIcon}>‹</Text><Text style={styles.backText}>Retour</Text></TouchableOpacity> : <View style={styles.brandRow}><View style={styles.brandDot} /><Text style={styles.brand}>SLS MOBILE  ·  DÉMO</Text></View>}<View style={styles.iconBadge}><Text style={styles.iconEmoji}>{icon}</Text></View></View><Text style={styles.title}>{title}</Text>{detail && <Text style={styles.subtitle}>{detail}</Text>}</View>;
}
function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <View style={styles.row}><Text style={[styles.rowLabel, strong && styles.strong]}>{label}</Text><Text style={[styles.rowValue, strong && styles.strong]}>{value}</Text></View>;
}
export default function App() {
  const [screen, setScreen] = useState<Screen>('journal');
  const [journalDate, setJournalDate] = useState(() => tunisDay(new Date()));
  const [preInvoices, setPreInvoices] = useState<TourPreInvoice[]>([]);
  const [tourReceipts, setTourReceipts] = useState<TourJournalReceipt[]>([]);
  const [prePaidInput, setPrePaidInput] = useState('');
  const [oldPaidInput, setOldPaidInput] = useState('');
  const [creditFull, setCreditFull] = useState(false);
  const [journalMode, setJournalMode] = useState<'Espèces' | 'Chèque' | 'Virement'>('Espèces');
  const [journalChequeNumber, setJournalChequeNumber] = useState('');
  const [journalChequeBank, setJournalChequeBank] = useState('');
  const [journalChequeDue, setJournalChequeDue] = useState('');
  const [journalClientId, setJournalClientId] = useState<string | null>(null);
  const [journalSector, setJournalSector] = useState('');
  const [journalQuery, setJournalQuery] = useState('');
  const [journalPick, setJournalPick] = useState<RefClient | null>(null);
  const [journalAmount, setJournalAmount] = useState('');
  const [journalError, setJournalError] = useState('');
  const [journalLoading, setJournalLoading] = useState(true);
  const [returnJournalId, setReturnJournalId] = useState<string | null>(null);
  const [reference, setReference] = useState<ReferenceData | null>(null);
  const [referenceError, setReferenceError] = useState('');
  const [referenceQuery, setReferenceQuery] = useState('');
  const [referenceTab, setReferenceTab] = useState<'clients' | 'articles'>('clients');
  const [serverUrl, setServerUrl] = useState('');
  const [syncToken, setSyncToken] = useState('');
  const [commercialLogin,setCommercialLogin]=useState('');
  const [commercialPassword,setCommercialPassword]=useState('');
  const [commercialResult,setCommercialResult]=useState('');
  const [commercialError,setCommercialError]=useState('');
  const [commercialBusy,setCommercialBusy]=useState(false);
  const commercialBusyRef=useRef(false);
  const tryCommercialLogin=async()=>{
    if(commercialBusyRef.current)return; commercialBusyRef.current=true;setCommercialBusy(true);setCommercialError('');setCommercialResult('');
    const password=commercialPassword;setCommercialPassword('');
    try {const result=await testCommercialLogin(serverUrl,commercialLogin,password,fetch);setCommercialResult(result.name);}
    catch(error){setCommercialError(error instanceof Error?error.message:'Connexion impossible.');}
    finally {commercialBusyRef.current=false;setCommercialBusy(false);}
  };
  const [syncBusy, setSyncBusy] = useState(false);
  const [individual,setIndividual]=useState<{id:string;name:string;serverOrigin:string;token:string}|null>(null);
  const [boundCommercial,setBoundCommercial]=useState(false);
  const [closureLabel,setClosureLabel]=useState('');
  useEffect(()=>{void getBoundIdentity().then(value=>setBoundCommercial(!!value)).catch(()=>setCommercialError('Identité locale indisponible.'));},[]);
  const individualRequest=async(session:NonNullable<typeof individual>,path:string,body?:unknown)=> {
    return fetch(`${session.serverOrigin}/api/mobile/identified/${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${session.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  };
  const readIndividual=async(session:NonNullable<typeof individual>,path:string)=>{
    const response=await individualRequest(session,path),data=await response.json().catch(()=>null);
    if(!response.ok)throw Error(data?.error||`Erreur serveur (${response.status}).`);return data;
  };
  const refreshIndividual=async(session:NonNullable<typeof individual>)=>{
    const value=validateIdentifiedReference(await readIndividual(session,'reference'));
    const identity={commercialId:session.id,serverOrigin:session.serverOrigin};
    await bindAndCacheIdentified(identity,value);
    setReference({...value,version:3,syncedAt:new Date().toISOString()});setBoundCommercial(true);
  };
  const connectIndividual=async()=>{
    if(commercialBusyRef.current)return;commercialBusyRef.current=true;setCommercialBusy(true);setCommercialError('');
    const password=commercialPassword;setCommercialPassword('');
    try {const session=await openCommercialSession(serverUrl,commercialLogin,password,fetch);
      const state=await readIndividual(session,`day/${journalDate}`);
      await refreshIndividual(session);await observeIdentifiedTour({commercialId:session.id,serverOrigin:session.serverOrigin},journalDate,state);
      setClosureLabel(state.status==='closed'?'Journée clôturée':'Journée ouverte');setIndividual(session);setCommercialResult(session.name);setScreen('journal');
    } catch(error){setCommercialError(error instanceof Error?error.message:'Connexion impossible.');}
    finally{commercialBusyRef.current=false;setCommercialBusy(false);}
  };
  const updateIndividualDay=async(session:NonNullable<typeof individual>)=>{
    const state=await readIndividual(session,`day/${journalDate}`);
    await observeIdentifiedTour({commercialId:session.id,serverOrigin:session.serverOrigin},journalDate,state);
    setClosureLabel(state.status==='closed'?'Journée clôturée':'Journée ouverte');return state;
  };
  const sendIndividual=async()=>{
    if(!individual||syncRef.current)return;syncRef.current=true;setSyncBusy(true);
    try {
      const identity={commercialId:individual.id,serverOrigin:individual.serverOrigin},entries=await getIdentifiedOutbox(identity);
      const byId=new Map(entries.map(entry=>[entry.operationId,entry]));
      const count=await uploadIdentifiedOperations(entries,identity,identity,(path,payload)=>fetch(`${individual.serverOrigin}/api/mobile/identified/${path}`,{method:'POST',headers:{Authorization:`Bearer ${individual.token}`,'Content-Type':'application/json'},body:payload}),async(id)=>{const entry=byId.get(id);if(!entry)throw Error('Opération introuvable.');await acknowledgeIdentifiedEntry(identity,entry);});
      await refreshIndividual(individual);await updateIndividualDay(individual);await loadSales();await loadJournal(journalDate);
      Alert.alert('Synchronisation terminée',`${count} opération(s) envoyée(s).`);
    }catch(error){Alert.alert('Synchronisation impossible',error instanceof Error?error.message:'Erreur de synchronisation.');await loadSales();await loadJournal(journalDate);}
    finally{syncRef.current=false;setSyncBusy(false);}
  };
  const closeIndividual=async()=>{
    if(!individual||syncRef.current)return;syncRef.current=true;setSyncBusy(true);
    try {
      const identity={commercialId:individual.id,serverOrigin:individual.serverOrigin};
      let attempt=await getLocalCloseAttempt(identity,journalDate);
      if(!attempt){const state=await updateIndividualDay(individual);if(state.status!=='open')throw Error('Cette journée est déjà clôturée.');attempt=await prepareLocalClose(identity,journalDate,state.version);}
      if(attempt.status==='closed')throw Error('Journée déjà clôturée.');
      await sendPreparedTourClose(attempt,body=>individualRequest(individual,'close',body),body=>acknowledgeLocalClose(identity,journalDate,body));
      const state=await updateIndividualDay(individual);
      if(state.status==='closed')Alert.alert('Journée clôturée','Seul un administrateur peut la rouvrir.');
      else Alert.alert('Journée rouverte','La clôture précédente a été reçue puis rouverte par un administrateur.');
    }catch(error){Alert.alert('Clôture impossible',error instanceof Error?error.message:'Erreur de clôture.');}
    finally{syncRef.current=false;setSyncBusy(false);}
  };

  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const [journalOutbox, setJournalOutbox] = useState<JournalOutboxEntry[]>([]);
  const syncRef = useRef(false);
  const [client, setClient] = useState<Client | null>(null);
  const [saleSource, setSaleSource] = useState<'reference'>('reference');
  const referenceProducts: Product[] = (reference?.articles ?? []).map(a => ({ id: a.id, name: a.name, code: a.code, price: unitPriceExcludingVat(a.saleTtc, a.vatRate), vat: a.vatRate }));
  const saleProducts = referenceProducts;
  const toClient = (c: RefClient): Client | null => (reference?.version !== 2 && reference?.version !== 3) || c.serverBalance === undefined || c.creditLimit === undefined ? null : ({ id: c.id, name: c.name, sector: c.sector, balance: Number(c.serverBalance), limit: Number(c.creditLimit) });
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [sales, setSales] = useState<SavedSale[]>([]);
  const [originalSales, setOriginalSales] = useState<SavedSale[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [settlementAmount, setSettlementAmount] = useState('');
  const [settlementMode, setSettlementMode] = useState('Espèces');
  const [settlementNumber, setSettlementNumber] = useState('');
  const [settlementBank, setSettlementBank] = useState('');
  const [settlementDue, setSettlementDue] = useState('');
  const [selectedSale, setSelectedSale] = useState<SavedSale | null>(null);
  const [editLines, setEditLines] = useState<SavedSale['lines']>([]);
  const [disposition, setDisposition] = useState<'refund' | 'credit' | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [revisionError, setRevisionError] = useState(false);
  const [balanceClient, setBalanceClient] = useState<Client | null>(null);
  const [clientRevisions, setClientRevisions] = useState<Revision[]>([]);
  const [clientRevisionsLoading, setClientRevisionsLoading] = useState(false);
  const [clientRevisionsError, setClientRevisionsError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState(false);
  const [mode, setMode] = useState('Espèces');
  const [paidInput, setPaidInput] = useState('');
  const [chequeNumber, setChequeNumber] = useState('');
  const [chequeBank, setChequeBank] = useState('');
  const [chequeDue, setChequeDue] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const loadSales = async () => { try { const [current, original, payments, pending] = await Promise.all([getSales(), getOriginalSales(), getSettlements(), getOutbox()]); setSales(current); setOriginalSales(original); setSettlements(payments); setOutbox(pending); setStorageError(false); } catch { setStorageError(true); } finally { setLoading(false); } };
  useEffect(() => { const timer = setInterval(() => setJournalDate(tunisDay(new Date())), 60000); return () => clearInterval(timer); }, []);
  const loadJournal = async (_day: string) => { setJournalLoading(true); try { const [invoices, receipts] = await Promise.all([getAllPreInvoices(), getTourReceipts()]); const pending = await getJournalOutbox(); setPreInvoices(invoices); setTourReceipts(receipts); setJournalOutbox(pending); setJournalError(''); } catch { setJournalError('Impossible de lire le journal local.'); } finally { setJournalLoading(false); } };
  useEffect(() => { void loadJournal(journalDate); }, [journalDate]);
  useEffect(() => { void loadSales(); void (async () => { try { const raw = await getReference(); if (raw) { const parsed = JSON.parse(raw); const valid = validateReference(parsed); if (typeof parsed.syncedAt !== 'string') throw Error('Date absente'); setReference({ ...valid, syncedAt: parsed.syncedAt }); } } catch { setReferenceError('Impossible de lire les données de référence locales.'); } })(); }, []);
  const clearPhoneTestHistory=async()=>{
    if(savingRef.current||syncRef.current||loading||journalLoading||commercialBusy)return;
    savingRef.current=true;syncRef.current=true;setSaving(true);setSyncBusy(true);
    try {
      await clearLocalTestOperations();
      setReference(null);setIndividual(null);setClosureLabel('');setSelectedSale(null);setBalanceClient(null);setJournalClientId(null);setClient(null);setCart([]);setSyncToken('');
      setSales([]);setOriginalSales([]);setSettlements([]);setOutbox([]);setPreInvoices([]);setTourReceipts([]);setJournalOutbox([]);
      setReferenceError('');setJournalError('');setScreen('journal');
      Alert.alert('Téléphone nettoyé','Les opérations fictives et les données en attente ont été supprimées sur ce téléphone. Gardez-le déconnecté jusqu’au nettoyage du serveur et des autres téléphones.');
    } catch(error){Alert.alert('Nettoyage impossible',error instanceof Error?error.message:'Erreur locale.');}
    finally {savingRef.current=false;syncRef.current=false;setSaving(false);setSyncBusy(false);}
  };
  const confirmClearPhone=()=>Alert.alert('Nettoyer ce téléphone ?', 'Toutes les ventes, paiements, factures, clôtures et opérations en attente de ce téléphone seront définitivement supprimés. Les clients et articles devront être actualisés depuis le serveur.',[
    {text:'Annuler',style:'cancel'}, {text:'Continuer',style:'destructive',onPress:()=>Alert.alert('Confirmer la suppression', 'À utiliser uniquement pour les données fictives. Déconnectez tous les téléphones et arrêtez l’API avant de nettoyer le serveur. Continuer ?',[
      {text:'Annuler',style:'cancel'}, {text:'Tout effacer sur ce téléphone',style:'destructive',onPress:()=>{void clearPhoneTestHistory();}}
    ])}
  ]);
  const journalRows = useMemo(() => buildJournal(journalDate, preInvoices, sales, new Map((reference?.clients ?? []).map(c => [c.id,c.sector]))), [journalDate,preInvoices,sales,reference]);
  const journalRow = journalRows.find(r => r.clientId === journalClientId);
  const journalReceiptsFor = (p: TourPreInvoice) => tourReceipts.filter(r => r.preInvoiceId === p.id);
  const journalEffectFor = (clientId: string) => preInvoices.filter(p => p.clientId === clientId).reduce((sum,p) => {
    const next=sum+summarizePreInvoice(p.amount,journalReceiptsFor(p)).debtEffect;
    if (!Number.isSafeInteger(next)) throw Error('Solde du journal trop élevé'); return next;
  },0);
  const journalCollectedFor = (clientId: string) => {
    const preCollected=tourReceipts.filter(r => r.clientId===clientId && r.journalDate===journalDate).reduce((sum,r)=>sum+BigInt(r.prePaid)+BigInt(r.oldDebtPaid),0n);
    const saleCollected=journalRows.find(r => r.clientId===clientId)?.sales.reduce((sum,s)=>sum+BigInt(s.paid),0n) ?? 0n;
    const total=preCollected+saleCollected; if(total>BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Encaissement trop élevé'); return Number(total);
  };
  const [exportBusy,setExportBusy] = useState(false);
  const exportJournal = async (format: 'pdf' | 'csv') => {
    if(exportBusy || journalLoading || loading || storageError || journalError) return;
    setExportBusy(true);
    try {
      if (!await Sharing.isAvailableAsync()) throw Error('Le partage de fichiers n’est pas disponible sur cet appareil.');
      const data = { day:journalDate, commercial:individual?.name ?? 'Non disponible (session non connectée)', rows:journalRows, receipts:tourReceipts };
      if(!FileSystem.cacheDirectory) throw Error('Stockage temporaire indisponible.');
      const uri=`${FileSystem.cacheDirectory}journal-${journalDate}-${Date.now()}.${format}`;
      if(format === 'pdf') {
        // Expo Go peut créer le PDF hors du dossier autorisé pour le partage.
        // Le recopier via base64 dans le cache propre au projet, comme pour le CSV.
        const result=await Print.printToFileAsync({html:journalHtml(data),base64:true});
        if(!result.base64) throw Error('Le fichier PDF généré est vide ou indisponible.');
        await FileSystem.writeAsStringAsync(uri,result.base64,{encoding:FileSystem.EncodingType.Base64});
      } else {
        await FileSystem.writeAsStringAsync(uri,journalCsv(data),{encoding:FileSystem.EncodingType.UTF8});
      }
      await Sharing.shareAsync(uri,{mimeType:format==='pdf'?'application/pdf':'text/csv',dialogTitle:'Partager le journal local',UTI:format==='pdf'?'com.adobe.pdf':'public.comma-separated-values-text'});
    } catch(error) { Alert.alert('Export impossible',error instanceof Error ? error.message : 'Erreur locale.'); }
    finally { setExportBusy(false); }
  };
  const beginJournalPayment = () => { setPrePaidInput(''); setOldPaidInput(''); setCreditFull(false); setJournalMode('Espèces'); setJournalChequeNumber(''); setJournalChequeBank(''); setJournalChequeDue(''); setScreen('journalPayment'); };
  const recordJournalPayment = async () => {
    const pre = journalRow?.preInvoice;
    const ref = reference?.clients.find(c => c.id === journalRow?.clientId);
    const customer = ref ? toClient(ref) : null;
    if (!pre || !customer || savingRef.current || journalLoading || storageError || loading) return;
    try {
      if (tunisDay(new Date()) !== journalDate) throw Error('La date a changé : revenez au journal.');
      if (balanceDetails(customer).conflict) throw Error('Solde incohérent : actualisez les données ou contactez l’administrateur.');
      const prePaid = prePaidInput.trim() ? parseDinars(prePaidInput) : 0;
      const oldDebtPaid = oldPaidInput.trim() ? parseDinars(oldPaidInput) : 0;
      const previous = journalReceiptsFor(pre), before = summarizePreInvoice(pre.amount, previous);
      const preDebt = before.declared ? before.remaining : 0;
      const availableNow = Math.max(0, balanceFor(customer) - preDebt);
      const oldDebtLimitAtStart = previous.length ? previous[0].oldDebtLimitAtStart : availableNow;
      const availableOldDebt = Math.min(availableNow, Math.max(0, oldDebtLimitAtStart - before.oldDebtPaid));
      validatePreInvoiceReceipt(pre.amount, previous, { prePaid, oldDebtPaid, creditFull }, availableOldDebt);
      if (journalMode === 'Chèque' && (prePaid || oldDebtPaid) && (!journalChequeNumber.trim() || !journalChequeBank.trim() || !journalChequeDue.trim())) throw Error('Renseignez le numéro, la banque et l’échéance du chèque.');
      savingRef.current = true; setSaving(true);
      await saveTourReceipt({ preInvoiceId: pre.id, clientId: pre.clientId, journalDate: pre.journalDate, createdAt: new Date().toISOString(), prePaid, oldDebtPaid, creditFull, mode: journalMode,
        chequeNumber: journalMode === 'Chèque' ? journalChequeNumber.trim() : '', chequeBank: journalMode === 'Chèque' ? journalChequeBank.trim() : '', chequeDue: journalMode === 'Chèque' ? journalChequeDue.trim() : '', oldDebtLimitAtStart }, availableOldDebt);
      setScreen('journalDetail'); await loadJournal(journalDate); Alert.alert('Opération locale enregistrée', 'Les montants et le solde sur ce téléphone ont été recalculés.');
    } catch(error) { Alert.alert('Opération impossible', error instanceof Error ? error.message : 'Erreur locale.'); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const createPreInvoice = async () => {
    if (!journalPick || savingRef.current || journalLoading || loading || storageError) return;
    try {
      if (tunisDay(new Date()) !== journalDate) throw Error('La date a changé : revenez au journal avant de réessayer.');
      const amount = parseDinars(journalAmount);
      if (amount <= 0) throw Error('Le montant doit être supérieur à zéro.');
      if (!reference?.clients.some(c => c.id === journalPick.id)) throw Error('Client introuvable dans les données téléchargées.');
      const availability=preInvoiceAvailability(reference,journalPick.id,journalDate,preInvoices);
      if (availability === 'local') throw Error('Une facture préétablie existe déjà pour ce client aujourd’hui sur ce téléphone.');
      if (availability === 'remote') throw Error('Une facture préétablie existe déjà pour ce client aujourd’hui sur le serveur. Elle ne peut pas être recréée ici.');
      if (availability === 'refresh') throw Error('Les dates du journal reçu sont incomplètes. Actualisez les données avant de créer cette facture.');
      savingRef.current = true; setSaving(true);
      await savePreInvoice({journalDate,clientId:journalPick.id,clientName:journalPick.name,sector:journalPick.sector,amount,createdAt:new Date().toISOString()});
      setJournalClientId(journalPick.id); setJournalPick(null); setJournalAmount(''); setScreen('journalDetail');
      await loadJournal(journalDate);
    } catch(error) { Alert.alert('Saisie impossible',error instanceof Error ? error.message : 'Erreur locale.'); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const syncReference = async () => {
    if (syncRef.current) return;
    syncRef.current = true; setSyncBusy(true); setReferenceError('');
    try {
      if(await isIdentifiedDeviceBound()) throw Error('Téléphone lié à un commercial : utilisez la synchronisation individuelle depuis le journal.');
      const url = new URL(serverUrl.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname === 'localhost' || url.hostname === '127.0.0.1') throw Error('Saisissez l’adresse réseau de l’API, par exemple http://192.168.1.10:3001.');
      if (!syncToken.trim()) throw Error('Saisissez le jeton de démonstration mobile.');
      const response = await fetch(`${url.origin}/api/mobile/reference`, { headers: { Authorization: `Bearer ${syncToken.trim()}` } });
      if (!response.ok) throw Error(response.status === 401 ? 'Jeton mobile refusé ou mode mobile non activé.' : `Erreur serveur (${response.status}).`);
      const data = validateReference(await response.json());
      if (reference?.version === 3 && data.version !== 3) throw Error('Retour à une ancienne référence refusé : vérifiez le serveur avant de continuer.');
      const snapshot: ReferenceData = { ...data, syncedAt: new Date().toISOString() };
      await saveReference(JSON.stringify(snapshot));
      setReference(snapshot); setSyncToken(''); setScreen('reference');
      Alert.alert('Téléchargement terminé', `${data.clients.length} client(s) et ${data.articles.length} article(s) disponibles en consultation locale.`);
    } catch (error) { setReferenceError(error instanceof Error ? error.message : 'Téléchargement impossible.'); }
    finally { syncRef.current = false; setSyncBusy(false); }
  };
  const uploadSales = async () => {
    if (syncRef.current) return;
    syncRef.current = true; setSyncBusy(true); setReferenceError('');
    let current: OutboxEntry | undefined;
    try {
      if(await isIdentifiedDeviceBound()) throw Error('Téléphone lié à un commercial : utilisez la synchronisation individuelle depuis le journal.');
      const url = new URL(serverUrl.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname === 'localhost' || url.hostname === '127.0.0.1') throw Error('Saisissez l’adresse réseau de l’API, par exemple http://192.168.1.10:3001.');
      if (!syncToken.trim()) throw Error('Saisissez le jeton de démonstration mobile.');
      const entries = await getOutbox(); let sent = 0;
      for (const entry of entries) {
        current = entry;
        const response = await fetch(`${url.origin}/api/mobile/${'settlement' in JSON.parse(entry.payload) ? 'settlements' : 'sales'}`, { method: 'POST', headers: { Authorization: `Bearer ${syncToken.trim()}`, 'Content-Type': 'application/json', 'X-SLS-Reference-Version': String(reference?.version ?? '') }, body: entry.payload });
        if (!response.ok) { const data = await response.json().catch(() => null); throw Error(data?.error || `Erreur serveur (${response.status}).`); }
        await acknowledgeOutbox(entry.operationId);
        sent++;
      }
      current = undefined;
      const journals = await getJournalOutbox();
      if (journals.length && reference?.version !== 3) {
        setSyncToken(''); await loadSales(); await loadJournal(journalDate); setScreen('history');
        Alert.alert('Journal en attente', `${sent} vente(s) ou règlement(s) envoyé(s). Le journal reste en attente : téléchargez une référence v3 lorsque le serveur sera prêt.`);
        return;
      }
      sent += await uploadJournalQueue(journals, entry => fetch(`${url.origin}/api/mobile/journal`, {method:'POST',headers:{Authorization:`Bearer ${syncToken.trim()}`,'Content-Type':'application/json','X-SLS-Reference-Version':'3'},body:entry.payload}), acknowledgeJournalOutbox);
      setSyncToken(''); await loadSales(); await loadJournal(journalDate); setScreen('history'); Alert.alert('Envoi terminé', `${sent} version(s) envoyée(s). Actualisez les données pour recevoir le nouveau solde serveur.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Envoi impossible.';
      if (current) { try { await failOutbox(current.operationId, message); } catch {} }
      setReferenceError(message); await loadSales(); await loadJournal(journalDate);
    } finally { syncRef.current = false; setSyncBusy(false); }
  };
  const balanceDetails = (c: Client) => {
    const remoteClient = reference?.version === 2 || reference?.version === 3 ? reference.clients.find(x => x.id === c.id) : undefined;
    if (journalLoading || journalError || !remoteClient || remoteClient.serverBalance === undefined || !reference?.saleStates || !reference.settlementStates) return { balance: c.balance, conflict: true };
    try {
      const reconciled = reconcileClientBalance({ serverBalance: Number(remoteClient.serverBalance),
        localSales: sales.filter(s => s.clientId === c.id),
        serverSales: reference.saleStates.filter(s => s.clientId === c.id).map(s => ({ ...s, total: Number(s.total), paid: Number(s.paid) })),
        localSettlements: settlements.filter(p => p.clientId === c.id),
        serverSettlementIds: reference.settlementStates.filter(p => p.clientId === c.id).map(p => p.operationId) });
      if (reference.version === 3) {
        if (!reference.journalStates) throw Error('Marqueurs du journal absents');
        const local=preInvoices.filter(p=>p.clientId===c.id).map(p=>({id:p.id,total:p.amount,receipts:journalReceiptsFor(p)}));
        if (reference.journalStates.some(p=>p.clientId!==c.id && local.some(l=>l.id===p.id || l.receipts.some(r=>p.receipts.some(other=>other.id===r.id))))) throw Error('Facture ou règlement rattaché à un autre client');
        const remote=reference.journalStates.filter(p=>p.clientId===c.id);
        if (hasJournalDayConflict(c.id,preInvoices,remote)) throw Error('Factures préétablies potentiellement en conflit');
        const journal=reconcileJournalBalance(reconciled.balance,local,remote);
        return {balance:journal.balance,conflict:reconciled.conflict || journal.conflict};
      }
      const balance = reconciled.balance + journalEffectFor(c.id);
      if (!Number.isSafeInteger(balance)) throw Error('Solde trop élevé');
      return { balance, conflict: reconciled.conflict };
    } catch { return { balance: c.balance, conflict: true }; }
  };
  const balanceFor = (c: Client) => balanceDetails(c).balance;
  const openClientBalance = async (c: Client) => {
    setBalanceClient(c); setClientRevisions([]); setClientRevisionsError(false); setClientRevisionsLoading(true); setScreen('clientBalance');
    try {
      const histories = await Promise.all(sales.filter(s => s.clientId === c.id).map(s => getRevisions(s.id)));
      setClientRevisions(histories.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id));
    } catch { setClientRevisionsError(true); } finally { setClientRevisionsLoading(false); }
  };

  const totals = useMemo(() => cart.length ? calculateInvoice(cart.map(l => ({ quantity: l.quantity, unitPrice: l.product.price, discountRate: l.discount, vatRate: l.product.vat }))) : null, [cart]);
  const editTotals = useMemo(() => editLines.length ? calculateInvoice(editLines.map(l => ({ quantity: l.quantity, unitPrice: l.unitPrice, discountRate: l.discount, vatRate: l.vat }))) : null, [editLines]);
  const openSale = async (sale: SavedSale) => {
    setSelectedSale(sale); setRevisions([]); setRevisionError(false); setScreen('detail');
    try { setRevisions(await getRevisions(sale.id)); } catch { setRevisionError(true); }
  };
  const beginEdit = () => { if (!selectedSale) return; setEditLines(selectedSale.lines.map(l => ({ ...l }))); setDisposition(null); setScreen('edit'); };
  const modifyLine = (index: number, change: Partial<SavedSale['lines'][number]>) => setEditLines(lines => lines.map((l, i) => i === index ? { ...l, ...change } : l));
  const commitEdit = async () => {
    if (!selectedSale || !editTotals || savingRef.current || storageError || loading) return;
    try {
      const refClient = reference?.clients.find(c => c.id === selectedSale.clientId);
      const customer = refClient ? toClient(refClient) : null;
      if (selectedSale.syncSaleId && (!customer || balanceDetails(customer).conflict)) throw new Error('Version incohérente : actualisez les données ou contactez l’administrateur.');
      const result = revisePayment(editTotals.total, selectedSale.paid, disposition ?? undefined);
      const updated: SavedSale = { ...selectedSale, lines: editLines.map(l => ({ ...l })), total: editTotals.total, paid: result.paid, remaining: result.remaining };
      savingRef.current = true; setSaving(true);
      await updateSale(selectedSale, updated, result.refund);
      setScreen('history'); setSelectedSale(null); await loadSales();
      Alert.alert('Modification enregistrée', result.refund ? `Retour d’argent enregistré : ${money(result.refund)}.` : 'Le solde local a été recalculé.');
    } catch (error) { Alert.alert('Modification impossible', error instanceof Error ? error.message : 'Une erreur est survenue.'); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const beginSettlement = () => { setSettlementAmount(''); setSettlementMode('Espèces'); setSettlementNumber(''); setSettlementBank(''); setSettlementDue(''); setScreen('settlement'); };
  const recordSettlement = async () => {
    if (!balanceClient || savingRef.current || storageError || loading) return;
    try {
      const amount = parseDinars(settlementAmount);
      if (tourReceipts.some(r => r.clientId === balanceClient.id)) throw new Error('Ce client a des opérations de journal locales : utilisez le paiement du journal. Le règlement synchronisé est temporairement indisponible pour éviter des soldes divergents.');
      if (balanceDetails(balanceClient).conflict) throw new Error('Solde incohérent : actualisez les données ou contactez l’administrateur.');
      balanceAfterSettlement(balanceFor(balanceClient), amount);
      if (settlementMode === 'Chèque' && (!settlementNumber.trim() || !settlementBank.trim() || !settlementDue.trim())) throw new Error('Renseignez le numéro, la banque et l’échéance du chèque.');
      savingRef.current = true; setSaving(true);
      await saveSettlement({ createdAt: new Date().toISOString(), clientId: balanceClient.id, clientName: balanceClient.name, amount, mode: settlementMode, chequeNumber: settlementMode === 'Chèque' ? settlementNumber.trim() : '', chequeBank: settlementMode === 'Chèque' ? settlementBank.trim() : '', chequeDue: settlementMode === 'Chèque' ? settlementDue.trim() : '' }, reference?.clients.some(c => c.id === balanceClient.id) ?? false);
      setScreen('clients'); await loadSales(); Alert.alert('Règlement de démonstration enregistré', 'Le solde local du client a été mis à jour.');
    } catch (error) { Alert.alert('Règlement impossible', error instanceof Error ? error.message : 'Une erreur est survenue.'); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const selectClient = (value: Client, source: 'reference' = 'reference') => {
    if (balanceDetails(value).conflict) { Alert.alert('Vente bloquée', 'Solde incohérent : actualisez les données ou contactez l’administrateur.'); return false; }
    if (isSaleBlocked(balanceFor(value), value.limit, false)) { Alert.alert('Vente bloquée', 'Ce client a atteint sa limite de crédit. Seul un administrateur peut autoriser la reprise des ventes.'); return false; }
    setClient(value); setSaleSource(source); setCart([]); setQuery(''); setScreen('products'); return true;
  };
  const add = (product: Product) => {
    setCart(current => current.some(l => l.product.id === product.id) ? current.map(l => l.product.id === product.id ? { ...l, quantity: l.quantity + 1 } : l) : [...current, { product, quantity: 1, discount: 0 }]);
    setNotice(`${product.name} ajouté`);
  };
  const change = (id: string, fn: (line: CartLine) => CartLine | null) => setCart(current => current.flatMap(line => line.product.id === id ? ((updated) => updated ? [updated] : [])(fn(line)) : [line]));
  const reset = () => { setClient(null); setCart([]); setQuery(''); setNotice(''); setReturnJournalId(null); setPaidInput(''); setMode('Espèces'); setChequeNumber(''); setChequeBank(''); setChequeDue(''); setScreen('clients'); };
  const recordSale = async () => {
    if (!client || !totals || savingRef.current || storageError || loading) return;
    try {
      const paid = mode === 'Crédit' ? 0 : parseDinars(paidInput);
      const payment = calculatePayment(totals.total, paid);
      if (mode === 'Chèque' && (!chequeNumber.trim() || !chequeBank.trim() || !chequeDue.trim())) throw new Error('Renseignez le numéro, la banque et l’échéance du chèque.');
      if (balanceDetails(client).conflict) throw new Error('Solde incohérent : actualisez les données ou contactez l’administrateur.');
      if (isSaleBlocked(balanceFor(client), client.limit, false)) throw new Error('Le client a atteint sa limite de crédit.');
      savingRef.current = true; setSaving(true);
      await saveSale({ createdAt: new Date().toISOString(), clientId: client.id, clientName: client.name,
        lines: cart.map(l => ({ name: l.product.name, code: l.product.code, quantity: l.quantity, unitPrice: l.product.price, discount: l.discount, vat: l.product.vat })),
        total: totals.total, paid: payment.paid, remaining: payment.remaining, paymentMode: mode,
        chequeNumber: mode === 'Chèque' ? chequeNumber.trim() : '', chequeBank: mode === 'Chèque' ? chequeBank.trim() : '', chequeDue: mode === 'Chèque' ? chequeDue.trim() : '' }, saleSource === 'reference');
      // Une écriture réussie ne doit jamais être proposée à nouveau si la lecture échoue.
      const journalReturn = returnJournalId; reset(); setReturnJournalId(null); if (journalReturn) { setJournalClientId(journalReturn); setScreen('journalDetail'); } await loadSales(); Alert.alert('Vente de démonstration enregistrée', 'Elle est conservée uniquement sur ce téléphone.');
    } catch (error) { Alert.alert('Enregistrement impossible', error instanceof Error ? error.message : 'Une erreur est survenue.'); }
    finally { savingRef.current = false; setSaving(false); }
  };
  // Navigation partagée entre le bouton Android et l'en-tête.
  const lastScreen = useRef<Screen>(screen);
  const detailOrigin = useRef<Screen>('history');
  useEffect(() => {
    if (screen === 'detail' && lastScreen.current !== 'detail' && lastScreen.current !== 'edit' && lastScreen.current !== 'editConfirm') detailOrigin.current = lastScreen.current;
    lastScreen.current = screen;
  }, [screen]);
  const backTarget = (): Screen | null => {
    switch (screen) {
      case 'journal': return null;
      case 'clients': case 'journalAdd': case 'journalDetail': return 'journal';
      case 'journalPayment': return 'journalDetail';
      case 'reference': case 'history': return 'clients';
      case 'sync': case 'clientBalance': case 'commercialLogin': return 'reference';
      case 'syncSales': return 'history';
      case 'settlement': return 'clientBalance';
      case 'products': return returnJournalId ? 'journalDetail' : 'reference';
      case 'cart': return 'products';
      case 'summary': return 'cart';
      case 'payment': return 'summary';
      case 'detail': return (['history', 'journalDetail', 'clientBalance'] as Screen[]).includes(detailOrigin.current) ? detailOrigin.current : 'history';
      case 'edit': return 'detail';
      case 'editConfirm': return 'edit';
      default: return null;
    }
  };
  const goBack = (): boolean => {
    if (saving || syncBusy || commercialBusy) return true;
    const target = backTarget();
    if (!target) {
      Alert.alert('Quitter SLS Mobile ?', 'Vos données locales restent sur ce téléphone.', [{ text: 'Rester', style: 'cancel' }, { text: 'Quitter', onPress: () => BackHandler.exitApp() }]);
      return true;
    }
    if (screen === 'products') { setClient(null); setCart([]); setNotice(''); setQuery(''); if (returnJournalId) setReturnJournalId(null); }
    if (screen === 'sync' || screen === 'syncSales') setSyncToken('');
    if (screen === 'commercialLogin') {setCommercialPassword('');setCommercialResult('');setCommercialError('');}
    setScreen(target);
    return true;
  };
  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;
  useEffect(() => { const subscription = BackHandler.addEventListener('hardwareBackPress', () => goBackRef.current()); return () => subscription.remove(); }, []);
  const headerBack = screen === 'journal' ? undefined : () => { goBack(); };
  return <SafeAreaView style={styles.safe}><StatusBar barStyle="dark-content" /><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    <View style={styles.demo}><Text style={styles.demoText}>Prototype • données fictives • stockage local non chiffré</Text></View>
    {storageError && <View style={styles.demo}><Text style={styles.demoText}>Impossible de lire les ventes locales. Vérifiez le stockage, puis réessayez.</Text><Button label="Réessayer" secondary onPress={() => { setLoading(true); void loadSales(); }} /></View>}
    {screen === 'journal' && <><Header onBack={headerBack} title="Journal du jour" detail={`Tournée du ${journalDate} · heure de Tunisie`} /><Text style={styles.disclaimer}>Données fictives. Les opérations restent sur ce téléphone jusqu’à leur envoi. Un appareil hors ligne peut ne pas encore connaître une clôture faite ailleurs.</Text>{individual ? <><Text style={styles.muted}>Commercial : {individual.name} · {closureLabel || 'État à actualiser'}</Text><Button label="Actualiser l’état de la journée" secondary disabled={syncBusy} onPress={()=>{void updateIndividualDay(individual).catch(e=>Alert.alert('Actualisation impossible',e.message));}}/><Button label={syncBusy?'Synchronisation…':'Synchroniser les opérations'} disabled={syncBusy} onPress={()=>{void sendIndividual();}}/><Button label="Clôturer la journée" disabled={syncBusy} onPress={()=>Alert.alert('Clôturer la journée ?', 'Synchronisez toutes les opérations auparavant. Seul l’administrateur pourra rouvrir cette journée.',[{text:'Annuler',style:'cancel'},{text:'Clôturer',onPress:()=>{void closeIndividual();}}])}/></> : boundCommercial ? <><Text style={styles.warning}>Connectez-vous avec le commercial lié pour synchroniser et clôturer.</Text><Button label="Connexion commercial" secondary onPress={()=>{setCommercialResult('');setCommercialError('');setCommercialPassword('');setScreen('commercialLogin');}} /></> : null}{journalError ? <Text style={styles.warning}>{journalError}</Text> : null}<View style={styles.totalCard}><Row label="Total facturé du jour" value={money(journalTotal(journalRows))} strong /><Row label="Clients" value={`${journalRows.length}`} /><Row label="Total encaissé (net, local)" value={money(journalRows.reduce((sum,r) => sum+journalCollectedFor(r.clientId), 0))} /></View><Text style={styles.muted}>Exports : données de ce téléphone uniquement, non consolidées avec les autres appareils.</Text><Button label={exportBusy ? "Préparation…" : "Exporter le journal en PDF"} secondary disabled={exportBusy || journalLoading || loading || storageError || !!journalError} onPress={()=>{void exportJournal('pdf');}}/><Button label="Exporter le journal en CSV (Excel)" secondary disabled={exportBusy || journalLoading || loading || storageError || !!journalError} onPress={()=>{void exportJournal('csv');}}/><Button label="+ Ajouter une facture préétablie" disabled={journalLoading || loading || storageError} onPress={() => { setJournalPick(null); setJournalAmount(''); setJournalSector(''); setJournalQuery(''); setScreen('journalAdd'); }} />{journalLoading ? <Text style={styles.muted}>Chargement du journal…</Text> : journalRows.length === 0 ? <Text style={styles.muted}>Aucun client dans le journal du jour.</Text> : null}{journalRows.map(r => <TouchableOpacity key={r.clientId} accessibilityRole="button" style={styles.card} onPress={() => { setJournalClientId(r.clientId); setScreen('journalDetail'); }}><Text style={styles.cardTitle}>{r.clientName}</Text><Text style={styles.muted}>{r.sector || 'Secteur non renseigné'}</Text><View style={styles.row}><Text style={styles.price}>{money(r.total)}</Text><Text style={styles.chevron}>›</Text></View></TouchableOpacity>)}<Button label="Autres fonctions" secondary onPress={() => setScreen('clients')} /></>}
    {screen === 'journalAdd' && <><Header onBack={headerBack} title="Facture préétablie" detail="Choisissez un client puis saisissez le montant TTC." /><Text style={styles.disclaimer}>Saisie locale de démonstration : le solde change seulement après traitement de la facture. Le journal reste local jusqu’à son envoi manuel. Les données téléchargées peuvent être périmées hors ligne ; actualisez avant la saisie si possible.</Text>{!reference && <Text style={styles.warning}>Téléchargez d’abord les clients depuis l’administration.</Text>}{reference && <><Text style={styles.section}>SECTEUR</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"><View style={styles.discountRow}><TouchableOpacity style={[styles.chip,!journalSector && styles.chipActive]} onPress={() => { setJournalSector(''); setJournalPick(null); }}><Text style={!journalSector ? styles.chipActiveText : styles.chipText}>Tous</Text></TouchableOpacity>{[...new Set(reference.clients.map(c=>c.sector).filter(Boolean))].sort().map(sector=><TouchableOpacity key={sector} style={[styles.chip,journalSector===sector&&styles.chipActive]} onPress={() => { setJournalSector(sector); setJournalPick(null); }}><Text style={journalSector===sector?styles.chipActiveText:styles.chipText}>{sector}</Text></TouchableOpacity>)}</View></ScrollView><Text style={styles.section}>CLIENT</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Rechercher un client du journal" style={styles.search} value={journalQuery} onChangeText={setJournalQuery} placeholder="Rechercher un client" />{reference.clients.filter(c => (!journalSector || c.sector===journalSector) && normalize(`${c.name} ${c.sector}`).includes(normalize(journalQuery))).map(c=><TouchableOpacity key={c.id} accessibilityRole="button" style={[styles.card,journalPick?.id===c.id && styles.selectedCard]} onPress={() => setJournalPick(c)}><Text style={styles.cardTitle}>{c.name}</Text><Text style={styles.muted}>{c.sector || 'Secteur non renseigné'}{preInvoiceAvailability(reference,c.id,journalDate,preInvoices)==='local' ? ' · Déjà ajouté sur ce téléphone' : preInvoiceAvailability(reference,c.id,journalDate,preInvoices)==='remote' ? ' · Déjà enregistré sur le serveur' : preInvoiceAvailability(reference,c.id,journalDate,preInvoices)==='refresh' ? ' · Actualisation nécessaire' : ''}</Text></TouchableOpacity>)}<Text style={styles.section}>MONTANT TTC (DT)</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Montant préétabli TTC" style={styles.search} keyboardType="decimal-pad" placeholder="0,000" value={journalAmount} onChangeText={setJournalAmount} /><Button label={saving ? 'Enregistrement…' : 'Enregistrer la facture préétablie'} disabled={!journalPick || saving || journalLoading} onPress={() => { void createPreInvoice(); }} /></>}<Button label="Retour au journal" secondary onPress={() => setScreen('journal')} /></>}
    {screen === 'journalDetail' && <><Header onBack={headerBack} title="Détail du client" detail={journalRow?.clientName || 'Journal du jour'} />{journalRow ? <><View style={styles.totalCard}><Row label="Facture préétablie" value={money(journalRow.preInvoice?.amount ?? 0)} /><Row label="Ventes supplémentaires" value={money(journalRow.total - (journalRow.preInvoice?.amount ?? 0))} /><Row label="Total du client" value={money(journalRow.total)} strong /></View><Text style={styles.section}>VENTES DU JOUR SUR CE TÉLÉPHONE</Text>{!journalRow.sales.length && <Text style={styles.muted}>Aucune vente supplémentaire.</Text>}{journalRow.sales.map(s=><TouchableOpacity key={s.id} style={styles.card} onPress={() => { void openSale(s); }}><Text style={styles.cardTitle}>Vente démo #{s.id} · {money(s.total)}</Text><Text style={styles.muted}>{new Date(s.createdAt).toLocaleString('fr-FR')}</Text></TouchableOpacity>)}{journalRow.preInvoice && <><View style={styles.totalCard}><Row label="Règlement de la facture préétablie" value={money(summarizePreInvoice(journalRow.preInvoice.amount,journalReceiptsFor(journalRow.preInvoice)).prePaid)} /><Row label="Règlements ancienne dette" value={money(summarizePreInvoice(journalRow.preInvoice.amount,journalReceiptsFor(journalRow.preInvoice)).oldDebtPaid)} /><Row label="Reste facture préétablie" value={money(summarizePreInvoice(journalRow.preInvoice.amount,journalReceiptsFor(journalRow.preInvoice)).remaining)} /><Row label="Total encaissé local" value={money(journalCollectedFor(journalRow.clientId))} strong /></View>{!summarizePreInvoice(journalRow.preInvoice.amount,journalReceiptsFor(journalRow.preInvoice)).declared && <Text style={styles.warning}>Facture préétablie non encore traitée : elle n’affecte pas le solde.</Text>}<Button label="Règlement facture préétablie / crédit" disabled={journalLoading || loading || storageError} onPress={beginJournalPayment} /><Text style={styles.section}>OPÉRATIONS DU JOURNAL</Text>{journalReceiptsFor(journalRow.preInvoice).map(r=><View key={r.id} style={styles.card}><Text style={styles.cardTitle}>{new Date(r.createdAt).toLocaleString('fr-FR')} · {r.mode}</Text><Text style={styles.muted}>Facture : {money(r.prePaid)} · Ancienne dette : {money(r.oldDebtPaid)}{r.creditFull ? ' · Crédit total' : ''}</Text>{r.mode === 'Chèque' && <Text style={styles.muted}>Chèque {r.chequeNumber} · {r.chequeBank} · échéance {r.chequeDue}</Text>}</View>)}</>}<Text style={styles.disclaimer}>Opérations conservées sur ce téléphone ; seules les versions envoyées sont visibles sur le serveur.</Text><Button label="Ajouter une vente de démo" onPress={() => { const ref=reference?.clients.find(c=>c.id===journalRow.clientId); const selected=ref ? toClient(ref) : null; if (!selected) { Alert.alert('Client indisponible','Actualisez les données clients pour ajouter une vente.'); return; } if (selectClient(selected,'reference')) setReturnJournalId(journalRow.clientId); }} /></> : <Text style={styles.muted}>{journalLoading ? 'Chargement…' : 'Client non trouvé pour cette journée.'}</Text>}<Button label="Retour au journal" secondary onPress={() => setScreen('journal')} /></>}
    {screen === 'journalPayment' && journalRow?.preInvoice && <><Header onBack={headerBack} title="Paiement du journal" detail={journalRow.clientName} /><Text style={styles.disclaimer}>Les deux montants sont indépendants. L’opération reste locale jusqu’à son envoi manuel.</Text><View style={styles.totalCard}><Row label="Facture préétablie" value={money(journalRow.preInvoice.amount)} /><Row label="Déjà payé sur la facture" value={money(summarizePreInvoice(journalRow.preInvoice.amount,journalReceiptsFor(journalRow.preInvoice)).prePaid)} /><Row label="Reste sur la facture" value={money(summarizePreInvoice(journalRow.preInvoice.amount,journalReceiptsFor(journalRow.preInvoice)).remaining)} strong /></View><Text style={styles.section}>RÈGLEMENT DE LA FACTURE PRÉÉTABLIE (DT)</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Règlement de la facture préétablie" style={styles.search} value={prePaidInput} onChangeText={setPrePaidInput} keyboardType="decimal-pad" placeholder="0,000" /><Text style={styles.section}>RÈGLEMENT D’ANCIENNE DETTE (DT)</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Règlement ancienne dette" style={styles.search} value={oldPaidInput} onChangeText={setOldPaidInput} keyboardType="decimal-pad" placeholder="0,000" /><Text style={styles.hint}>Le règlement ne peut pas dépasser la dette connue avant le traitement de la facture, moins les règlements déjà saisis.</Text><TouchableOpacity accessibilityRole="checkbox" accessibilityState={{checked:creditFull}} style={[styles.chip,creditFull && styles.chipActive,styles.creditChoice]} onPress={() => setCreditFull(!creditFull)}><Text style={creditFull ? styles.chipActiveText : styles.chipText}>{creditFull ? '☑' : '☐'} Facture entièrement à crédit</Text></TouchableOpacity><Text style={styles.hint}>Cochez uniquement si rien n’est payé sur cette facture lors de son premier traitement.</Text><Text style={styles.section}>MODE COMMUN AUX MONTANTS ENCAISSÉS</Text><View style={styles.discountRow}>{(['Espèces','Chèque','Virement'] as const).map(m=><TouchableOpacity key={m} accessibilityRole="button" onPress={()=>setJournalMode(m)} style={[styles.chip,journalMode===m&&styles.chipActive]}><Text style={journalMode===m?styles.chipActiveText:styles.chipText}>{m}</Text></TouchableOpacity>)}</View>{journalMode==='Chèque' && <><Text style={styles.section}>CHÈQUE</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Numéro du chèque du journal" style={styles.search} value={journalChequeNumber} onChangeText={setJournalChequeNumber} placeholder="Numéro du chèque" /><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Banque du chèque du journal" style={[styles.search,styles.inputGap]} value={journalChequeBank} onChangeText={setJournalChequeBank} placeholder="Banque" /><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Échéance du chèque du journal" style={[styles.search,styles.inputGap]} value={journalChequeDue} onChangeText={setJournalChequeDue} placeholder="Échéance" /></>}<Button label={saving?'Enregistrement…':'Enregistrer l’opération locale'} disabled={saving || journalLoading || loading || storageError} onPress={() => { void recordJournalPayment(); }} /><Button label="Annuler" secondary onPress={()=>setScreen('journalDetail')} /></>}
    {screen === 'clients' && <><Header onBack={headerBack} title="Accueil" detail="Clients et articles téléchargés depuis l’administration." /><Text style={styles.disclaimer}>Données de démonstration uniquement. Téléchargez les données avant de commencer une vente. Le solde inclut les opérations locales et le dernier état téléchargé. Les opérations des autres appareils ne sont connues qu’après actualisation.</Text><Button label="Journal du jour" secondary onPress={() => setScreen('journal')} /><Button label="Clients et articles de l’administration" onPress={() => { setReferenceQuery(''); setScreen('reference'); }} /><Button label={`Historique local (${sales.length})`} secondary onPress={() => setScreen('history')} disabled={loading || storageError} /><Text style={styles.hint}>Les anciennes opérations restent dans l’historique. Les anciens clients et articles intégrés ne sont plus proposés.</Text></>}
    {screen === 'reference' && <><Header onBack={headerBack} title="Données de l’administration" detail="Consultation locale · prototype" /><Text style={styles.disclaimer}>Données fictives uniquement. Les opérations sont envoyées manuellement. Les soldes et plafonds peuvent être périmés hors ligne.</Text><Text style={styles.muted}>{reference ? `Dernier téléchargement : ${new Date(reference.syncedAt).toLocaleString('fr-FR')}` : 'Aucun téléchargement effectué.'}</Text>{referenceError ? <Text style={styles.warning}>{referenceError}</Text> : null}<Button label="Télécharger / actualiser" onPress={() => { setReferenceError(''); setScreen('sync'); }} /><Button label="Connexion commercial" secondary onPress={() => {setCommercialResult('');setCommercialError('');setCommercialPassword('');setScreen('commercialLogin');}} /><View style={styles.discountRow}><Button label={`Clients (${reference?.clients.length ?? 0})`} secondary={referenceTab !== 'clients'} onPress={() => { setReferenceTab('clients'); setReferenceQuery(''); }} /><Button label={`Articles (${reference?.articles.length ?? 0})`} secondary={referenceTab !== 'articles'} onPress={() => { setReferenceTab('articles'); setReferenceQuery(''); }} /></View><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Rechercher dans les données téléchargées" style={[styles.search, styles.inputGap]} placeholder="Rechercher" value={referenceQuery} onChangeText={setReferenceQuery} />{referenceTab === 'clients' ? reference?.clients.filter(c => normalize(`${c.name} ${c.sector}`).includes(normalize(referenceQuery))).map(c => <View key={c.id} style={styles.card}><Text style={styles.cardTitle}>{c.name}</Text><Text style={styles.muted}>{c.sector || 'Secteur non renseigné'}</Text>{toClient(c) ? <><Button label="Consulter le solde" secondary disabled={loading || storageError} onPress={() => { const customer=toClient(c); if(customer) void openClientBalance(customer); }} /><Button label="Nouvelle vente de démo" disabled={loading || storageError} onPress={() => { const customer=toClient(c); if(customer) selectClient(customer,'reference'); }} /></> : <Text style={styles.warning}>Actualisez les données pour accéder aux soldes et ventes.</Text>}</View>) : reference?.articles.filter(a => normalize(`${a.name} ${a.code} ${a.barcode}`).includes(normalize(referenceQuery))).map(a => <View key={a.id} style={styles.card}><Text style={styles.cardTitle}>{a.name}</Text><Text style={styles.muted}>{a.code} · TVA {a.vatRate / 100} %</Text><Text style={styles.price}>{formatMillimes(a.saleTtc)} TTC / unité</Text></View>)}<Button label="Retour à l’accueil" secondary onPress={() => setScreen('clients')} /></>}
    {screen === 'commercialLogin' && <><Header onBack={headerBack} title="Connexion commercial" detail="Compte individuel" /><Text style={styles.disclaimer}>Le test ne lie pas le téléphone. La connexion individuelle lie ce téléphone au commercial et au serveur après synchronisation de toutes les opérations en attente. Le mot de passe et la session ne sont pas enregistrés. En HTTP, utilisez seulement des identifiants fictifs sur un réseau privé de confiance.</Text><Text style={styles.section}>ADRESSE DE L’API</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Adresse du serveur commercial" style={styles.search} autoCapitalize="none" autoCorrect={false} value={serverUrl} onChangeText={setServerUrl} placeholder="http://192.168.1.10:3001" /><Text style={styles.section}>IDENTIFIANT COMMERCIAL</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Identifiant commercial" style={styles.search} autoCapitalize="none" autoCorrect={false} value={commercialLogin} onChangeText={setCommercialLogin} /><Text style={styles.section}>MOT DE PASSE FICTIF</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Mot de passe commercial" style={styles.search} autoCapitalize="none" autoCorrect={false} secureTextEntry value={commercialPassword} onChangeText={setCommercialPassword} />{commercialError ? <Text style={styles.warning}>{commercialError}</Text> : null}{commercialResult ? <Text style={styles.muted}>Connexion de test réussie : {commercialResult}. Aucune opération n’a été attribuée.</Text> : null}<Button label={commercialBusy?'Vérification…':'Tester la connexion'} disabled={commercialBusy} onPress={()=>{void tryCommercialLogin();}} /><Button label={commercialBusy?'Connexion…':'Connexion individuelle'} disabled={commercialBusy} onPress={()=>{void connectIndividual();}} /><Button label="Retour" secondary disabled={commercialBusy} onPress={()=>{setCommercialPassword('');setCommercialResult('');setCommercialError('');setScreen('reference');}} /></>}
    {screen === 'sync' && <><Header onBack={headerBack} title="Télécharger les données" detail="Connexion manuelle à l’API de démonstration" /><Text style={styles.disclaimer}>Le mode HTTP local n’est pas chiffré : uniquement sur un réseau privé de confiance et avec des données et un jeton de test. Le jeton n’est pas enregistré. N’utilisez jamais le mot de passe administrateur.</Text><Text style={styles.section}>ADRESSE DE L’API</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Adresse du serveur" style={styles.search} autoCapitalize="none" autoCorrect={false} value={serverUrl} onChangeText={setServerUrl} placeholder="http://192.168.1.10:3001" /><Text style={styles.section}>JETON DE DÉMONSTRATION MOBILE</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Jeton mobile" style={styles.search} autoCapitalize="none" autoCorrect={false} secureTextEntry value={syncToken} onChangeText={setSyncToken} placeholder="Jeton mobile de test" />{referenceError ? <Text style={styles.warning}>{referenceError}</Text> : null}<Button label={syncBusy ? 'Téléchargement…' : 'Télécharger'} disabled={syncBusy} onPress={() => { void syncReference(); }} /><Button label="Annuler" secondary disabled={syncBusy} onPress={() => { setSyncToken(''); setScreen('reference'); }} /></>}
    {screen === 'syncSales' && <><Header onBack={headerBack} title="Envoyer les opérations" detail={`${outbox.length} vente(s) ou règlement(s) et ${journalOutbox.length} version(s) de journal en attente`} /><Text style={styles.disclaimer}>Démonstration uniquement. Les échanges HTTP ne sont pas chiffrés. Les opérations sont fictives et ne sont pas des factures officielles. Le solde serveur dépend des opérations reçues.</Text><Text style={styles.section}>ADRESSE DE L’API</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Adresse du serveur" style={styles.search} autoCapitalize="none" autoCorrect={false} value={serverUrl} onChangeText={setServerUrl} placeholder="http://192.168.1.10:3001" /><Text style={styles.section}>JETON MOBILE DE TEST</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Jeton mobile" style={styles.search} autoCapitalize="none" autoCorrect={false} secureTextEntry value={syncToken} onChangeText={setSyncToken} placeholder="Jeton mobile de test" />{referenceError ? <Text style={styles.warning}>{referenceError}</Text> : null}<Button label={syncBusy ? 'Envoi…' : 'Envoyer'} disabled={syncBusy} onPress={() => { void uploadSales(); }} /><Button label="Annuler" secondary disabled={syncBusy} onPress={() => { setSyncToken(''); setScreen('history'); }} /></>}
    {screen === 'clientBalance' && balanceClient && <><Header onBack={headerBack} title="Solde client" detail={`${balanceClient.name} · ${balanceClient.sector}`} /><View style={styles.totalCard}><Row label="Dette actuelle" value={money(Math.max(0, balanceFor(balanceClient)))} strong /><Row label="Crédit en faveur du client" value={money(Math.max(0, -balanceFor(balanceClient)))} /><Row label="Plafond de crédit" value={money(balanceClient.limit)} /><Row label="Dernier solde serveur reçu" value={money(Number(reference?.clients.find(c => c.id === balanceClient.id)?.serverBalance ?? balanceClient.balance))} /></View><Text style={styles.hint}>Solde serveur au dernier téléchargement, ajusté par les opérations locales non encore prises en compte et par le journal local. Les opérations des autres appareils ne sont visibles qu’après actualisation.</Text>{balanceDetails(balanceClient).conflict && <Text style={styles.warning}>Solde ou journal incohérent : le montant affiché peut être incomplet. Actualisez les données ou contactez l’administrateur ; les nouvelles opérations sont bloquées.</Text>}{isSaleBlocked(balanceFor(balanceClient), balanceClient.limit, false) && <Text style={styles.warning}>Limite atteinte : vente bloquée.</Text>}
      <Button label="Enregistrer un règlement" onPress={beginSettlement} disabled={balanceFor(balanceClient) <= 0 || balanceDetails(balanceClient).conflict || storageError || loading || tourReceipts.some(r => r.clientId === balanceClient.id)} />{tourReceipts.some(r => r.clientId === balanceClient.id) && <Text style={styles.warning}>Règlement global temporairement indisponible pour ce client : utilisez le journal du jour.</Text>}<Text style={styles.hint}>Le règlement réduit la dette globale ; il n’est pas attribué à une facture particulière dans cette démo.</Text><Text style={styles.section}>FACTURES PRÉÉTABLIES DU JOURNAL · LOCALES</Text>{journalError ? <Text style={styles.warning}>Impossible de charger l’historique du journal local.</Text> : journalLoading ? <Text style={styles.muted}>Chargement du journal…</Text> : preInvoices.filter(p => p.clientId === balanceClient.id).length === 0 ? <Text style={styles.muted}>Aucune facture préétablie locale pour ce client.</Text> : [...preInvoices].filter(p => p.clientId === balanceClient.id).sort((a,b) => b.journalDate.localeCompare(a.journalDate)).map(p => {
        const receipts = journalReceiptsFor(p);
        const summary = summarizePreInvoice(p.amount, receipts);
        return <View key={p.id} style={styles.card}><Text style={styles.cardTitle}>Facture préétablie · {p.journalDate}</Text><Text style={styles.muted}>Journal local · {journalOutbox.some(x => x.invoiceId === p.id) ? 'versions en attente d’envoi' : 'envoyé (actualiser les données)'}</Text><Row label="Montant de la facture" value={money(p.amount)} /><Row label="Paiements sur la facture" value={money(summary.prePaid)} /><Row label="Reste de la facture" value={money(summary.remaining)} /><Row label="Règlements d’ancienne dette" value={money(summary.oldDebtPaid)} />{!summary.declared && <Text style={styles.warning}>Non traitée : le reste n’est pas encore inclus dans le solde.</Text>}{receipts.map(r => <View key={r.id} style={styles.journalHistoryEntry}><Text style={styles.cardTitle}>Opération du {new Date(r.createdAt).toLocaleString('fr-FR')}</Text><Text style={styles.muted}>{r.creditFull ? 'Facture entièrement à crédit' : 'Paiement'}{(r.prePaid > 0 || r.oldDebtPaid > 0) ? ` · ${r.mode}` : ''}</Text><Row label="Paiement de la facture" value={money(r.prePaid)} /><Row label="Règlement d’ancienne dette" value={money(r.oldDebtPaid)} />{r.mode === 'Chèque' && <Text style={styles.muted}>Chèque {r.chequeNumber} · {r.chequeBank} · échéance {r.chequeDue}</Text>}</View>)}</View>;
      })}<Text style={styles.section}>VENTES DU CLIENT</Text>{sales.filter(s => s.clientId === balanceClient.id).length === 0 && <Text style={styles.muted}>Aucune vente enregistrée pour ce client.</Text>}{sales.filter(s => s.clientId === balanceClient.id).map(s => <TouchableOpacity key={s.id} accessibilityRole="button" style={styles.card} onPress={() => { void openSale(s); }}><Text style={styles.cardTitle}>Vente démo #{s.id}</Text><Text style={styles.muted}>{new Date(s.createdAt).toLocaleString('fr-FR')}</Text><Row label="Total actuel" value={money(s.total)} /><Row label="Paiement net conservé" value={money(s.paid)} /><Row label={s.total >= s.paid ? 'Dette de cette vente' : 'Crédit de cette vente'} value={money(Math.abs(s.total - s.paid))} /><Text style={styles.hint}>Appuyez pour consulter la vente et ses modifications.</Text></TouchableOpacity>)}
      <Text style={styles.section}>RÈGLEMENTS DE DETTE</Text>{settlements.filter(p => p.clientId === balanceClient.id).length === 0 && <Text style={styles.muted}>Aucun règlement de dette.</Text>}{settlements.filter(p => p.clientId === balanceClient.id).map(p => <View key={p.id} style={styles.card}><Text style={styles.cardTitle}>Règlement : {money(p.amount)}</Text><Text style={styles.muted}>{p.mode} · {new Date(p.createdAt).toLocaleString('fr-FR')} · {p.syncOperationId ? (outbox.some(o => o.operationId === p.syncOperationId) ? 'En attente' : 'Envoyé') : 'Local seulement'}</Text>{p.mode === 'Chèque' && <Text style={styles.muted}>Chèque {p.chequeNumber} · {p.chequeBank} · échéance {p.chequeDue}</Text>}</View>)}<Text style={styles.section}>REMBOURSEMENTS ENREGISTRÉS</Text>{clientRevisionsLoading && <Text style={styles.muted}>Chargement…</Text>}{clientRevisionsError && <><Text style={styles.warning}>Impossible de charger les remboursements.</Text><Button label="Réessayer" secondary onPress={() => { void openClientBalance(balanceClient); }} /></>}{!clientRevisionsLoading && !clientRevisionsError && clientRevisions.filter(r => r.refund > 0).length === 0 && <Text style={styles.muted}>Aucun remboursement enregistré.</Text>}{!clientRevisionsError && clientRevisions.filter(r => r.refund > 0).map(r => <View key={r.id} style={styles.card}><Text style={styles.cardTitle}>Retour d’argent : {money(r.refund)}</Text><Text style={styles.muted}>Vente démo #{r.current.id} · {new Date(r.createdAt).toLocaleString('fr-FR')}</Text><Text style={styles.hint}>Déjà pris en compte dans le paiement net conservé.</Text></View>)}<Text style={styles.disclaimer}>Données fictives sur ce téléphone uniquement. Les remboursements sont enregistrés, pas effectués par l’application. Le crédit ne peut pas encore être utilisé pour payer une autre vente.</Text><Button label="Retour aux clients" secondary onPress={() => setScreen('clients')} /></>}
    {screen === 'products' && client && <><Header onBack={headerBack} title="Ajouter des articles" detail={`Client : ${client.name}`} /><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Rechercher un article" style={styles.search} placeholder="Rechercher un article ou un code" value={query} onChangeText={setQuery} />{notice ? <Text accessibilityLiveRegion="polite" style={styles.success}>{notice}</Text> : null}<Text style={styles.section}>{saleSource === 'reference' ? 'CATALOGUE TÉLÉCHARGÉ · DÉMONSTRATION' : 'CATALOGUE DE DÉMONSTRATION'}</Text>{saleSource === 'reference' && <Text style={styles.warning}>Prix HT calculé depuis le TTC : arrondi provisoire à valider. Les ventes restent locales.</Text>}
      {saleProducts.filter(p => normalize(`${p.name} ${p.code}`).includes(normalize(query))).map(p => <View key={p.id} style={styles.card}><Text style={styles.cardTitle}>{p.name}</Text><Text style={styles.muted}>{p.code} · TVA {p.vat / 100} %</Text><View style={[styles.row, styles.cardBottom]}><Text style={styles.price}>{money(p.price)} HT</Text><Button label="+ Ajouter" secondary onPress={() => add(p)} /></View></View>)}
      <Button label={`Voir le panier (${cart.reduce((n, l) => n + l.quantity, 0)})`} onPress={() => setScreen('cart')} disabled={!cart.length} /><Button label="Changer de client" secondary onPress={() => { if (saleSource === 'reference') { setClient(null); setCart([]); setScreen('reference'); } else reset(); }} />
    </>}
    {screen === 'cart' && client && <><Header onBack={headerBack} title="Votre panier" detail={client.name} />{cart.map(l => <View key={l.product.id} style={styles.card}><Text style={styles.cardTitle}>{l.product.name}</Text><Text style={styles.muted}>{money(l.product.price)} HT / unité</Text><View style={[styles.row, styles.cardBottom]}><View style={styles.quantity}><TouchableOpacity accessibilityLabel={`Réduire la quantité de ${l.product.name}`} onPress={() => change(l.product.id, x => x.quantity === 1 ? null : { ...x, quantity: x.quantity - 1 })}><Text style={styles.quantityButton}>−</Text></TouchableOpacity><Text style={styles.quantityNumber}>{l.quantity}</Text><TouchableOpacity accessibilityLabel={`Augmenter la quantité de ${l.product.name}`} onPress={() => change(l.product.id, x => ({ ...x, quantity: x.quantity + 1 }))}><Text style={styles.quantityButton}>+</Text></TouchableOpacity></View><TouchableOpacity accessibilityRole="button" onPress={() => change(l.product.id, () => null)}><Text style={styles.remove}>Supprimer</Text></TouchableOpacity></View><Text style={styles.muted}>Remise : {l.discount / 100} %</Text><View style={styles.discountRow}>{[0, 5, 10, 20].map(percent => <TouchableOpacity key={percent} accessibilityRole="button" onPress={() => change(l.product.id, x => ({ ...x, discount: percent * 100 }))} style={[styles.chip, l.discount === percent * 100 && styles.chipActive]}><Text style={l.discount === percent * 100 ? styles.chipActiveText : styles.chipText}>{percent} %</Text></TouchableOpacity>)}</View><Text style={styles.hint}>Remises prédéfinies pour cette démonstration.</Text></View>)}
      {totals && <View style={styles.totalCard}><Row label="Sous-total HT" value={money(totals.subtotal)} /><Row label="Remise" value={`− ${money(totals.discount)}`} /><Row label="Total HT" value={money(totals.net)} /><Row label="TVA" value={money(totals.vat)} /><Row label="Total TTC" value={money(totals.total)} strong /></View>}
      <Button label="Vérifier la vente" disabled={!totals} onPress={() => setScreen('summary')} /><Button label="+ Ajouter des articles" secondary onPress={() => { setNotice(''); setQuery(''); setScreen('products'); }} />
    </>}
    {screen === 'summary' && client && totals && <><Header onBack={headerBack} title="Récapitulatif" detail="Vérifiez les informations de cette démonstration." /><View style={styles.card}><Text style={styles.section}>CLIENT</Text><Text style={styles.cardTitle}>{client.name}</Text><Text style={styles.muted}>{client.sector}</Text></View><View style={styles.card}><Text style={styles.section}>ARTICLES</Text>{cart.map(l => <Row key={l.product.id} label={`${l.quantity} × ${l.product.name}`} value={`${l.discount / 100} % remise`} />)}</View><View style={styles.totalCard}><Row label="Total HT" value={money(totals.net)} /><Row label="TVA" value={money(totals.vat)} /><Row label="Total TTC" value={money(totals.total)} strong /></View><Text style={styles.disclaimer}>Ceci est une vente de démonstration, pas une facture officielle. Aucun envoi au serveur.</Text><Button label="Continuer vers le paiement" onPress={() => { setPaidInput((totals.total / 1000).toFixed(3)); setScreen('payment'); }} /><Button label="Modifier le panier" secondary onPress={() => setScreen('cart')} /><Button label="Commencer une nouvelle démo" secondary onPress={reset} /></>}
    {screen === 'payment' && client && totals && <><Header onBack={headerBack} title="Paiement" detail={`Total : ${money(totals.total)}`} /><Text style={styles.section}>MODE DE PAIEMENT</Text><View style={styles.discountRow}>{['Espèces', 'Chèque', 'Virement', 'Crédit'].map(m => <TouchableOpacity key={m} accessibilityRole="button" onPress={() => setMode(m)} style={[styles.chip, mode === m && styles.chipActive]}><Text style={mode === m ? styles.chipActiveText : styles.chipText}>{m}</Text></TouchableOpacity>)}</View>
      {mode !== 'Crédit' && <><Text style={styles.section}>MONTANT ENCAISSÉ (DT)</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Montant encaissé en dinars" style={styles.search} value={paidInput} onChangeText={setPaidInput} keyboardType="decimal-pad" placeholder="0,000" /><Text style={styles.hint}>Maximum 3 décimales. Un paiement partiel est possible.</Text></>}
      {mode === 'Chèque' && <><Text style={styles.section}>INFORMATIONS DU CHÈQUE</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Numéro du chèque" style={styles.search} value={chequeNumber} onChangeText={setChequeNumber} placeholder="Numéro du chèque" /><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Banque" style={[styles.search, styles.inputGap]} value={chequeBank} onChangeText={setChequeBank} placeholder="Banque" /><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Échéance du chèque" style={[styles.search, styles.inputGap]} value={chequeDue} onChangeText={setChequeDue} placeholder="Échéance (ex. 30/12/2026)" /></>}
      <Text style={styles.disclaimer}>Données fictives uniquement : les ventes sont stockées sans chiffrement et envoyées manuellement.</Text><Button label={saving ? 'Enregistrement…' : 'Enregistrer la démo'} disabled={saving || loading || storageError} onPress={() => { void recordSale(); }} /><Button label="Retour au récapitulatif" secondary onPress={() => setScreen('summary')} /></>}
    {screen === 'settlement' && balanceClient && <><Header onBack={headerBack} title="Règlement de dette" detail={balanceClient.name} /><View style={styles.totalCard}><Row label="Dette actuelle" value={money(Math.max(0, balanceFor(balanceClient)))} strong /></View><Text style={styles.section}>MODE DE PAIEMENT</Text><View style={styles.discountRow}>{['Espèces', 'Chèque', 'Virement'].map(m => <TouchableOpacity key={m} accessibilityRole="button" onPress={() => setSettlementMode(m)} style={[styles.chip, settlementMode === m && styles.chipActive]}><Text style={settlementMode === m ? styles.chipActiveText : styles.chipText}>{m}</Text></TouchableOpacity>)}</View><Text style={styles.section}>MONTANT ENCAISSÉ (DT)</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Montant du règlement" style={styles.search} value={settlementAmount} onChangeText={setSettlementAmount} keyboardType="decimal-pad" placeholder="0,000" /><Text style={styles.hint}>Le montant doit être positif et ne peut pas dépasser la dette globale.</Text>{settlementMode === 'Chèque' && <><Text style={styles.section}>INFORMATIONS DU CHÈQUE</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Numéro du chèque" style={styles.search} value={settlementNumber} onChangeText={setSettlementNumber} placeholder="Numéro du chèque" /><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Banque" style={[styles.search, styles.inputGap]} value={settlementBank} onChangeText={setSettlementBank} placeholder="Banque" /><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Échéance du chèque" style={[styles.search, styles.inputGap]} value={settlementDue} onChangeText={setSettlementDue} placeholder="Échéance (ex. 30/12/2026)" /></>}<Text style={styles.disclaimer}>Règlement fictif de la dette globale : aucune facture n’est marquée payée individuellement et aucun argent n’est transféré.</Text><Button label={saving ? 'Enregistrement…' : 'Enregistrer le règlement'} disabled={saving || loading || storageError} onPress={() => { void recordSettlement(); }} /><Button label="Annuler" secondary onPress={() => setScreen('clientBalance')} /></>}
    {screen === 'history' && <><Header onBack={headerBack} title="Historique local" detail="Ventes et paiements fictifs enregistrés sur ce téléphone." /><Button label="Nettoyer les opérations fictives de ce téléphone" secondary disabled={saving || syncBusy || loading || journalLoading || commercialBusy} onPress={confirmClearPhone} /><Text style={styles.disclaimer}>Ventes, règlements et versions du journal en attente. Le journal nécessite une référence v3 et un serveur compatible ; les anciennes ventes restent locales.</Text><Text style={styles.muted}>{outbox.length} vente(s) ou règlement(s) et {journalOutbox.length} version(s) de journal en attente</Text><Button label="Envoyer les opérations en attente" disabled={(!outbox.length && !journalOutbox.length) || storageError || loading || journalLoading || !!journalError} onPress={() => { setReferenceError(''); setScreen('syncSales'); }} />{outbox.some(x => x.lastError) && <Text style={styles.warning}>Dernière erreur : {outbox.find(x => x.lastError)?.lastError}</Text>}{!sales.length && !settlements.length && <Text style={styles.muted}>Aucune opération enregistrée.</Text>}{[
      ...sales.map(s => ({ key: `sale-${s.id}`, date: s.createdAt, type: 'sale' as const, sale: s })),
      ...originalSales.filter(s => s.paid > 0).map(s => ({ key: `payment-${s.id}`, date: s.createdAt, type: 'initial' as const, sale: s })),
      ...settlements.map(p => ({ key: `settlement-${p.id}`, date: p.createdAt, type: 'settlement' as const, payment: p })),
    ].sort((a, b) => b.date.localeCompare(a.date)).map(item => item.type === 'settlement' ? <View key={item.key} style={styles.card}><Text style={styles.cardTitle}>Règlement de dette · {item.payment.clientName}</Text><Text style={styles.muted}>{new Date(item.date).toLocaleString('fr-FR')} · {item.payment.mode}</Text><Text style={styles.price}>{money(item.payment.amount)}</Text>{item.payment.mode === 'Chèque' && <Text style={styles.muted}>Chèque {item.payment.chequeNumber} · {item.payment.chequeBank} · échéance {item.payment.chequeDue}</Text>}</View> : item.type === 'initial' ? <View key={item.key} style={styles.card}><Text style={styles.cardTitle}>Paiement à la vente · {item.sale.clientName}</Text><Text style={styles.muted}>{new Date(item.date).toLocaleString('fr-FR')} · {item.sale.paymentMode} · vente démo #{item.sale.id}</Text><Text style={styles.price}>{money(item.sale.paid)}</Text>{item.sale.paymentMode === 'Chèque' && <Text style={styles.muted}>Chèque {item.sale.chequeNumber} · {item.sale.chequeBank} · échéance {item.sale.chequeDue}</Text>}</View> : <TouchableOpacity key={item.key} accessibilityRole="button" style={styles.card} onPress={() => { void openSale(item.sale); }}><Text style={styles.cardTitle}>Vente · {item.sale.clientName}</Text><Text style={styles.muted}>{new Date(item.date).toLocaleString('fr-FR')} · Démo #{item.sale.id} · total actuel</Text><View style={styles.row}><Text style={styles.price}>{money(item.sale.total)}</Text><Text style={styles.muted}>{item.sale.syncSaleId ? (outbox.some(o => o.saleId === item.sale.syncSaleId) ? 'En attente' : 'Envoyée') : 'Locale seulement'}</Text><Text style={styles.chevron}>›</Text></View></TouchableOpacity>)}<Button label="Retour aux clients" secondary onPress={() => setScreen('clients')} /></>}
    {screen === 'detail' && selectedSale && <><Header onBack={headerBack} title={`Vente démo #${selectedSale.id}`} detail={selectedSale.clientName} /><View style={styles.card}>{selectedSale.lines.map((l, i) => <View key={i}><Row label={`${l.quantity} × ${l.name}`} value={`${l.discount / 100} % remise`} /><Text style={styles.muted}>{l.code} · {money(l.unitPrice)} HT · TVA {l.vat / 100} %</Text></View>)}</View><View style={styles.totalCard}><Row label="Total TTC" value={money(selectedSale.total)} strong /><Row label="Encaissé" value={money(selectedSale.paid)} /><Row label="Reste à payer" value={money(Math.max(0, selectedSale.total - selectedSale.paid))} />{selectedSale.paid > selectedSale.total && <Row label="Crédit en faveur du client" value={money(selectedSale.paid - selectedSale.total)} />}<Row label="Mode" value={selectedSale.paymentMode} />{selectedSale.paymentMode === 'Chèque' && <><Row label="Numéro" value={selectedSale.chequeNumber} /><Row label="Banque" value={selectedSale.chequeBank} /><Row label="Échéance" value={selectedSale.chequeDue} /></>}</View><Text style={styles.disclaimer}>Démonstration locale : le règlement global du client n’est pas imputé à cette vente. Cette vente n’a pas été envoyée au serveur.</Text><Button label="Modifier la vente" onPress={beginEdit} disabled={loading || storageError} /><Text style={styles.section}>HISTORIQUE DES MODIFICATIONS</Text>{revisionError && <Text style={styles.warning}>Impossible de charger l’historique des modifications.</Text>}{!revisionError && !revisions.length && <Text style={styles.muted}>Aucune modification enregistrée.</Text>}{revisions.map(r => <View key={r.id} style={styles.card}><Text style={styles.cardTitle}>{new Date(r.createdAt).toLocaleString('fr-FR')}</Text><Row label="Ancien total" value={money(r.previous.total)} /><Row label="Nouveau total" value={money(r.current.total)} />{r.refund > 0 && <Row label="Remboursement" value={money(r.refund)} />}</View>)}<Button label="Retour à l’historique" secondary onPress={() => setScreen('history')} /></>}
    {screen === 'edit' && selectedSale && <><Header onBack={headerBack} title="Modifier la vente" detail={`Démo #${selectedSale.id} · ${selectedSale.clientName}`} /><Text style={styles.disclaimer}>Modifiez les quantités ou les remises. Le paiement déjà enregistré est conservé.</Text>{editLines.map((l, index) => <View key={`${l.code}-${index}`} style={styles.card}><Text style={styles.cardTitle}>{l.name}</Text><Text style={styles.muted}>{money(l.unitPrice)} HT / unité</Text><View style={styles.row}><View style={styles.quantity}><TouchableOpacity accessibilityLabel={`Réduire ${l.name}`} onPress={() => l.quantity > 1 ? modifyLine(index, {quantity: l.quantity - 1}) : setEditLines(lines => lines.filter((_, i) => i !== index))}><Text style={styles.quantityButton}>−</Text></TouchableOpacity><Text style={styles.quantityNumber}>{l.quantity}</Text><TouchableOpacity accessibilityLabel={`Augmenter ${l.name}`} onPress={() => modifyLine(index, {quantity: l.quantity + 1})}><Text style={styles.quantityButton}>+</Text></TouchableOpacity></View><TouchableOpacity onPress={() => setEditLines(lines => lines.filter((_, i) => i !== index))}><Text style={styles.remove}>Supprimer</Text></TouchableOpacity></View><Text style={styles.muted}>Remise : {l.discount / 100} %</Text><View style={styles.discountRow}>{[0, 5, 10, 20].map(percent => <TouchableOpacity key={percent} accessibilityRole="button" onPress={() => modifyLine(index, {discount: percent * 100})} style={[styles.chip, l.discount === percent * 100 && styles.chipActive]}><Text style={l.discount === percent * 100 ? styles.chipActiveText : styles.chipText}>{percent} %</Text></TouchableOpacity>)}</View></View>)}
      <Text style={styles.section}>AJOUTER UN ARTICLE</Text>{(selectedSale && /^[0-9a-f-]{36}$/i.test(selectedSale.clientId) ? referenceProducts : []).map(p => <View key={p.id} style={styles.row}><Text style={styles.rowLabel}>{p.name}</Text><Button label="+ Ajouter" secondary onPress={() => setEditLines(lines => [...lines, { name: p.name, code: p.code, quantity: 1, unitPrice: p.price, discount: 0, vat: p.vat }])} /></View>)}
      {editTotals && <View style={styles.totalCard}><Row label="Nouveau total TTC" value={money(editTotals.total)} strong /><Row label="Paiement conservé" value={money(selectedSale.paid)} /></View>}<Button label="Vérifier les modifications" disabled={!editTotals} onPress={() => { setDisposition(null); setScreen('editConfirm'); }} /><Button label="Annuler" secondary onPress={() => setScreen('detail')} /></>}
    {screen === 'editConfirm' && selectedSale && editTotals && <><Header onBack={headerBack} title="Confirmer la modification" detail={selectedSale.clientName} /><View style={styles.totalCard}><Row label="Ancien total" value={money(selectedSale.total)} /><Row label="Nouveau total" value={money(editTotals.total)} strong /><Row label="Paiement déjà enregistré" value={money(selectedSale.paid)} /></View>{selectedSale.paid > editTotals.total ? <><Text style={styles.warning}>Trop-perçu : {money(selectedSale.paid - editTotals.total)}. Choisissez une option :</Text><Button label="Retourner l’argent au client" secondary={disposition !== 'refund'} onPress={() => setDisposition('refund')} /><Button label="Garder en crédit client" secondary={disposition !== 'credit'} onPress={() => setDisposition('credit')} /><Text style={styles.hint}>Le remboursement est enregistré comme effectué lors de la validation.</Text></> : <Text style={styles.muted}>Nouveau reste à payer : {money(editTotals.total - selectedSale.paid)}</Text>}<Button label={saving ? 'Enregistrement…' : 'Enregistrer la modification'} disabled={saving || (selectedSale.paid > editTotals.total && !disposition)} onPress={() => { void commitEdit(); }} /><Button label="Retour à la modification" secondary onPress={() => setScreen('edit')} /></>}
    <Text style={styles.footer}>SLS MOBILE · VERSION DE DÉMONSTRATION</Text>
  </ScrollView></SafeAreaView>;
}
// Design local fourni : fond papier, vert émeraude, ambre et corail.
const C = {
  paper: '#F6F2E9', card: '#FFFFFF', ink: '#0B3F38', inkSoft: '#1E4A43', muted: '#66756F', line: '#E9E3D3',
  primary: '#0E8A6D', primaryDark: '#0A5A49', mint: '#D9F3E8', amber: '#FFB020', amberSoft: '#FFF1CF', amberInk: '#7A4E0B',
  coral: '#FF6B4A', coralSoft: '#FFE6DE', coralInk: '#A8301A', sky: '#E3F0FF',
};
const shadow = { shadowColor: '#0B3F38', shadowOpacity: 0.1, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 3 } as const;
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.paper },
  content: { padding: 16, paddingTop: 20, paddingBottom: 64, maxWidth: 650, width: '100%', alignSelf: 'center' },
  header: { backgroundColor: C.ink, borderRadius: 28, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 24, marginTop: 8, marginBottom: 22, overflow: 'hidden', ...shadow, shadowOpacity: 0.25 },
  headerGlow: { position: 'absolute', right: -46, top: -56, width: 190, height: 190, borderRadius: 95, backgroundColor: C.amber, opacity: 0.32 },
  headerGlow2: { position: 'absolute', right: 46, bottom: -70, width: 130, height: 130, borderRadius: 65, backgroundColor: C.coral, opacity: 0.28 },
  headerGlow3: { position: 'absolute', left: -30, bottom: -40, width: 110, height: 110, borderRadius: 55, backgroundColor: C.primary, opacity: 0.5 },
  headerTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brandRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  brandDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.amber, marginRight: 8 },
  brand: { color: '#FFFFFF', fontSize: 10.5, letterSpacing: 1.6, fontWeight: '800' },
  backBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 999, paddingLeft: 10, paddingRight: 16, height: 40 },
  backIcon: { color: '#FFFFFF', fontSize: 30, lineHeight: 32, fontWeight: '600', marginRight: 6, marginTop: -3 },
  backText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800', letterSpacing: 0.3 },
  iconBadge: { width: 44, height: 44, borderRadius: 15, backgroundColor: C.amber, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '6deg' }] },
  iconEmoji: { fontSize: 22 },
  title: { fontSize: 30, fontWeight: '800', color: '#FFFFFF', marginTop: 18, letterSpacing: -0.7 },
  subtitle: { color: '#BFE3D8', fontSize: 15, marginTop: 7, lineHeight: 22 },
  demo: { backgroundColor: C.amberSoft, borderRadius: 14, padding: 12, marginBottom: 2, borderLeftWidth: 5, borderLeftColor: C.amber },
  demoText: { color: C.amberInk, fontSize: 12, fontWeight: '700' },
  disclaimer: { color: C.amberInk, backgroundColor: C.amberSoft, borderRadius: 16, borderLeftWidth: 5, borderLeftColor: C.amber, paddingVertical: 13, paddingHorizontal: 15, lineHeight: 20, fontSize: 13.5, marginBottom: 8 },
  warning: { color: C.coralInk, backgroundColor: C.coralSoft, borderRadius: 12, overflow: 'hidden', paddingVertical: 9, paddingHorizontal: 12, fontSize: 12.5, fontWeight: '700', marginTop: 10, lineHeight: 18 },
  success: { color: C.primaryDark, backgroundColor: C.mint, borderRadius: 12, overflow: 'hidden', paddingVertical: 9, paddingHorizontal: 12, fontSize: 13.5, fontWeight: '700', marginTop: 12 },
  hint: { color: C.muted, fontSize: 12, marginTop: 8, lineHeight: 17 },
  section: { color: C.inkSoft, fontWeight: '800', fontSize: 11.5, letterSpacing: 1.6, marginTop: 26, marginBottom: 12, borderLeftWidth: 4, borderLeftColor: C.amber, paddingLeft: 10 },
  search: { borderWidth: 2, borderColor: C.line, backgroundColor: C.card, borderRadius: 16, paddingHorizontal: 16, height: 56, color: C.ink, fontSize: 16, fontWeight: '600' },
  inputGap: { marginTop: 10 },
  card: { backgroundColor: C.card, borderRadius: 22, padding: 18, marginBottom: 12, borderWidth: 1, borderColor: C.line, borderTopWidth: 4, borderTopColor: C.primary, ...shadow },
  selectedCard: { borderColor: C.primary, borderWidth: 2, borderTopWidth: 4, borderTopColor: C.amber, backgroundColor: '#EEFAF4' },
  cardTitle: { fontSize: 16.5, fontWeight: '800', color: C.ink, letterSpacing: -0.2 },
  cardBottom: { marginTop: 14 },
  muted: { color: C.muted, fontSize: 13, marginTop: 6, lineHeight: 18 },
  price: { color: C.primaryDark, backgroundColor: C.mint, borderRadius: 10, overflow: 'hidden', paddingHorizontal: 11, paddingVertical: 5, fontWeight: '800', fontSize: 15, letterSpacing: -0.2 },
  chevron: { color: C.primary, fontSize: 30, fontWeight: '700' },
  journalHistoryEntry: { borderTopWidth: 1, borderTopColor: C.line, marginTop: 12, paddingTop: 12 },
  creditChoice: { marginTop: 16, alignSelf: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginVertical: 5 },
  flex: { flex: 1 },
  rowLabel: { color: C.muted, flexShrink: 1, fontSize: 14 },
  rowValue: { color: C.inkSoft, fontWeight: '800', fontSize: 14 },
  strong: { color: C.primaryDark, fontWeight: '800', fontSize: 20, marginTop: 6, letterSpacing: -0.3 },
  totalCard: { backgroundColor: C.mint, borderRadius: 22, padding: 18, marginTop: 8, marginBottom: 12, borderLeftWidth: 6, borderLeftColor: C.amber, borderBottomWidth: 3, borderBottomColor: C.primary },
  button: { backgroundColor: C.primary, borderRadius: 18, minHeight: 56, paddingVertical: 15, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', marginTop: 12, borderBottomWidth: 4, borderBottomColor: C.primaryDark, shadowColor: C.primary, shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 4 },
  buttonSecondary: { backgroundColor: C.mint, borderBottomColor: '#B5E2CF', shadowOpacity: 0, elevation: 0 },
  buttonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 15, letterSpacing: 0.2 },
  buttonSecondaryText: { color: C.primaryDark },
  disabled: { opacity: 0.4 },
  quantity: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.mint, borderRadius: 16 },
  quantityButton: { fontSize: 24, color: C.primaryDark, fontWeight: '800', paddingHorizontal: 16, paddingVertical: 5 },
  quantityNumber: { minWidth: 26, textAlign: 'center', fontWeight: '800', color: C.ink, fontSize: 17 },
  remove: { color: C.coralInk, backgroundColor: C.coralSoft, borderRadius: 10, overflow: 'hidden', paddingHorizontal: 12, paddingVertical: 7, fontWeight: '800' },
  discountRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  chip: { borderWidth: 2, borderColor: C.line, backgroundColor: C.card, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10 },
  chipActive: { backgroundColor: C.primary, borderColor: C.primary },
  chipText: { color: C.inkSoft, fontWeight: '700' },
  chipActiveText: { color: '#FFFFFF', fontWeight: '800' },
  footer: { color: '#A3A89E', textAlign: 'center', fontSize: 10, letterSpacing: 1.8, fontWeight: '700', marginTop: 38 },
});
