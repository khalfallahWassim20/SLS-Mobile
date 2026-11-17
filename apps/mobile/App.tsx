import {saleSyncStatus} from './sale-sync-status';
import { canQuickSettleJournal } from './journal-quick-settlement';
import { chronologicalOperations, operationDay, operationDayLabel, operationsOnTunisDay, revisionCreditAdded } from './client-timeline';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import { createSecureSessionStore, validSession } from './secure-commercial-session';
import {CreditMobileWorkspacePrototype} from './credit-mobile-workspace-prototype';
import {DayInvoiceWorkspace} from './day-invoice-workspace';
import {getDayInvoiceBinding,activateDayInvoiceForCommercial,synchronizeDayInvoiceStoragePrototype} from './storage';
import {fetchServerLineage} from './server-lineage-proof';
import {creditBridgeAvailable} from './credit-server-capabilities';
import {AddressRecoveryTest} from './address-recovery-test';
import {isCreditTransportBusy} from './credit-note-transport-prototype';
import {createExperimentalCreditMobileTransport,getCreditReferencePrototype,getCreditStartupState,getTourExpenses,getTourExpenseSnapshot,importTourExpenseSnapshot,getPendingTourExpenseOperations,hasTourExpenses,saveTourExpense,saveExpenseRevision,saveExpenseCancellation,confirmTourExpense,confirmExpenseRevision,confirmExpenseCancellation} from './storage';
import type {TourExpense,ExpenseRevision,ExpenseCancellation} from './tour-expenses';
import type {DeviceIdentity} from './identified-device';
const V5_TEST_ONLY=process.env.EXPO_PUBLIC_SLS_V5_TEST_ONLY==='DONNEES_FICTIVES_ISOLEES';
const V5_BRIDGE_TEST_ONLY=process.env.EXPO_PUBLIC_SLS_V5_BRIDGE_TEST_ONLY==='DONNEES_FICTIVES_ISOLEES';
const ADDRESS_TEST_ONLY=process.env.EXPO_PUBLIC_SLS_ADDRESS_TEST_ONLY==='DONNEES_FICTIVES_ISOLEES';
import { journalCsv, journalHtml } from './journal-export';
import { saleInvoiceHtml } from './sale-invoice-pdf';
import {indexSearch,searchIndexed,firstPage} from './paged-search';
import React, { Children, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, BackHandler, Keyboard, SafeAreaView, ScrollView, StatusBar, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { calculateInvoice, calculatePayment, reconcileClientBalance, balanceAfterSettlement, isSaleBlocked, parseDinars, revisePayment, reconcileJournalBalance, summarizePreInvoice, validatePreInvoiceReceipt } from '@sls/domain';
import { getAllPreInvoices, getTourReceipts, saveTourReceipt, getJournalOutbox, acknowledgeJournalOutbox, JournalOutboxEntry, TourJournalReceipt, savePreInvoice, TourPreInvoice, getReference, saveReference, getOutbox, acknowledgeOutbox, failOutbox, OutboxEntry, getSales, saveSale, updateSale, getRevisions, getClientRevisions, getOriginalSales, getSettlements, saveSettlement, SavedSale, Revision, Settlement } from './storage';
import { validateReference, preInvoiceAvailability, hasJournalDayConflict, formatMillimes, unitPriceExcludingVat, ReferenceData, RefClient } from './reference';
import { tunisDay, buildJournal, journalTotal, summarizeLocalDayInvoice } from './journal';
import { JournalHome, JournalDrawer, type DrawerItem } from './journal-home';
import { journalVisualStatus } from './journal-overview';
import { uploadJournalQueue } from './journal-upload';
import { isIdentifiedDeviceBound } from './storage';
import { openBoundCommercialSession, type CommercialSession } from './commercial-login';
import { clearLocalTestOperations,bindAndCacheIdentified,getBoundIdentity,recordCreditProtocolUpgrade,getIdentifiedOutbox,acknowledgeIdentifiedEntry,observeIdentifiedTour,getLocalCloseAttempt,prepareLocalClose,acknowledgeLocalClose } from './storage';
import { uploadTourExpenses } from './tour-expense-upload';
import { uploadDemoQueue } from './demo-upload';
import { uploadIdentifiedOperations, ClosedDaySyncError } from './identified-upload';
import { sendPreparedTourClose } from './tour-close-queue';
import { validateIdentifiedReference } from './identified-reference';

// Données de démonstration uniquement. Aucun prix ou client réel n'est enregistré.
type Client = { id: string; name: string; sector: string; balance: number; limit: number };
type Product = { id: string; name: string; code: string; price: number; vat: number; saleTtc?: number };
type CartLine = { product: Product; quantity: number; discount: number };
type Screen = 'clients' | 'products' | 'cart' | 'summary' | 'payment' | 'history' | 'detail' | 'edit' | 'editConfirm' | 'clientBalance' | 'settlement' | 'reference' | 'sync' | 'syncSales' | 'journal' | 'journalAdd' | 'journalDetail' | 'journalPayment' | 'commercialLogin' | 'expenses';
const money = (amount: number) => `${(amount / 1000).toFixed(3)} DT`;
const normalize = (s: string) => s.trim().toLocaleLowerCase();
const PAGE_SIZE=40;
/** Maintient une recherche complète et ne monte qu'une page de cartes à la fois. */
function usePagedItems<T>(items:T[],scope:string){
 const [state,setState]=useState({scope:'',limit:PAGE_SIZE});
 const limit=state.scope===scope?state.limit:PAGE_SIZE;
 const page=firstPage(items,limit);
 return {...page,more:()=>setState({scope,limit:Math.min(items.length,limit+PAGE_SIZE)})};
}
const secureSessions=createSecureSessionStore(SecureStore);

function Button({ label, onPress, secondary = false, disabled = false, compact = false }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean; compact?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" activeOpacity={0.85} disabled={disabled} onPress={onPress} style={[styles.button, secondary && styles.buttonSecondary, compact && styles.buttonCompact, disabled && styles.disabled]}><Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{label}</Text></TouchableOpacity>;
}
type HeaderStat = { label: string; value: string };
function Header({ title, detail, onBack, stats, progress, action }: { title: string; detail?: string; onBack?: () => void; stats?: HeaderStat[]; progress?: { step: number; total: number; label: string }; action?: { label: string; icon: string; badge?: number; onPress: () => void; disabled?: boolean } }) {
  return <View style={hd.card}>
    <View style={hd.row}>
      {onBack ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="Retour à l’écran précédent" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} onPress={onBack} style={hd.back}><Text style={hd.backIcon}>‹</Text></TouchableOpacity> : null}
      <View style={hd.flex}><Text accessibilityRole="header" style={hd.title}>{title}</Text>{detail ? <Text style={hd.detail}>{detail}</Text> : null}</View>
      {action ? <TouchableOpacity accessibilityRole="button" accessibilityLabel={action.label} accessibilityState={{disabled:!!action.disabled}} disabled={action.disabled} onPress={action.onPress} style={[hd.action, action.disabled && hd.off]}>{action.icon === 'cart' ? <View style={hd.cartIcon}><View style={hd.cartHandle}/><View style={hd.cartBasket}/><View style={hd.cartWheels}><View style={hd.cartWheel}/><View style={hd.cartWheel}/></View></View> : <Text style={hd.actionText}>{action.icon}</Text>}{action.badge !== undefined && action.badge > 0 ? <View style={hd.badge}><Text style={hd.badgeText}>{action.badge}</Text></View> : null}</TouchableOpacity> : null}
    </View>
    {progress ? <><View style={hd.steps}>{Array.from({ length: progress.total }, (_, i) => <View key={i} style={[hd.step, i < progress.step && hd.stepOn]} />)}</View><Text style={hd.stepLabel}>Étape {progress.step} sur {progress.total} · {progress.label}</Text></> : null}
    {stats && stats.length ? <View style={hd.stats}>{stats.map(st => <View key={st.label} style={hd.stat}><Text style={hd.statLabel}>{st.label}</Text><Text style={hd.statValue}>{st.value}</Text></View>)}</View> : null}
  </View>;
}
const hd = StyleSheet.create({
  card: { backgroundColor: '#0F1B3D', borderRadius: 28, padding: 16, marginTop: 8, marginBottom: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, flex: { flex: 1 }, off: { opacity: 0.45 },
  back: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  backIcon: { color: '#FFFFFF', fontSize: 30, lineHeight: 34, fontWeight: '600', marginTop: -3 },
  title: { color: '#FFFFFF', fontSize: 22, fontWeight: '800', letterSpacing: -0.3 }, detail: { color: '#A3AECB', fontSize: 12.5, marginTop: 2 },
  action: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#2DD4BF', alignItems: 'center', justifyContent: 'center' }, actionText: { color: '#0F1B3D', fontSize: 25, fontWeight: '800' },
  badge: { position:'absolute', top:-5, right:-5, minWidth:21, height:21, paddingHorizontal:4, borderRadius:11, backgroundColor:'#FFFFFF', alignItems:'center', justifyContent:'center' }, badgeText: { color:'#0F1B3D', fontSize:11, fontWeight:'800' },
  cartIcon: { width:26, height:25, position:'relative' }, cartHandle: { position:'absolute', left:0, top:2, width:7, height:3, backgroundColor:'#0F1B3D', borderRadius:2 },
  cartBasket: { position:'absolute', left:5, top:5, width:19, height:12, borderWidth:2, borderColor:'#0F1B3D', borderRadius:3 },
  cartWheels: { position:'absolute', left:8, top:19, width:15, flexDirection:'row', justifyContent:'space-between' }, cartWheel: { width:4, height:4, borderRadius:2, backgroundColor:'#0F1B3D' },
  steps: { flexDirection: 'row', gap: 6, marginTop: 16 }, step: { flex: 1, height: 6, borderRadius: 3, backgroundColor: '#2A3560' }, stepOn: { backgroundColor: '#2DD4BF' },
  stepLabel: { color: '#A3AECB', fontSize: 12.5, fontWeight: '600', marginTop: 8 },
  stats: { flexDirection: 'row', gap: 8, marginTop: 14 }, stat: { flex: 1, backgroundColor: '#1B2A57', borderRadius: 18, paddingVertical: 10, paddingHorizontal: 14 },
  statLabel: { color: '#A3AECB', fontSize: 11.5, fontWeight: '600' }, statValue: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' },
});
function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <View style={styles.row}><Text style={[styles.rowLabel, strong && styles.strong]}>{label}</Text><Text style={[styles.rowValue, strong && styles.strong]}>{value}</Text></View>;
}
// ---- Composants de navigation et de listes (présentation uniquement) ----
type BarAction = { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean };
/** Barre d'action fixe : un seul bouton principal, toujours visible sans défiler. */
function ActionBar({ actions, info }: { actions: BarAction[]; info?: string }) {
  return <View style={styles.bar}>{info ? <Text style={styles.barInfo}>{info}</Text> : null}<View style={styles.barRow}>{actions.map(a => <View key={a.label} style={styles.barCell}><Button compact label={a.label} secondary={a.secondary} disabled={a.disabled} onPress={a.onPress} /></View>)}</View></View>;
}
/** Ligne de liste (remplace un gros bouton) : icône, texte, pastille et flèche. */
function MenuRow({ icon, label, hint, onPress, disabled = false, danger = false, badge }: { icon: string; label: string; hint?: string; onPress: () => void; disabled?: boolean; danger?: boolean; badge?: number }) {
  return <TouchableOpacity accessibilityRole="button" activeOpacity={0.7} disabled={disabled} onPress={onPress} style={[styles.menuRow, disabled && styles.disabled]}><View style={[styles.menuIcon, danger && styles.menuIconDanger]}><Text style={styles.menuIconText}>{icon}</Text></View><View style={styles.flex}><Text style={[styles.menuLabel, danger && styles.menuLabelDanger]}>{label}</Text>{hint ? <Text style={styles.menuHint}>{hint}</Text> : null}</View>{badge ? <View style={styles.badge}><Text style={styles.badgeText}>{badge}</Text></View> : null}<Text style={styles.chevron}>›</Text></TouchableOpacity>;
}
function MenuList({ children }: { children?: React.ReactNode }) {
  const items = Children.toArray(children).filter(Boolean);
  return <View style={styles.menu}>{items.map((item, index) => <View key={index} style={index > 0 ? styles.menuSep : undefined}>{item}</View>)}</View>;
}
/** Petit bouton « pastille » pour les actions secondaires dans une carte. */
function MiniButton({ label, onPress, disabled = false, primary = false }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" activeOpacity={0.8} disabled={disabled} onPress={onPress} style={[styles.mini, primary && styles.miniPrimary, disabled && styles.disabled]}><Text style={[styles.miniText, primary && styles.miniTextPrimary]}>{label}</Text></TouchableOpacity>;
}
function Segmented<T extends string>({ options, value, onChange }: { options: { key: T; label: string }[]; value: T; onChange: (key: T) => void }) {
  return <View style={styles.segmented}>{options.map(o => <TouchableOpacity key={o.key} accessibilityRole="button" accessibilityState={{ selected: value === o.key }} onPress={() => onChange(o.key)} style={[styles.seg, value === o.key && styles.segActive]}><Text style={[styles.segText, value === o.key && styles.segTextActive]}>{o.label}</Text></TouchableOpacity>)}</View>;
}
function ChoiceRow({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return <TouchableOpacity accessibilityRole="radio" accessibilityState={{ selected }} activeOpacity={0.8} onPress={onPress} style={[styles.choice, selected && styles.choiceActive]}><View style={[styles.radio, selected && styles.radioActive]}>{selected ? <View style={styles.radioDot} /> : null}</View><Text style={[styles.choiceText, selected && styles.choiceTextActive]}>{label}</Text></TouchableOpacity>;
}
function RoundButton({ label, onPress, accessibilityLabel }: { label: string; onPress: () => void; accessibilityLabel: string }) {
  return <TouchableOpacity accessibilityRole="button" accessibilityLabel={accessibilityLabel} activeOpacity={0.8} onPress={onPress} style={styles.round}><Text style={styles.roundText}>{label}</Text></TouchableOpacity>;
}
function LinkButton({ label, onPress, danger = false }: { label: string; onPress: () => void; danger?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" activeOpacity={0.6} onPress={onPress} style={styles.link}><Text style={[styles.linkText, danger && styles.linkDanger]}>{label}</Text></TouchableOpacity>;
}
function Fab({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" activeOpacity={0.85} disabled={disabled} onPress={onPress} style={[styles.fab, disabled && styles.disabled]}><Text style={styles.fabText}>{label}</Text></TouchableOpacity>;
}
const MODE_ICON: Record<string, string> = { 'Espèces': '💵', 'Chèque': '🏦', 'Virement': '🔁' };
/** Titre d'étape numérotée. */
function StepTitle({ n, label }: { n: number; label: string }) {
  return <View style={styles.step}><View style={styles.stepNum}><Text style={styles.stepNumText}>{n}</Text></View><Text style={styles.stepLabel}>{label}</Text></View>;
}
/** Pastille ronde avec les initiales du client. */
function Avatar({ name, active = false }: { name: string; active?: boolean }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?';
  return <View style={[styles.avatar, active && styles.avatarActive]}><Text style={[styles.avatarText, active && styles.avatarTextActive]}>{initials}</Text></View>;
}
function ProgressBar({ percent }: { percent: number }) {
  return <View style={styles.progress}><View style={[styles.progressFill, { width: `${Math.max(0, Math.min(100, percent))}%` }]} /></View>;
}
function StatTile({ label, value, amber = false }: { label: string; value: string; amber?: boolean }) {
  return <View style={[styles.stat, amber && styles.statAmber]}><Text style={styles.statLabel}>{label}</Text><Text style={styles.statValue}>{value}</Text></View>;
}
function Pill({ label, tone = 'mint' }: { label: string; tone?: 'mint' | 'amber' | 'coral' }) {
  return <Text style={[styles.pill, tone === 'amber' && styles.pillAmber, tone === 'coral' && styles.pillCoral]}>{label}</Text>;
}
const TAB_SCREENS: Screen[] = ['journal', 'reference', 'history', 'clients'];
const TABS: { key: Screen; icon: string; label: string }[] = [{ key: 'journal', icon: '📒', label: 'Journal' }, { key: 'reference', icon: '👥', label: 'Clients' }, { key: 'history', icon: '🕘', label: 'Historique' }, { key: 'clients', icon: '⚙️', label: 'Plus' }];
function TabBar({ current, onSelect, badges }: { current: Screen; onSelect: (screen: Screen) => void; badges?: Partial<Record<Screen, number>> }) {
  return <View style={styles.tabbar}>{TABS.map(t => <TouchableOpacity key={t.key} accessibilityRole="tab" accessibilityState={{ selected: current === t.key }} activeOpacity={0.7} onPress={() => onSelect(t.key)} style={[styles.tab, current === t.key && styles.tabActive]}><Text style={styles.tabIcon}>{t.icon}</Text><Text style={[styles.tabLabel, current === t.key && styles.tabLabelActive]}>{t.label}</Text>{badges?.[t.key] ? <View style={styles.tabBadge}><Text style={styles.badgeText}>{badges[t.key]}</Text></View> : null}</TouchableOpacity>)}</View>;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('journal');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [referenceNoticeVisible, setReferenceNoticeVisible] = useState(true);
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
    try {const result=await openBoundCommercialSession(serverUrl,commercialLogin,password,fetch,getBoundIdentity);setCommercialResult(result.name);}
    catch(error){setCommercialError(error instanceof Error?error.message:'Connexion impossible.');}
    finally {commercialBusyRef.current=false;setCommercialBusy(false);}
  };
  const [syncBusy, setSyncBusy] = useState(false);
  const [individual,setIndividual]=useState<CommercialSession|null>(null);
  const liveIndividual=useRef<CommercialSession|null>(null);liveIndividual.current=individual;
  const [sessionNotice,setSessionNotice]=useState('');
  const [boundCommercial,setBoundCommercial]=useState(false);
  const [v5Identity,setV5Identity]=useState<DeviceIdentity|null>(null);
  const [expenses,setExpenses]=useState<TourExpense[]>([]);
  const [expenseHistory,setExpenseHistory]=useState<ExpenseRevision[]>([]);
  const [expenseCancellations,setExpenseCancellations]=useState<ExpenseCancellation[]>([]);
  const [expenseCancelling,setExpenseCancelling]=useState<TourExpense|null>(null);
  const [expenseCancelReason,setExpenseCancelReason]=useState('');
  const [expenseDescription,setExpenseDescription]=useState(''),[expenseAmount,setExpenseAmount]=useState('');
  const [expenseError,setExpenseError]=useState(''),[expenseBusy,setExpenseBusy]=useState(false);
  const [expenseLoadedFor,setExpenseLoadedFor]=useState('');
  const [expenseEditing,setExpenseEditing]=useState<TourExpense|null>(null);
  const [showOlderExpenses,setShowOlderExpenses]=useState(false);
  const [expenseRefreshDay,setExpenseRefreshDay]=useState(()=>tunisDay(new Date()));
  const [v5Login,setV5Login]=useState(false);
  const [v5Ready,setV5Ready]=useState(false);
  const [dayBinding,setDayBinding]=useState<Awaited<ReturnType<typeof getDayInvoiceBinding>>>(null);
  const [dayLogin,setDayLogin]=useState(false);
  const [dayActivating,setDayActivating]=useState(false);
  const [v5BridgeBusy,setV5BridgeBusy]=useState(false);
  const [v5BridgeBlocked,setV5BridgeBlocked]=useState(false);
  const [v5UpgradeRequired,setV5UpgradeRequired]=useState(false);
  // Ne jamais afficher les anciens écrans avant de savoir si la transition
  // irréversible a déjà été enregistrée sur ce téléphone.
  const [v5StartupChecking,setV5StartupChecking]=useState(true);
  const [v5ServerAvailable,setV5ServerAvailable]=useState(false);
  const v5Mode=V5_TEST_ONLY||v5Ready;
  const [addressRecovery,setAddressRecovery]=useState(false);
  const startAddressRecovery=async()=>{
    if(commercialBusyRef.current)return;
    if(isCreditTransportBusy()||syncRef.current||savingRef.current||(!V5_TEST_ONLY&&(loading||journalLoading))){setCommercialError('Une opération ou actualisation est en cours. Attendez sa fin.');return;}
    commercialBusyRef.current=true;setCommercialBusy(true);setCommercialError('');
    try{await secureSessions.clear();setIndividual(null);setAddressRecovery(true);}
    catch{setCommercialError('Impossible de fermer la session : essai annulé.');}
    finally{commercialBusyRef.current=false;setCommercialBusy(false);}
  };
  const [closureLabel,setClosureLabel]=useState('');
  useEffect(()=>{
    let alive=true;commercialBusyRef.current=true;setCommercialBusy(true);
    void (async()=>{
      try {
        const {identity,ready,quarantined}=await getCreditStartupState(true);
        const binding=await getDayInvoiceBinding();
        if(binding&&(ready||quarantined))throw Error('Protocoles incompatibles sur ce téléphone.');
        if(!alive)return;setDayBinding(binding);setBoundCommercial(!!identity);setV5Identity(identity);if(identity)setServerUrl(identity.serverOrigin);
        setV5UpgradeRequired(quarantined);setV5Ready(ready);setV5StartupChecking(false);
        try {
          const session=await secureSessions.restore(identity);
          if(alive && session){setServerUrl(session.serverOrigin);setIndividual(session);setClosureLabel('État serveur à actualiser');setSessionNotice('Session restaurée sur ce téléphone. Sa validité serveur sera vérifiée lors du prochain échange.');}
        } catch {if(alive)setSessionNotice('Restauration de session impossible : reconnectez-vous en ligne.');}
      } catch {
        if(alive){
          setV5BridgeBlocked(true);
        }
      }
      finally{commercialBusyRef.current=false;if(alive){setV5StartupChecking(false);setCommercialBusy(false);}}
    })();
    return ()=>{alive=false;};
  },[]);
  useEffect(()=>{
    let alive=true;setV5ServerAvailable(false);
    if(individual)void creditBridgeAvailable(individual,fetch).then(available=>{if(alive)setV5ServerAvailable(available);});
    return ()=>{alive=false;};
  },[individual]);
  useEffect(()=>{
    if(!individual)return;
    const expire=()=>{if(Date.now()>=Date.parse(individual.expiresAt)){
      setIndividual(current=>current?.token===individual.token?null:current);
      setClosureLabel('');setSessionNotice('Session expirée : continuez hors ligne et reconnectez-vous pour synchroniser.');
      void secureSessions.clearIfToken(individual.token).catch(()=>{});
    }};
    const timer=setTimeout(expire,Math.max(0,Date.parse(individual.expiresAt)-Date.now()));
    const sub=AppState.addEventListener('change',state=>{if(state==='active')expire();});
    expire();return ()=>{clearTimeout(timer);sub.remove();};
  },[individual]);
  const invalidateIndividual=(session:CommercialSession)=>{
    setIndividual(current=>current?.token===session.token?null:current);
    setSessionNotice('Session refusée ou expirée : reconnectez-vous pour synchroniser.');
    void secureSessions.clearIfToken(session.token).catch(()=>{});
  };
  const checkProtocolUpgrade=async(session:CommercialSession,response:Response)=>{
    if(response.status!==409)return;
    const body=await response.clone().json().catch(()=>null);
    if(body?.code!=='CREDIT_PROTOCOL_UPGRADE_REQUIRED')return;
    // Masquer immédiatement même si SQLite ne peut pas enregistrer le blocage.
    setReference(null);setSales([]);setOriginalSales([]);setSettlements([]);setPreInvoices([]);setTourReceipts([]);
    setSelectedSale(null);setBalanceClient(null);setClient(null);setCart([]);setJournalClientId(null);
    setStorageError(true);setReferenceError('Mise à jour et rapprochement v5 nécessaires. Les données restent sur ce téléphone.');
    setJournalError('Mise à jour et rapprochement v5 nécessaires. Les données restent sur ce téléphone.');
    if(await recordCreditProtocolUpgrade({commercialId:session.id,serverOrigin:session.serverOrigin},response.status,body))setV5UpgradeRequired(true);
  };
  const individualRequest=async(session:NonNullable<typeof individual>,path:string,body?:unknown)=> {
    const response=await fetch(`${session.serverOrigin}/api/mobile/identified/${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${session.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(response.status===401)invalidateIndividual(session);await checkProtocolUpgrade(session,response);return response;
  };
  const readIndividual=async(session:NonNullable<typeof individual>,path:string)=>{
    const response=await individualRequest(session,path),data=await response.json().catch(()=>null);
    if(!response.ok)throw Error(data?.error||`Erreur serveur (${response.status}).`);return data;
  };
  const refreshIndividual=async(session:NonNullable<typeof individual>)=>{
    const value=validateIdentifiedReference(await readIndividual(session,'reference'));
    const identity={commercialId:session.id,serverOrigin:session.serverOrigin};
    await bindAndCacheIdentified(identity,value);
    setReference({...value,version:3,syncedAt:new Date().toISOString()});setBoundCommercial(true);setV5Identity(identity);
  };
  const connectIndividual=async()=>{
    if(commercialBusyRef.current)return;commercialBusyRef.current=true;setCommercialBusy(true);setCommercialError('');
    if(v5Mode)setV5Login(true);
    const password=commercialPassword;setCommercialPassword('');
    try {const session=await openBoundCommercialSession(serverUrl,commercialLogin,password,fetch,getBoundIdentity);
      if(!validSession(session,{commercialId:session.id,serverOrigin:session.serverOrigin}))throw Error('Vérifiez la date et l’heure du téléphone : session expirée ou invalide.');
      const identity={commercialId:session.id,serverOrigin:session.serverOrigin};
      let state:{status:string};
      if(dayBinding){
        const pin=await fetchServerLineage(session,fetch,true);
        if(pin.commercialId!==dayBinding.pin.commercialId||pin.serverOrigin!==dayBinding.pin.serverOrigin||pin.lineageId!==dayBinding.pin.lineageId)throw Error('Lignée serveur différente : aucune opération envoyée.');
        setV5Identity(identity);setBoundCommercial(true);state={status:'unknown'};setDayLogin(false);
      }else if(v5Mode){
        const transport=createExperimentalCreditMobileTransport(session,identity,()=>invalidateIndividual(session));
        await transport.connect();setV5Identity(identity);setV5Ready(true);setBoundCommercial(true);
        state=await transport.refreshDay(journalDate);
      }else{
        try{
          state=await readIndividual(session,`day/${journalDate}`);
          await refreshIndividual(session);await observeIdentifiedTour(identity,journalDate,state);
        }catch(error){
          // Un refus explicite a pu être reçu après un avoir d'un autre appareil.
          // Autoriser seulement la connexion au parcours de rapprochement, sans
          // réactiver les anciennes lectures ni envoyer les files en attente.
          const local=await getCreditStartupState(true);
          if(!local.quarantined||!local.identity||local.identity.commercialId!==identity.commercialId||local.identity.serverOrigin!==identity.serverOrigin||!await creditBridgeAvailable(session,fetch))throw error;
          setV5Identity(identity);setBoundCommercial(true);setV5UpgradeRequired(true);setV5ServerAvailable(true);state={status:'unknown'};
        }
      }
      if(!validSession(session,{commercialId:session.id,serverOrigin:session.serverOrigin}))throw Error('Session expirée : reconnectez-vous.');
      let notice='';try{await secureSessions.save(session);}catch{notice='Session active mais non sauvegardée : reconnectez-vous après fermeture de l’application.';}
      setSessionNotice(state.status==='unknown'&&!dayBinding?'Avoirs reçus depuis un autre appareil : effectuez le rapprochement avant toute opération. '+notice:notice);setClosureLabel(state.status==='closed'?'Journée clôturée':state.status==='open'?'Journée ouverte':'État à actualiser');setIndividual(session);setCommercialResult(session.name);setV5Login(false);setScreen('journal');
    } catch(error){setCommercialError(error instanceof Error?error.message:'Connexion impossible.');}
    finally{commercialBusyRef.current=false;setCommercialBusy(false);}
  };
  const activateDayInvoice=async()=>{
    const session=individual,identity=v5Identity;
    if(!session||!identity||dayBinding||v5Mode||commercialBusyRef.current||syncRef.current||savingRef.current||loading||journalLoading||storageError||journalError)return;
    if(!validSession(session,identity)){Alert.alert('Session indisponible','Reconnectez le commercial avant le passage.');return;}
    commercialBusyRef.current=true;syncRef.current=true;savingRef.current=true;setDayActivating(true);
    const current=()=>{const live=liveIndividual.current;return !!live&&live.token===session.token&&live.id===identity.commercialId&&live.serverOrigin===identity.serverOrigin&&live.expiresAt===session.expiresAt;};
    try{const binding=await activateDayInvoiceForCommercial(identity,session,current,()=>invalidateIndividual(session));setDayBinding(binding);setDrawerOpen(false);}
    catch(error){Alert.alert('Passage impossible',error instanceof Error?error.message:'Aucune donnée supprimée.');}
    finally{commercialBusyRef.current=false;syncRef.current=false;savingRef.current=false;setDayActivating(false);}
  };
  // Passage expérimental depuis l'interface v4 : réservé aux données fictives.
  // Un échec laisse les caches, opérations et l'ancien écran intacts.
  const activateV5Bridge=async()=>{
    const session=individual,identity=v5Identity;
    if((!V5_BRIDGE_TEST_ONLY&&!v5ServerAvailable)||V5_TEST_ONLY||!session||!identity||commercialBusyRef.current)return;
    if(isCreditTransportBusy()||syncRef.current||savingRef.current||loading||journalLoading||(storageError&&!v5UpgradeRequired)){Alert.alert('Passage indisponible','Attendez la fin des opérations et vérifiez les erreurs avant de réessayer.');return;}
    if(!validSession(session,identity)){Alert.alert('Session indisponible','Reconnectez le commercial lié.');return;}
    commercialBusyRef.current=true;syncRef.current=true;savingRef.current=true;setV5BridgeBusy(true);setCommercialError('');
    const stillCurrent=()=>{const live=liveIndividual.current;return !!live&&live.token===session.token&&live.id===session.id&&live.serverOrigin===session.serverOrigin&&live.expiresAt===session.expiresAt;};
    try{
      if(await hasTourExpenses(identity))throw Error('Le parcours expérimental ne prend pas encore en charge les dépenses : transition refusée, données conservées.');
      const transport=createExperimentalCreditMobileTransport(session,identity,()=>invalidateIndividual(session),stillCurrent);
      await transport.connect();
      setReference(null);setV5Ready(true);setV5Login(false);setSessionNotice('Espace avoirs activé pour cet essai fictif. Les opérations existantes ont été conservées.');
    }catch(error){
      // La session peut expirer après le commit SQLite mais avant le retour
      // du transport. Relire le cache : ne jamais annoncer un refus certain
      // ni réactiver les anciens écrans si la bascule a déjà été enregistrée.
      try{
        const committed=await getCreditReferencePrototype(identity);
        if(committed){setReference(null);setV5Ready(true);setV5Login(true);setSessionNotice('Passage enregistré mais réponse incertaine : reconnectez-vous. Aucune donnée n’a été effacée.');}
        else Alert.alert('Passage refusé',error instanceof Error?error.message:'Rapprochement impossible. Les données sont conservées.');
      }catch{setReference(null);setStorageError(true);setV5BridgeBlocked(true);}
    }
    finally{commercialBusyRef.current=false;syncRef.current=false;savingRef.current=false;setV5BridgeBusy(false);}
  };
  const updateIndividualDay=async(session:NonNullable<typeof individual>)=>{
    const state=await readIndividual(session,`day/${journalDate}`);
    await observeIdentifiedTour({commercialId:session.id,serverOrigin:session.serverOrigin},journalDate,state);
    setClosureLabel(state.status==='closed'?'Journée clôturée':'Journée ouverte');return state;
  };
  const refreshReferenceFromHeader=async()=>{
    if(syncRef.current||savingRef.current||commercialBusyRef.current)return;
    if(!boundCommercial){setReferenceError('');setScreen('sync');return;}
    if(!individual||!v5Identity||!validSession(individual,v5Identity)){
      setCommercialError('Connectez-vous au commercial lié pour actualiser les données.');setScreen('commercialLogin');return;
    }
    syncRef.current=true;setSyncBusy(true);setReferenceError('');
    try{await refreshIndividual(individual);Alert.alert('Données actualisées','Clients et articles reçus. Les opérations en attente ne sont pas envoyées par cette action.');}
    catch(error){setReferenceError(error instanceof Error?error.message:'Actualisation impossible.');}
    finally{syncRef.current=false;setSyncBusy(false);}
  };
  const loadExpenses=async(identity:DeviceIdentity)=>{try{const snapshot=await getTourExpenseSnapshot(identity);setExpenses(snapshot.expenses);setExpenseHistory(snapshot.history);setExpenseCancellations(snapshot.cancellations);setExpenseError('');setExpenseLoadedFor(`${identity.commercialId}|${identity.serverOrigin}`);}catch{setExpenses([]);setExpenseHistory([]);setExpenseCancellations([]);setExpenseLoadedFor('');setExpenseError('Impossible de lire les dépenses locales.');}};
  useEffect(()=>{if(v5Identity&&!v5Mode)void loadExpenses(v5Identity);},[v5Identity?.commercialId,v5Identity?.serverOrigin,v5Mode]);
  const refreshExpenseDay=async()=>{
    if(!v5Identity||!individual||syncRef.current||savingRef.current)return;
    if(individual.id!==v5Identity.commercialId||individual.serverOrigin!==v5Identity.serverOrigin){Alert.alert('Actualisation impossible','Le commercial ou le serveur ne correspond pas au téléphone.');return;}
    const day=expenseRefreshDay.trim(),parsed=new Date(`${day}T00:00:00.000Z`);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==day||day>tunisDay(new Date())){Alert.alert('Date invalide','Utilisez une date passée ou actuelle au format AAAA-MM-JJ.');return;}
    syncRef.current=true;setSyncBusy(true);try{
      const snapshot=await readIndividual(individual,`expense-snapshot/${day}`);
      const count=await importTourExpenseSnapshot(v5Identity,day,snapshot);await loadExpenses(v5Identity);
      setExpenseEditing(null);setExpenseCancelling(null);setExpenseDescription('');setExpenseAmount('');setExpenseCancelReason('');if(day!==journalDate)setShowOlderExpenses(true);
      Alert.alert('Dépenses actualisées',`${count} dépense(s) reçue(s) pour le ${day}. Les dépenses en attente sur les autres téléphones ne sont pas incluses.`);
    }catch(e){Alert.alert('Actualisation impossible',`${e instanceof Error?e.message:'Erreur de connexion.'} Les données locales sont conservées.`);}
    finally{syncRef.current=false;setSyncBusy(false);}
  };
  const recordExpense=async()=>{
    if(!v5Identity||expenseBusy||savingRef.current||syncRef.current)return;
    savingRef.current=true;setExpenseBusy(true);try{
      if(tunisDay(new Date())!==journalDate)throw Error('La date a changé : actualisez le journal.');
      const amount=parseDinars(expenseAmount);if(amount<=0)throw Error('Saisissez un montant supérieur à zéro.');
      if(expenseEditing){
        if(expenseEditing.day!==journalDate){
          if(!individual||individual.id!==v5Identity.commercialId||individual.serverOrigin!==v5Identity.serverOrigin)throw Error('Connectez-vous au commercial lié pour vérifier la réouverture de cette journée.');
          const state=await readIndividual(individual,`day/${expenseEditing.day}`);
          await observeIdentifiedTour(v5Identity,expenseEditing.day,state);
          if(state.status!=='open')throw Error('Journée clôturée : demandez sa réouverture à l’administrateur.');
        }
        await saveExpenseRevision(v5Identity,expenseEditing,expenseDescription,amount);
      } else await saveTourExpense(v5Identity,expenseDescription,amount,journalDate);
      setExpenseEditing(null);setExpenseDescription('');setExpenseAmount('');await loadExpenses(v5Identity);
    }catch(e){Alert.alert('Dépense non enregistrée',e instanceof Error?e.message:'Erreur de stockage.');}finally{savingRef.current=false;setExpenseBusy(false);}
  };
  const recordExpenseCancellation=async()=>{
    if(!v5Identity||!expenseCancelling||expenseBusy||savingRef.current||syncRef.current)return;
    savingRef.current=true;setExpenseBusy(true);try{
      if(tunisDay(new Date())!==journalDate)throw Error('La date a changé : actualisez le journal.');
      if(expenseCancelling.day!==journalDate){
        if(!individual||individual.id!==v5Identity.commercialId||individual.serverOrigin!==v5Identity.serverOrigin)throw Error('Connectez-vous au commercial lié pour vérifier la réouverture de cette journée.');
        const state=await readIndividual(individual,`day/${expenseCancelling.day}`);await observeIdentifiedTour(v5Identity,expenseCancelling.day,state);
        if(state.status!=='open')throw Error('Journée clôturée : demandez sa réouverture à l’administrateur.');
      }
      await saveExpenseCancellation(v5Identity,expenseCancelling,expenseCancelReason);setExpenseCancelling(null);setExpenseCancelReason('');await loadExpenses(v5Identity);
    }catch(e){Alert.alert('Annulation non enregistrée',e instanceof Error?e.message:'Erreur de stockage.');}finally{savingRef.current=false;setExpenseBusy(false);}
  };
  const sendIndividual=async()=>{
    if(!individual||syncRef.current)return;
    if(savingRef.current){Alert.alert('Opération en cours','Attendez la fin de l’enregistrement avant de synchroniser.');return;}
    syncRef.current=true;setSyncBusy(true);
    try {
      const identity={commercialId:individual.id,serverOrigin:individual.serverOrigin},entries=await getIdentifiedOutbox(identity);
      const byId=new Map(entries.map(entry=>[entry.operationId,entry]));
      const count=await uploadIdentifiedOperations(entries,identity,identity,async(path,payload)=>{const response=await fetch(`${individual.serverOrigin}/api/mobile/identified/${path}`,{method:'POST',headers:{Authorization:`Bearer ${individual.token}`,'Content-Type':'application/json'},body:payload});if(response.status===401)invalidateIndividual(individual);await checkProtocolUpgrade(individual,response);return response;},async(id)=>{const entry=byId.get(id);if(!entry)throw Error('Opération introuvable.');await acknowledgeIdentifiedEntry(identity,entry);});
      const pendingExpenses=await getPendingTourExpenseOperations(identity);
      const expenseCount=await uploadTourExpenses(pendingExpenses,identity,(path,payload)=>individualRequest(individual,path,payload),{
        original:(expense,receipt)=>confirmTourExpense(identity,expense,receipt),
        revision:(revision,receipt)=>confirmExpenseRevision(identity,revision,receipt),
        cancellation:(cancellation,receipt)=>confirmExpenseCancellation(identity,cancellation,receipt),
      });
      await loadExpenses(identity);await refreshIndividual(individual);await updateIndividualDay(individual);await loadSales();await loadJournal(journalDate);
      Alert.alert('Synchronisation terminée',`${count} opération(s) et ${expenseCount} dépense(s) envoyée(s).`);
    }catch(error){
      if(error instanceof ClosedDaySyncError) {
        const owner=error.commercialId===individual.id ? `commercial ${individual.name}` : `autre commercial (identifiant ${error.commercialId})`;
        Alert.alert('Journée clôturée', `L’opération refusée reste en attente sur ce téléphone. La journée du ${error.day} est clôturée pour ${owner}. Demandez à l’administrateur de vérifier et rouvrir cette journée, puis réessayez la synchronisation. Ne nettoyez pas ce téléphone. Les opérations déjà acceptées restent synchronisées.`);
      } else Alert.alert('Synchronisation impossible',error instanceof Error?error.message:'Erreur de synchronisation.');
      await loadExpenses({commercialId:individual.id,serverOrigin:individual.serverOrigin});await loadSales();await loadJournal(journalDate);
    }
    finally{syncRef.current=false;setSyncBusy(false);}
  };
  const closeIndividual=async()=>{
    if(!individual||syncRef.current)return;
    if(savingRef.current){Alert.alert('Opération en cours','Attendez la fin de l’enregistrement avant de clôturer.');return;}
    syncRef.current=true;setSyncBusy(true);
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
  const [editQuery,setEditQuery]=useState('');
  const [disposition, setDisposition] = useState<'refund' | 'credit' | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [revisionError, setRevisionError] = useState(false);
  const [balanceClient, setBalanceClient] = useState<Client | null>(null);
  const [clientRevisions, setClientRevisions] = useState<Revision[]>([]);
  const [journalRevisions,setJournalRevisions]=useState<Revision[]>([]);
  const [journalRevisionsLoading,setJournalRevisionsLoading]=useState(false);
  const [journalRevisionsError,setJournalRevisionsError]=useState(false);
  const [journalHistoryRetry,setJournalHistoryRetry]=useState(0);
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
  const loadSales = async () => { try { const [current, original, payments, pending] = await Promise.all([getSales(), getOriginalSales(), getSettlements(), getOutbox()]); setSales(current); setOriginalSales(original); setSettlements(payments); setOutbox(pending); setStorageError(false); } catch { setSales([]);setOriginalSales([]);setSettlements([]);setStorageError(true); } finally { setLoading(false); } };
  useEffect(() => { const timer = setInterval(() => setJournalDate(tunisDay(new Date())), 60000); return () => clearInterval(timer); }, []);
  const loadJournal = async (_day: string) => { setJournalLoading(true); try { const [invoices, receipts] = await Promise.all([getAllPreInvoices(), getTourReceipts()]); const pending = await getJournalOutbox(); setPreInvoices(invoices); setTourReceipts(receipts); setJournalOutbox(pending); setJournalError(''); } catch { setPreInvoices([]);setTourReceipts([]);setJournalError('Impossible de lire le journal local.'); } finally { setJournalLoading(false); } };
  useEffect(() => { if(!V5_TEST_ONLY)void loadJournal(journalDate); }, [journalDate]);
  useEffect(()=>{if(screen!=='journalDetail'||!journalClientId){setJournalRevisions([]);setJournalRevisionsLoading(false);setJournalRevisionsError(false);return;}let active=true;setJournalRevisions([]);setJournalRevisionsLoading(true);setJournalRevisionsError(false);void getClientRevisions(journalClientId).then(rows=>{if(active)setJournalRevisions(rows);},()=>{if(active)setJournalRevisionsError(true);}).finally(()=>{if(active)setJournalRevisionsLoading(false);});return()=>{active=false;};},[screen,journalClientId,journalDate,journalHistoryRetry]);
  useEffect(() => { if(V5_TEST_ONLY)return; void loadSales(); void (async () => { try { const raw = await getReference(); if (raw) { const parsed = JSON.parse(raw); const valid = validateReference(parsed); if (typeof parsed.syncedAt !== 'string') throw Error('Date absente'); setReference({ ...valid, syncedAt: parsed.syncedAt }); } } catch { setReferenceError('Impossible de lire les données de référence locales.'); } })(); }, []);
  const clearPhoneTestHistory=async()=>{
    if(savingRef.current||syncRef.current||loading||journalLoading||commercialBusy)return;
    savingRef.current=true;syncRef.current=true;setSaving(true);setSyncBusy(true);
    try {
      await clearLocalTestOperations();
      try{await secureSessions.clear();}catch{setSessionNotice('Impossible de supprimer la session enregistrée.');}
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
  // L'index est reconstruit uniquement à la réception d'une nouvelle référence,
  // pas à chaque frappe ni à chaque changement de panier/écran.
  const articleSearch=useMemo(()=>indexSearch(reference?.articles??[],a=>`${a.name} ${a.code} ${a.barcode}`),[reference]);
  const clientSearch=useMemo(()=>indexSearch(reference?.clients??[],c=>`${c.name} ${c.sector}`),[reference]);
  const referenceArticles=useMemo(()=>searchIndexed(articleSearch,referenceQuery),[articleSearch,referenceQuery]);
  const referenceClients=useMemo(()=>searchIndexed(clientSearch,referenceQuery),[clientSearch,referenceQuery]);
  const journalClients=useMemo(()=>searchIndexed(clientSearch,journalQuery).filter(c=>!journalSector||c.sector===journalSector),[clientSearch,journalQuery,journalSector]);
  const productMatches=useMemo(()=>searchIndexed(articleSearch,query),[articleSearch,query]);
  const editMatches=useMemo(()=>searchIndexed(articleSearch,editQuery),[articleSearch,editQuery]);
  const referenceArticlePage=usePagedItems(referenceArticles,`article:${reference?.syncedAt??''}:${referenceQuery}`);
  const referenceClientPage=usePagedItems(referenceClients,`client:${reference?.syncedAt??''}:${referenceQuery}`);
  const journalClientPage=usePagedItems(journalClients,`journal:${reference?.syncedAt??''}:${journalSector}:${journalQuery}`);
  const balanceInvoices=useMemo(()=>balanceClient?preInvoices.filter(p=>p.clientId===balanceClient.id).sort((a,b)=>b.journalDate.localeCompare(a.journalDate)):[],[preInvoices,balanceClient?.id]);
  const balanceSales=useMemo(()=>balanceClient?sales.filter(s=>s.clientId===balanceClient.id):[],[sales,balanceClient?.id]);
  const balanceSettlements=useMemo(()=>balanceClient?settlements.filter(p=>p.clientId===balanceClient.id):[],[settlements,balanceClient?.id]);
  const originalSaleById=useMemo(()=>new Map(originalSales.map(s=>[s.id,s])),[originalSales]);
  const balanceTimeline = useMemo(() => chronologicalOperations([
    ...balanceInvoices.map(value=>({type:'invoice' as const,key:`invoice:${value.id}`,date:value.createdAt,value})),
    ...balanceSales.map(value=>({type:'sale' as const,key:`sale:${value.id}:0`,date:value.createdAt,value,original:originalSaleById.get(value.id)})),
    ...originalSales.filter(value=>value.clientId===balanceClient?.id && value.paid>0).map(value=>({type:'initialPayment' as const,key:`sale:${value.id}:1`,date:value.createdAt,value})),
    ...balanceSettlements.map(value=>({type:'settlement' as const,key:`settlement:${value.id}`,date:value.createdAt,value})),
    ...tourReceipts.filter(value=>value.clientId===balanceClient?.id).map(value=>({type:'receipt' as const,key:`receipt:${value.id}`,date:value.createdAt,value})),
    ...clientRevisions.map(value=>({type:'revision' as const,key:`revision:${value.id}`,date:value.createdAt,value})),
  ]),[balanceInvoices,balanceSales,balanceSettlements,tourReceipts,balanceClient?.id,clientRevisions,originalSales,originalSaleById]);
  const timelinePage=usePagedItems(balanceTimeline,`timeline:${balanceClient?.id??''}`);
  const outboxOperationIds=useMemo(()=>new Set(outbox.map(o=>o.operationId)),[outbox]);
  const productPage=usePagedItems(productMatches,`vente:${reference?.syncedAt??''}:${query}`);
  const editPage=usePagedItems(editMatches,`edit:${reference?.syncedAt??''}:${editQuery}`);
  const journalRows = useMemo(() => buildJournal(journalDate, preInvoices, sales, new Map((reference?.clients ?? []).map(c => [c.id,c.sector]))), [journalDate,preInvoices,sales,reference]);
  const journalRow = journalRows.find(r => r.clientId === journalClientId);
  const receiptsByInvoice=useMemo(()=>{const result=new Map<string,TourJournalReceipt[]>();for(const receipt of tourReceipts){const group=result.get(receipt.preInvoiceId)??[];group.push(receipt);result.set(receipt.preInvoiceId,group);}return result;},[tourReceipts]);
  const journalReceiptsFor = (p: TourPreInvoice) => receiptsByInvoice.get(p.id)??[];
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
      const localExpenses=v5Identity?await getTourExpenses(v5Identity):undefined;
      const data = { day:journalDate, commercial:individual?.name ?? 'Non disponible (session non connectée)', rows:journalRows, receipts:tourReceipts, settlements, expenses:localExpenses, clientSectors:Object.fromEntries((reference?.clients ?? []).map(c=>[c.id,c.sector])) };
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
    if (syncRef.current) { Alert.alert('Synchronisation en cours', 'Attendez la fin de la synchronisation avant cet enregistrement.'); return; }
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
    if (syncRef.current) { Alert.alert('Synchronisation en cours', 'Attendez la fin de la synchronisation avant cet enregistrement.'); return; }
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
    if (savingRef.current) { Alert.alert('Opération en cours', 'Attendez la fin de l’enregistrement avant de synchroniser.'); return; }
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
    if (savingRef.current) { Alert.alert('Opération en cours', 'Attendez la fin de l’enregistrement avant de synchroniser.'); return; }
    syncRef.current = true; setSyncBusy(true); setReferenceError('');
    let current: OutboxEntry | undefined;
    try {
      if(await isIdentifiedDeviceBound()) throw Error('Téléphone lié à un commercial : utilisez la synchronisation individuelle depuis le journal.');
      const url = new URL(serverUrl.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname === 'localhost' || url.hostname === '127.0.0.1') throw Error('Saisissez l’adresse réseau de l’API, par exemple http://192.168.1.10:3001.');
      if (!syncToken.trim()) throw Error('Saisissez le jeton de démonstration mobile.');
      const entries = await getOutbox();
      let sent = await uploadDemoQueue(entries,async(path,entry)=>{
        current=entry;
        return fetch(`${url.origin}/api/mobile/${path}`, { method:'POST',headers:{Authorization:`Bearer ${syncToken.trim()}`,'Content-Type':'application/json','X-SLS-Reference-Version':String(reference?.version ?? '')},body:entry.payload });
      },acknowledgeOutbox);
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
  const balanceDetails = useMemo(() => {
   const cache=new Map<string,{balance:number;conflict:boolean}>();
   const calculate = (c: Client) => {
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
   return (c:Client)=>{const key=`${c.id}:${c.balance}`;const cached=cache.get(key);if(cached)return cached;const result=calculate(c);cache.set(key,result);return result;};
  },[reference,sales,settlements,preInvoices,tourReceipts,journalLoading,journalError]);
  const balanceFor = (c: Client) => balanceDetails(c).balance;
  const clientHistoryRequest=useRef(0);
  const openClientBalance = async (c: Client) => {
    const request=++clientHistoryRequest.current;
    setBalanceClient(c); setClientRevisions([]); setClientRevisionsError(false); setClientRevisionsLoading(true); setScreen('clientBalance');
    try {const histories=await getClientRevisions(c.id);if(request===clientHistoryRequest.current)setClientRevisions(histories);}
    catch {if(request===clientHistoryRequest.current)setClientRevisionsError(true);}
    finally {if(request===clientHistoryRequest.current)setClientRevisionsLoading(false);}
  };

  const totals = useMemo(() => cart.length ? calculateInvoice(cart.map(l => ({ quantity: l.quantity, unitPrice: l.product.price, discountRate: l.discount, vatRate: l.product.vat }))) : null, [cart]);
  const editTotals = useMemo(() => editLines.length ? calculateInvoice(editLines.map(l => ({ quantity: l.quantity, unitPrice: l.unitPrice, discountRate: l.discount, vatRate: l.vat }))) : null, [editLines]);
  const [invoiceExportBusy,setInvoiceExportBusy]=useState(false);
  const invoiceExportRef=useRef(false);
  const exportSaleInvoice=async()=>{
    if(!client||!totals||!cart.length||invoiceExportRef.current)return;
    invoiceExportRef.current=true;setInvoiceExportBusy(true);
    try{
      const issuedAt=new Intl.DateTimeFormat('fr-FR',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date());
      const html=saleInvoiceHtml({client:{name:client.name,sector:client.sector},commercial:individual?.name,issuedAt,lines:cart.map(l=>({name:l.product.name,code:l.product.code,quantity:l.quantity,unitPrice:l.product.price,discountRate:l.discount,vatRate:l.product.vat,unitTtc:l.product.saleTtc})),totals});
      if(!await Sharing.isAvailableAsync())throw Error('Le partage de fichiers n’est pas disponible sur cet appareil.');
      if(!FileSystem.cacheDirectory)throw Error('Stockage temporaire indisponible.');
      const result=await Print.printToFileAsync({html,base64:true});if(!result.base64)throw Error('Le PDF généré est vide ou indisponible.');
      const uri=`${FileSystem.cacheDirectory}recapitulatif-vente-${Date.now()}.pdf`;
      await FileSystem.writeAsStringAsync(uri,result.base64,{encoding:FileSystem.EncodingType.Base64});
      await Sharing.shareAsync(uri,{mimeType:'application/pdf',dialogTitle:'Partager le récapitulatif de vente',UTI:'com.adobe.pdf'});
    }catch(error){Alert.alert('Export PDF impossible',error instanceof Error?error.message:'Une erreur est survenue.');}
    finally{invoiceExportRef.current=false;setInvoiceExportBusy(false);}
  };
  const openSale = async (sale: SavedSale) => {
    setSelectedSale(sale); setRevisions([]); setRevisionError(false); setScreen('detail');
    try { setRevisions(await getRevisions(sale.id)); } catch { setRevisionError(true); }
  };
  const beginEdit = () => { if (!selectedSale) return; setEditLines(selectedSale.lines.map(l => ({ ...l }))); setEditQuery(''); setDisposition(null); setScreen('edit'); };
  const modifyLine = (index: number, change: Partial<SavedSale['lines'][number]>) => setEditLines(lines => lines.map((l, i) => i === index ? { ...l, ...change } : l));
  const commitEdit = async () => {
    if (syncRef.current) { Alert.alert('Synchronisation en cours', 'Attendez la fin de la synchronisation avant cet enregistrement.'); return; }
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
  const settlementOrigin=useRef<'journalDetail'|'clientBalance'>('clientBalance');
  const beginSettlement = (origin: 'journalDetail'|'clientBalance' = 'clientBalance') => { settlementOrigin.current=origin; setSettlementAmount(''); setSettlementMode('Espèces'); setSettlementNumber(''); setSettlementBank(''); setSettlementDue(''); setScreen('settlement'); };
  const recordSettlement = async () => {
    if (syncRef.current) { Alert.alert('Synchronisation en cours', 'Attendez la fin de la synchronisation avant cet enregistrement.'); return; }
    if (!balanceClient || savingRef.current || storageError || loading) return;
    try {
      const amount = parseDinars(settlementAmount);
      if (settlementOrigin.current === 'journalDetail' && !canQuickSettleJournal({clientId:balanceClient.id,referenceVersion:reference?.version,journalStates:reference?.journalStates,preInvoices,receipts:tourReceipts})) throw new Error('Une facture préétablie existe ou son état est inconnu : utilisez le parcours du journal.');
      if (tourReceipts.some(r => r.clientId === balanceClient.id)) throw new Error('Ce client a des opérations de journal locales : utilisez le paiement du journal. Le règlement synchronisé est temporairement indisponible pour éviter des soldes divergents.');
      if (balanceDetails(balanceClient).conflict) throw new Error('Solde incohérent : actualisez les données ou contactez l’administrateur.');
      balanceAfterSettlement(balanceFor(balanceClient), amount);
      if (settlementMode === 'Chèque' && (!settlementNumber.trim() || !settlementBank.trim() || !settlementDue.trim())) throw new Error('Renseignez le numéro, la banque et l’échéance du chèque.');
      savingRef.current = true; setSaving(true);
      await saveSettlement({ createdAt: new Date().toISOString(), clientId: balanceClient.id, clientName: balanceClient.name, amount, mode: settlementMode, chequeNumber: settlementMode === 'Chèque' ? settlementNumber.trim() : '', chequeBank: settlementMode === 'Chèque' ? settlementBank.trim() : '', chequeDue: settlementMode === 'Chèque' ? settlementDue.trim() : '' }, reference?.clients.some(c => c.id === balanceClient.id) ?? false);
      setScreen(settlementOrigin.current === 'journalDetail' ? 'journalDetail' : 'clients'); await loadSales(); Alert.alert('Règlement de démonstration enregistré', 'Le solde local du client a été mis à jour.');
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
    if (syncRef.current) { Alert.alert('Synchronisation en cours', 'Attendez la fin de la synchronisation avant cet enregistrement.'); return; }
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
  const flowOrigin = useRef<Partial<Record<Screen, Screen>>>({});
  useEffect(() => {
    if (screen === 'detail' && lastScreen.current !== 'detail' && lastScreen.current !== 'edit' && lastScreen.current !== 'editConfirm') detailOrigin.current = lastScreen.current;
    if ((screen === 'sync' || screen === 'syncSales' || screen === 'commercialLogin') && lastScreen.current !== screen) flowOrigin.current[screen] = lastScreen.current;
    lastScreen.current = screen;
  }, [screen]);
  const backTarget = (): Screen | null => {
    switch (screen) {
      case 'journal': return null;
      case 'expenses': return 'journal';
      case 'journalAdd': case 'journalDetail': return 'journal';
      case 'journalPayment': return 'journalDetail';
      case 'reference': case 'history': case 'clients': return 'journal';
      case 'clientBalance': return 'reference';
      case 'sync': case 'syncSales': case 'commercialLogin': { const from = flowOrigin.current[screen]; return from && TAB_SCREENS.includes(from) ? from : 'clients'; }
      case 'settlement': return settlementOrigin.current;
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
    if (saving || syncBusy || commercialBusy || expenseBusy) return true;
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
  const headerBack = TAB_SCREENS.includes(screen) ? undefined : () => { goBack(); };
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => { const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardOpen(true)); const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardOpen(false)); return () => { show.remove(); hide.remove(); }; }, []);
  // Une dépense peut contenir plusieurs versions en attente : le badge compte
  // des éléments locaux, pas une garantie de synchronisation globale.
  const pendingCount = outbox.length + journalOutbox.length + expenses.filter(e=>e.pending===1).length;
  const pendingKnown = !loading && !journalLoading && !storageError && !journalError && !expenseError && (!v5Identity || expenseLoadedFor===`${v5Identity.commercialId}|${v5Identity.serverOrigin}`);
  let journalAmountValid=false;
  try{journalAmountValid=!!journalAmount.trim()&&parseDinars(journalAmount)>0;}catch{/* garder l'action désactivée */}
  const bar: { actions: BarAction[]; info?: string } | null = (() => {
    switch (screen) {
      case 'journalAdd': return reference ? { info: journalPick ? `👤 ${journalPick.name}` : 'Choisissez un client', actions: [{ label: saving ? 'Enregistrement…' : 'Enregistrer la facture préétablie', disabled: !journalPick || !journalAmountValid || saving || journalLoading || loading || storageError || syncBusy, onPress: () => { void createPreInvoice(); } }] } : null;
      case 'journalDetail': return journalRow ? { actions: [...(journalRow.preInvoice ? [{ label: 'Règlement préétablie / crédit', secondary: true, disabled: journalLoading || loading || storageError, onPress: beginJournalPayment }] : [{ label: 'Régler la dette', secondary: true, disabled: journalLoading || !!journalError || loading || storageError, onPress: () => {
        const ref=reference?.clients.find(c=>c.id===journalRow.clientId); const customer=ref ? toClient(ref) : null;
        if (!customer || !canQuickSettleJournal({clientId:journalRow.clientId,referenceVersion:reference?.version,journalStates:reference?.journalStates,preInvoices,receipts:tourReceipts})) { Alert.alert('Règlement indisponible','Une facture préétablie existe ou son état est inconnu. Utilisez le parcours du journal et actualisez les données si nécessaire.'); return; }
        if (balanceDetails(customer).conflict || balanceFor(customer)<=0) { Alert.alert('Règlement indisponible','Aucune dette disponible ou solde à vérifier.'); return; }
        setBalanceClient(customer); beginSettlement('journalDetail');
      } }]), { label: '+ Vente démo', onPress: () => { const ref=reference?.clients.find(c=>c.id===journalRow.clientId); const selected=ref ? toClient(ref) : null; if (!selected) { Alert.alert('Client indisponible','Actualisez les données clients pour ajouter une vente.'); return; } if (selectClient(selected,'reference')) setReturnJournalId(journalRow.clientId); } }] } : null;
      case 'journalPayment': return journalRow?.preInvoice ? { actions: [{ label: saving?'Enregistrement…':'Enregistrer l’opération locale', disabled: saving || journalLoading || loading || storageError, onPress: () => { void recordJournalPayment(); } }] } : null;
      case 'commercialLogin': return { actions: [{ label: commercialBusy?'Vérification…':'Tester', secondary: true, disabled: commercialBusy, onPress: ()=>{void tryCommercialLogin();} }, { label: commercialBusy?'Connexion…':'Connexion individuelle', disabled: commercialBusy, onPress: ()=>{void connectIndividual();} }] };
      case 'sync': return { actions: [{ label: syncBusy ? 'Téléchargement…' : 'Télécharger', disabled: syncBusy, onPress: () => { void syncReference(); } }] };
      case 'syncSales': return { actions: [{ label: syncBusy ? 'Envoi…' : 'Envoyer', disabled: syncBusy, onPress: () => { void uploadSales(); } }] };
      case 'clientBalance': return balanceClient ? { actions: [{ label: 'Enregistrer un règlement', onPress: () => beginSettlement(), disabled: balanceFor(balanceClient) <= 0 || balanceDetails(balanceClient).conflict || storageError || loading || tourReceipts.some(r => r.clientId === balanceClient.id) }] } : null;
      case 'products': return client ? { info: totals ? `Total TTC ${money(totals.total)}` : 'Panier vide', actions: [{ label: `Voir le panier (${cart.reduce((n, l) => n + l.quantity, 0)})`, onPress: () => setScreen('cart'), disabled: !cart.length }] } : null;
      case 'cart': return client ? { info: totals ? `Total TTC ${money(totals.total)}` : undefined, actions: [{ label: 'Vérifier la vente', disabled: !totals, onPress: () => setScreen('summary') }] } : null;
      case 'summary': return client && totals ? { info: `Total TTC ${money(totals.total)}`, actions: [{ label: 'Continuer vers le paiement', onPress: () => { setPaidInput((totals.total / 1000).toFixed(3)); setScreen('payment'); } }] } : null;
      case 'payment': return client && totals ? { info: `Total TTC ${money(totals.total)}`, actions: [{ label: saving ? 'Enregistrement…' : 'Enregistrer la démo', disabled: saving || loading || storageError, onPress: () => { void recordSale(); } }] } : null;
      case 'settlement': return balanceClient ? { actions: [{ label: saving ? 'Enregistrement…' : 'Enregistrer le règlement', disabled: saving || loading || storageError, onPress: () => { void recordSettlement(); } }] } : null;
      case 'detail': return selectedSale ? { actions: [{ label: 'Modifier la vente', onPress: beginEdit, disabled: loading || storageError }] } : null;
      case 'edit': return selectedSale ? { actions: [{ label: 'Vérifier les modifications', disabled: !editTotals, onPress: () => { setDisposition(null); setScreen('editConfirm'); } }] } : null;
      case 'editConfirm': return selectedSale && editTotals ? { actions: [{ label: saving ? 'Enregistrement…' : 'Enregistrer la modification', disabled: saving || (selectedSale.paid > editTotals.total && !disposition), onPress: () => { void commitEdit(); } }] } : null;
      default: return null;
    }
  })();
  const showTabs = TAB_SCREENS.includes(screen) && !keyboardOpen;
  const showFab = false; // L'action est intégrée dans le journal.
  const bottomSpace = (showTabs ? 96 : 0) + (bar ? (bar.info ? 120 : 100) : 0) + (showFab ? 72 : 0) + 36;
  if(v5BridgeBlocked)return <SafeAreaView style={styles.safe}><View style={styles.content}><Text accessibilityRole="alert" style={styles.warning}>État de transition impossible à vérifier. N’effacez aucune donnée et contactez l’administrateur avant de continuer.</Text></View></SafeAreaView>;
  if(v5StartupChecking||dayActivating)return <SafeAreaView style={styles.safe}><View style={styles.content}><Text style={styles.warning}>Vérification du téléphone et de la facture du jour…</Text></View></SafeAreaView>;
  if(dayBinding){
    if(dayLogin)return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Header title="Connexion commercial" detail="Facture du jour" />
      <Text style={styles.muted}>Serveur lié : {dayBinding.identity.serverOrigin}</Text>
      <TextInput accessibilityLabel="Identifiant commercial" placeholder="Identifiant commercial" autoCapitalize="none" value={commercialLogin} onChangeText={setCommercialLogin} style={styles.search}/>
      <TextInput accessibilityLabel="Mot de passe commercial" placeholder="Mot de passe" secureTextEntry value={commercialPassword} onChangeText={setCommercialPassword} style={styles.search}/>
      {!!commercialError&&<Text accessibilityRole="alert" style={styles.warning}>{commercialError}</Text>}
      <Button label={commercialBusy?'Connexion…':'Se connecter'} disabled={commercialBusy} onPress={()=>{void connectIndividual();}}/>
      <Button secondary label="Continuer hors ligne" disabled={commercialBusy} onPress={()=>setDayLogin(false)}/>
    </ScrollView></SafeAreaView>;
    const synchronizeDay=async()=>{
      const session=liveIndividual.current;if(!session||!validSession(session,dayBinding.identity))throw Error('Reconnectez-vous pour synchroniser ; les opérations restent sur le téléphone.');
      const current=()=>{const live=liveIndividual.current;return !!live&&live.token===session.token&&live.id===session.id&&live.serverOrigin===session.serverOrigin&&live.expiresAt===session.expiresAt;};
      await synchronizeDayInvoiceStoragePrototype(dayBinding.identity,session,dayBinding.pin,current,()=>invalidateIndividual(session),true);
    };
    return <SafeAreaView style={styles.safe}><View style={styles.content}>
      <Text style={styles.muted}>{dayBinding.name} · {individual?'session active':'hors ligne'}</Text>
      {!!sessionNotice&&<Text style={styles.warning}>{sessionNotice}</Text>}
      {!individual&&<Button secondary label="Se reconnecter pour synchroniser" onPress={()=>setDayLogin(true)}/>}
      <Button secondary label="Journée d’aujourd’hui" onPress={()=>setJournalDate(tunisDay(new Date()))}/>
    </View><DayInvoiceWorkspace identity={dayBinding.identity} day={journalDate} commercial={dayBinding.name} onSynchronize={synchronizeDay}/></SafeAreaView>;
  }
  if(!v5Mode&&addressRecovery&&v5Identity)return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"><AddressRecoveryTest allowPrivateHttp old={v5Identity} onBack={()=>{setAddressRecovery(false);setScreen('commercialLogin');}} onMigrated={identity=>{setV5Identity(identity);setBoundCommercial(true);setServerUrl(identity.serverOrigin);setAddressRecovery(false);setScreen('commercialLogin');setReference(null);setCommercialError('');setSessionNotice('Adresse modifiée. Reconnectez-vous pour vérifier ; aucune opération n’a été envoyée.');}} /></ScrollView></SafeAreaView>;
  if(v5BridgeBusy)return <SafeAreaView style={styles.safe}><View style={styles.content}><Text style={styles.warning}>Vérification du passage aux avoirs en cours. Ne fermez pas l’application.</Text></View></SafeAreaView>;
  if(v5Mode){
    if(ADDRESS_TEST_ONLY&&addressRecovery&&v5Identity)return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"><AddressRecoveryTest old={v5Identity} onBack={()=>{setAddressRecovery(false);setV5Login(true);}} onMigrated={identity=>{setV5Identity(identity);setServerUrl(identity.serverOrigin);setAddressRecovery(false);setV5Login(true);setCommercialError('');setSessionNotice('Adresse modifiée pour cet essai fictif. Reconnectez-vous ; aucune opération n’a été envoyée.');}} /></ScrollView></SafeAreaView>;
    if(commercialBusy&&!v5Identity&&!v5Login)return <SafeAreaView style={styles.safe}><Text>Ouverture du téléphone…</Text></SafeAreaView>;
    if(!v5Identity||!v5Ready||v5Login)return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Header title="Connexion · essai v5" detail="Base de test isolée uniquement" />
      <Text style={styles.disclaimer}>Données fictives uniquement. La première connexion lie ce téléphone au serveur et au commercial ; ne pas désinstaller l’application ni supprimer les données pour résoudre un conflit.</Text>
      {v5Identity&&<Text selectable style={styles.muted}>Adresse liée au téléphone : {v5Identity.serverOrigin}</Text>}
      <TextInput accessibilityLabel="Adresse du serveur" placeholder="Adresse du serveur" autoCapitalize="none" value={serverUrl} onChangeText={setServerUrl} style={styles.search}/>
      <TextInput accessibilityLabel="Identifiant commercial" placeholder="Identifiant commercial" autoCapitalize="none" value={commercialLogin} onChangeText={setCommercialLogin} style={styles.search}/>
      <TextInput accessibilityLabel="Mot de passe commercial" placeholder="Mot de passe" secureTextEntry value={commercialPassword} onChangeText={setCommercialPassword} style={styles.search}/>
      {!!sessionNotice&&<Text style={styles.warning}>{sessionNotice}</Text>}
      {!!commercialError&&<Text accessibilityRole="alert" style={styles.warning}>{commercialError}</Text>}
      <Button label={commercialBusy?'Connexion…':'Se connecter'} disabled={commercialBusy} onPress={()=>{void connectIndividual();}} />
      {ADDRESS_TEST_ONLY&&v5Identity&&<Button secondary label="Changer l’adresse · essai fictif" disabled={commercialBusy} onPress={()=>{void startAddressRecovery();}}/>}
      {v5Identity&&v5Ready&&<Button secondary label="Continuer hors ligne" disabled={commercialBusy} onPress={()=>setV5Login(false)}/>}
    </ScrollView></SafeAreaView>;
    return <SafeAreaView style={styles.safe}><StatusBar barStyle="dark-content" />
      {!individual&&<View style={styles.content}><Text style={styles.warning}>Session expirée ou absente : travail hors ligne possible, reconnexion nécessaire pour synchroniser.</Text><Button label="Se reconnecter" onPress={()=>setV5Login(true)}/></View>}
      {!!sessionNotice&&<Text style={styles.warning}>{sessionNotice}</Text>}
      {ADDRESS_TEST_ONLY&&<View style={styles.content}><Button secondary label="Changer l’adresse · essai fictif" onPress={()=>{if(isCreditTransportBusy()){Alert.alert('Essai indisponible','Attendez la fin de la synchronisation ou de l’actualisation.');return;}setV5Login(true);}}/></View>}
      <CreditMobileWorkspacePrototype identity={v5Identity} day={journalDate} commercialName={individual?.name??'Commercial lié'} session={individual} onUnauthorized={()=>{if(individual)invalidateIndividual(individual);}} />
    </SafeAreaView>;
  }
  // ---- Journal v2 : valeurs dérivées pour JournalHome / JournalDrawer (aucune écriture) ----
  const journalStatusFor = (r: (typeof journalRows)[number]) => journalVisualStatus(
    r.preInvoice ? {amount:r.preInvoice.amount,receipts:journalReceiptsFor(r.preInvoice)} : null,
    r.sales,
  );
  const onJournal = screen === 'journal';
  const cartQty = cart.reduce((n, l) => n + l.quantity, 0);
  const homeRows = onJournal ? journalRows.map(r => { const st = journalStatusFor(r); return { id: r.clientId, name: r.clientName, sector: r.sector || 'Secteur non renseigné', total: money(r.total), status: st.label, tone: st.tone }; }) : [];
  const journalTotalNow = onJournal ? journalTotal(journalRows) : 0;
  const journalStatusList = onJournal ? journalRows.map(journalStatusFor) : [];
  const journalRest = journalStatusList.some(s=>s.rest===null) ? null : journalStatusList.reduce<number>((sum,s)=>sum+(s.rest??0),0);
  const journalCollectedAll = onJournal ? journalRows.reduce((sum, r) => sum + journalCollectedFor(r.clientId), 0) : 0;
  const journalSettledPercent = journalRest===null ? null : journalTotalNow > 0 ? Math.max(0, Math.min(100, ((journalTotalNow - journalRest) * 100) / journalTotalNow)) : 0;
  const journalNotices = ['Les données affichées sont locales. Les opérations des autres téléphones hors ligne ne sont pas visibles. Une clôture faite ailleurs peut être inconnue.'];
  const expensesHint = expenses.some(e => e.day === journalDate) ? formatMillimes(expenses.filter(e => e.day === journalDate && !e.cancelled).reduce((total, e) => total + BigInt(e.amount), 0n).toString()) : undefined;
  const drawerItems: DrawerItem[] = [
    ...(individual && v5Identity && !v5Mode && !dayBinding ? [{key:'day-invoice',label:'Passer à la facture du jour',disabled:syncBusy||commercialBusy||dayActivating,onPress:()=>Alert.alert('Passer à la facture du jour ?', 'Ce passage conserve les données locales mais remplace les anciens écrans sur ce téléphone. Synchronisez tous les téléphones et conservez une sauvegarde avant de continuer. Le serveur doit être configuré ; les dépenses existantes bloquent le passage. La première liaison fait confiance à cette adresse serveur.', [{text:'Annuler',style:'cancel' as const},{text:'Continuer',onPress:()=>{void activateDayInvoice();}}])}] : []),
    ...(individual && (V5_BRIDGE_TEST_ONLY || v5ServerAvailable) && !V5_TEST_ONLY ? [{ key: 'bridge', label: 'Passer aux avoirs · essai fictif', disabled: syncBusy || commercialBusy, onPress: () => Alert.alert('Activer les avoirs pour cet essai ?', 'Base et téléphone fictifs isolés uniquement. Les anciennes écritures seront bloquées après la transition. Aucun retour automatique n’est prévu.', [{ text: 'Annuler', style: 'cancel' as const }, { text: 'Vérifier et activer', onPress: () => { void activateV5Bridge(); } }]) }] : []),
    ...(individual ? [{ key: 'refresh', label: 'Actualiser l’état de la journée', disabled: syncBusy, onPress: () => { void updateIndividualDay(individual).catch(e => Alert.alert('Actualisation impossible', e.message)); } }] : []),
    ...(v5Identity ? [{ key: 'expenses', label: 'Dépenses de tournée', hint: expensesHint, onPress: () => setScreen('expenses') }] : []),
    ...(!individual && boundCommercial ? [{ key: 'login', label: 'Connexion commercial', onPress: () => { setCommercialResult(''); setCommercialError(''); setCommercialPassword(''); setScreen('commercialLogin'); } }] : []),
  ];
  const closeDayItem: DrawerItem | undefined = individual ? { key: 'close', label: 'Clôturer la journée', disabled: syncBusy, onPress: () => Alert.alert('Clôturer la journée ?', 'Synchronisez toutes les opérations auparavant. Seul l’administrateur pourra rouvrir cette journée.', [{ text: 'Annuler', style: 'cancel' as const }, { text: 'Clôturer', onPress: () => { void closeIndividual(); } }]) } : undefined;
  return <SafeAreaView style={styles.safe}><StatusBar barStyle="dark-content" /><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: bottomSpace }]}>
    <View style={styles.demo}><Text style={styles.demoText}>Prototype • données fictives • stockage local non chiffré</Text></View>
    {storageError && <View style={styles.demo}><Text style={styles.demoText}>Impossible de lire les ventes locales. Vérifiez le stockage, puis réessayez.</Text><Button label="Réessayer" secondary onPress={() => { setLoading(true); void loadSales(); }} /></View>}
    {screen === 'journal' && <><JournalHome title="Journal" subtitle={`Tournée du ${journalDate} · heure de Tunisie`} commercialName={individual?.name ?? ''} pendingCount={pendingCount} pendingKnown={pendingKnown} onOpenMenu={() => setDrawerOpen(true)} notices={journalNotices} errorNotice={[journalError,expenseError,sessionNotice,(!individual && boundCommercial ? 'Connectez-vous avec le commercial lié pour synchroniser et clôturer.' : '')].filter(Boolean).join('\n') || undefined} total={money(journalTotalNow)} clientCount={journalRows.length} collected={money(journalCollectedAll)} rest={journalRest===null ? 'À vérifier' : money(journalRest)} settledPercent={journalSettledPercent} rows={homeRows} loading={journalLoading} addDisabled={journalLoading || loading || storageError} exportDisabled={exportBusy || journalLoading || loading || storageError || !!journalError} onAdd={() => { setJournalPick(null); setJournalAmount(''); setJournalSector(''); setJournalQuery(''); setScreen('journalAdd'); }} onExport={() => Alert.alert('Exporter le journal', 'Données de ce téléphone uniquement, non consolidées avec les autres appareils.', [{ text: 'PDF', onPress: () => { void exportJournal('pdf'); } }, { text: 'CSV (Excel)', onPress: () => { void exportJournal('csv'); } }, { text: 'Annuler', style: 'cancel' }])} onOpenRow={id => { setJournalClientId(id); setScreen('journalDetail'); }} /><JournalDrawer visible={drawerOpen} onClose={() => setDrawerOpen(false)} name={individual?.name ?? 'Commercial non connecté'} sessionLabel={individual ? `Session jusqu’à minuit · ${closureLabel || 'État à actualiser'}` : 'Session absente ou expirée'} pendingCount={pendingCount} pendingKnown={pendingKnown} syncBusy={syncBusy} syncDisabled={!individual || syncBusy} onSync={() => { void sendIndividual(); }} items={drawerItems} closeItem={closeDayItem} footer="Mode démo · données fictives" /></>}
    {screen === 'expenses' && <><Header onBack={headerBack} title="Dépenses de tournée" detail={`Tournée du ${journalDate}`} />{v5Identity&&<View style={styles.card}><Text style={styles.cardTitle}>Dépenses de tournée</Text><Text style={styles.muted}>Carburant et frais conservés sur ce téléphone, y compris les dépenses reçues après actualisation. Les opérations en attente sur d’autres téléphones ne sont pas incluses. Les dépenses ne modifient pas les soldes clients et ne sont pas déduites de l’encaissé.</Text><TextInput accessibilityLabel="Date des dépenses à actualiser" value={expenseRefreshDay} onChangeText={setExpenseRefreshDay} placeholder="AAAA-MM-JJ" maxLength={10} style={styles.search}/><Button secondary label={syncBusy?'Actualisation ou synchronisation…':'Actualiser les dépenses de cette date'} disabled={!individual||expenseBusy||syncBusy||commercialBusy||!!expenseError} onPress={()=>{void refreshExpenseDay();}}/><Text style={styles.muted}>Connectez-vous et synchronisez vos dépenses en attente avant l’actualisation. Une version divergente est conservée et nécessite un rapprochement.</Text>{!!expenseError&&<><Text style={styles.warning}>{expenseError}</Text><Button label="Réessayer la lecture" secondary onPress={()=>{void loadExpenses(v5Identity);}}/></>}<Row label="Total des charges locales" value={expenses.some(e=>e.day===journalDate)?formatMillimes(expenses.filter(e=>e.day===journalDate&&!e.cancelled).reduce((total,e)=>total+BigInt(e.amount),0n).toString()):'Non renseigné'}/>{expenses.filter(e=>e.day===journalDate).map(e=><View key={e.operationId}><Row label={`${e.description} · ${e.cancelled?'ANNULÉE · ':''}${e.pending?'en attente':'synchronisée'} · v${e.version??1}`} value={money(e.amount)}/><MiniButton label="Corriger" disabled={expenseBusy||syncBusy||!!e.cancelled} onPress={()=>{setExpenseCancelling(null);setExpenseEditing(e);setExpenseDescription(e.description);setExpenseAmount(formatMillimes(String(e.amount)).replace(' DT',''));}}/><MiniButton label="Annuler la dépense" disabled={expenseBusy||syncBusy||!!e.cancelled} onPress={()=>{setExpenseEditing(null);setExpenseDescription('');setExpenseAmount('');setExpenseCancelling(e);setExpenseCancelReason('');}}/>{expenseCancellations.filter(c=>c.expenseId===e.operationId).map(c=><Text key={c.operationId} style={styles.warning}>Annulée le {c.recordedAt.slice(0,10)} · {c.reason}{c.pending?' · en attente':''}</Text>)}{expenseHistory.filter(r=>r.expenseId===e.operationId).map(r=><Text key={r.operationId} style={styles.muted}>v{r.version} · {r.recordedAt.slice(0,10)} : {r.previousDescription} {money(r.previousAmount)} → {r.description} {money(r.amount)}{r.pending?' · en attente':''}</Text>)}</View>)}{expenses.some(e=>e.day<journalDate)&&<><Button secondary label={showOlderExpenses?'Masquer les dépenses précédentes':'Dépenses des jours précédents'} disabled={expenseBusy||syncBusy} onPress={()=>setShowOlderExpenses(!showOlderExpenses)}/>{showOlderExpenses&&<><Text style={styles.muted}>Dépenses conservées sur ce téléphone, y compris celles actualisées depuis le serveur. Pour corriger ou annuler une journée précédente, connectez-vous et demandez sa réouverture si elle est clôturée.</Text>{expenses.filter(e=>e.day<journalDate).slice().reverse().map(e=><View key={e.operationId}><Row label={`${e.day} · ${e.description} · ${e.cancelled?'ANNULÉE · ':''}${e.pending?'en attente':'synchronisée'} · v${e.version??1}`} value={money(e.amount)}/><MiniButton label="Corriger" disabled={expenseBusy||syncBusy||!!e.cancelled} onPress={()=>{setExpenseCancelling(null);setExpenseEditing(e);setExpenseDescription(e.description);setExpenseAmount(formatMillimes(String(e.amount)).replace(' DT',''));}}/><MiniButton label="Annuler la dépense" disabled={expenseBusy||syncBusy||!!e.cancelled} onPress={()=>{setExpenseEditing(null);setExpenseDescription('');setExpenseAmount('');setExpenseCancelling(e);setExpenseCancelReason('');}}/>{expenseCancellations.filter(c=>c.expenseId===e.operationId).map(c=><Text key={c.operationId} style={styles.warning}>Annulée le {c.recordedAt.slice(0,10)} · {c.reason}{c.pending?' · en attente':''}</Text>)}{expenseHistory.filter(r=>r.expenseId===e.operationId).map(r=><Text key={r.operationId} style={styles.muted}>v{r.version} · {r.recordedAt.slice(0,10)} : {r.previousDescription} {money(r.previousAmount)} → {r.description} {money(r.amount)}{r.pending?' · en attente':''}</Text>)}</View>)}</>}</>}{expenseCancelling&&<><Text style={styles.warning}>Annuler : {expenseCancelling.description} · {expenseCancelling.day} · {money(expenseCancelling.amount)}. Cette action conserve la trace et retire le montant des charges.</Text><TextInput accessibilityLabel="Motif de l’annulation" value={expenseCancelReason} onChangeText={setExpenseCancelReason} placeholder="Motif obligatoire" maxLength={200} style={styles.search}/><Button label="Confirmer l’annulation de la dépense" disabled={expenseBusy||syncBusy||commercialBusy||!!expenseError||!expenseCancelReason.trim()} onPress={()=>Alert.alert('Annuler cette dépense ?', 'L’annulation sera conservée dans l’historique et ne pourra pas être effacée.',[{text:'Retour',style:'cancel'},{text:'Confirmer',style:'destructive',onPress:()=>{void recordExpenseCancellation();}}])}/><Button secondary label="Retour sans annuler" disabled={expenseBusy} onPress={()=>{setExpenseCancelling(null);setExpenseCancelReason('');}}/></>}{expenseEditing&&<Text style={styles.warning}>Correction : {expenseEditing.description} · journée du {expenseEditing.day} · {money(expenseEditing.amount)}</Text>}<TextInput accessibilityLabel="Description de la dépense" value={expenseDescription} onChangeText={setExpenseDescription} placeholder="Carburant, frais…" maxLength={200} style={styles.search}/><TextInput accessibilityLabel="Montant de la dépense" value={expenseAmount} onChangeText={setExpenseAmount} placeholder="Montant en DT" keyboardType="decimal-pad" style={styles.search}/><Button label={expenseBusy?'Enregistrement…':expenseEditing?'Enregistrer la correction':'Ajouter la dépense'} disabled={expenseBusy||syncBusy||commercialBusy||!!expenseError||!!expenseCancelling} onPress={()=>Alert.alert(expenseEditing?'Confirmer la correction ?':'Confirmer cette dépense ?', 'La version précédente restera dans l’historique.',[{text:'Annuler',style:'cancel'},{text:'Enregistrer',onPress:()=>{void recordExpense();}}])}/>{expenseEditing&&<Button secondary label="Annuler la correction" disabled={expenseBusy} onPress={()=>{setExpenseEditing(null);setExpenseDescription('');setExpenseAmount('');}}/>}<Text style={styles.muted}>Chaque version est conservée dans l’historique. Synchronisez avant de clôturer.</Text></View>}</>}
    {screen === 'journalAdd' && <><Header onBack={headerBack} title="Facture préétablie" detail="Montant TTC puis client" progress={{ step: journalAmountValid ? (journalPick ? 3 : 2) : 1, total: 3, label: journalAmountValid ? (journalPick ? 'Prêt à enregistrer' : 'Secteur et client') : 'Montant TTC' }} /><Text style={styles.disclaimer}>Saisie locale de démonstration : le solde change seulement après traitement de la facture. Le journal reste local jusqu’à son envoi manuel. Les données téléchargées peuvent être périmées hors ligne ; actualisez avant la saisie si possible.</Text>{!reference && <Text style={styles.warning}>Téléchargez d’abord les clients depuis l’administration.</Text>}{reference && <><StepTitle n={1} label="MONTANT TTC" /><View style={styles.amountCard}><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Montant préétabli TTC" style={styles.amountInput} keyboardType="decimal-pad" placeholder="0,000" value={journalAmount} onChangeText={setJournalAmount} /><Text style={styles.amountUnit}>DT</Text></View><StepTitle n={2} label="SECTEUR" /><ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"><View style={styles.discountRow}><TouchableOpacity style={[styles.chip,!journalSector && styles.chipActive]} onPress={() => { setJournalSector(''); setJournalPick(null); }}><Text style={!journalSector ? styles.chipActiveText : styles.chipText}>Tous</Text></TouchableOpacity>{[...new Set(reference.clients.map(c=>c.sector).filter(Boolean))].sort().map(sector=><TouchableOpacity key={sector} style={[styles.chip,journalSector===sector&&styles.chipActive]} onPress={() => { setJournalSector(sector); setJournalPick(null); }}><Text style={journalSector===sector?styles.chipActiveText:styles.chipText}>{sector}</Text></TouchableOpacity>)}</View></ScrollView><StepTitle n={3} label="CLIENT" /><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Rechercher un client du journal" style={styles.search} value={journalQuery} onChangeText={setJournalQuery} placeholder="🔎 Rechercher un client" /><Text style={styles.muted}>{journalClientPage.total} client(s) trouvé(s)</Text>{journalClientPage.items.map(c => { const availability = preInvoiceAvailability(reference,c.id,journalDate,preInvoices); const note = availability==='local' ? 'Déjà ajouté sur ce téléphone' : availability==='remote' ? 'Déjà enregistré sur le serveur' : availability==='refresh' ? 'Actualisation nécessaire' : ''; const picked = journalPick?.id===c.id; return <TouchableOpacity key={c.id} accessibilityRole="radio" accessibilityState={{ selected: picked }} activeOpacity={0.8} style={[styles.pickRow, picked && styles.pickRowActive, !!note && !picked && styles.pickRowNote]} onPress={() => setJournalPick(c)}><Avatar name={c.name} active={picked} /><View style={styles.flex}><Text style={styles.cardTitle}>{c.name}</Text><Text style={styles.muted}>{c.sector || 'Secteur non renseigné'}</Text>{note ? <Text style={styles.pickNote}>{note}</Text> : null}</View><View style={[styles.radio, picked && styles.radioActive]}>{picked ? <View style={styles.radioDot} /> : null}</View></TouchableOpacity>; })}{journalClientPage.hasMore&&<LinkButton label={`Afficher plus de clients (${journalClientPage.items.length}/${journalClientPage.total})`} onPress={journalClientPage.more}/>}</>}</>}
    {screen === 'journalDetail' && <><Header onBack={headerBack} title="Détail du client" detail={journalRow?.clientName || 'Journal du jour'} />{journalRow ? <><View style={styles.clientHero}><Avatar name={journalRow.clientName} active /><View style={styles.flex}><Text style={styles.clientHeroName}>{journalRow.clientName}</Text><Text style={styles.clientHeroSector}>{journalRow.sector || 'Secteur non renseigné'}</Text></View></View>{(() => { const facture = summarizeLocalDayInvoice(journalRow,tourReceipts,settlements); return <><Text style={styles.section}>FACTURE DU JOUR · CE TÉLÉPHONE</Text><View style={styles.totalCard}><Row label="Total facture du jour" value={money(facture.total)} strong /><View style={styles.statRow}><StatTile label="Facture préétablie" value={money(journalRow.preInvoice?.amount ?? 0)} /><StatTile amber label="Ventes sur place" value={money(journalRow.total - (journalRow.preInvoice?.amount ?? 0))} /></View><Row label="Paiements enregistrés sur ces factures" value={money(facture.paid)} /><Row label="Reste indicatif" value={facture.remaining===null ? 'À rapprocher' : money(facture.remaining)} strong /></View><Text style={styles.hint}>Montants disponibles sur ce téléphone uniquement. Les règlements d’ancienne dette ne sont pas inclus ; une opération sur un autre appareil peut modifier le résultat.</Text>{!facture.preinvoiceDeclared && <Text style={styles.warning}>La préétablie n’est pas encore déclarée dans le solde client.</Text>}</>; })()}{journalRow.preInvoice && journalRow.sales.length > 0 && <Text style={styles.warning}>Attention : dans ce parcours, le règlement de la préétablie ne règle pas les ventes en plus. Le règlement unique de la facture du jour n’est pas encore disponible.</Text>}{journalRow.preInvoice && (() => { const pre = journalRow.preInvoice; if (!pre) return null; const sm = summarizePreInvoice(pre.amount, journalReceiptsFor(pre)); const percent = pre.amount > 0 ? (sm.prePaid * 100) / pre.amount : 0; const receipts = journalReceiptsFor(pre); return <><Text style={styles.section}>RÈGLEMENT DE LA FACTURE PRÉÉTABLIE</Text><View style={styles.card}><View style={styles.row}><Pill tone={!sm.declared ? 'coral' : sm.remaining > 0 ? 'amber' : 'mint'} label={!sm.declared ? 'Non traitée' : sm.remaining > 0 ? 'Reste à payer' : 'Soldée'} /><Text style={styles.price}>{Math.round(percent)} %</Text></View><ProgressBar percent={percent} /><Row label="Payé sur la facture" value={money(sm.prePaid)} /><Row label="Reste sur la facture" value={money(sm.remaining)} /><Row label="Règlements ancienne dette" value={money(sm.oldDebtPaid)} /><Row label="Total encaissé local" value={money(journalCollectedFor(journalRow.clientId))} strong /></View>{!sm.declared && <Text style={styles.warning}>Facture préétablie non encore traitée : elle n’affecte pas le solde.</Text>}</>; })()}<Text style={styles.section}>CHRONOLOGIE DES OPÉRATIONS</Text>{journalRevisionsLoading && <Text style={styles.muted}>Chargement des modifications…</Text>}{journalRevisionsError && <><Text style={styles.warning}>Historique des modifications indisponible.</Text><Button label="Réessayer" secondary onPress={()=>setJournalHistoryRetry(n=>n+1)} /></>}{(() => {
 const pre=journalRow.preInvoice;
 const timeline=chronologicalOperations([
  ...(pre?[{type:'invoice' as const,key:`invoice:${pre.id}`,date:pre.createdAt,value:pre}]:[]),
  ...operationsOnTunisDay(tourReceipts.filter(r=>r.clientId===journalRow.clientId),journalDate).map(r=>({type:'receipt' as const,key:`receipt:${r.id}`,date:r.createdAt,value:r})),
  ...journalRow.sales.map(s=>({type:'sale' as const,key:`sale:${s.id}`,date:s.createdAt,value:s})),
  ...operationsOnTunisDay(journalRevisions,journalDate).map(r=>({type:'revision' as const,key:`revision:${r.id}`,date:r.createdAt,value:r})),
  ...settlements.filter(p=>p.clientId===journalRow.clientId&&operationDay(p.createdAt)===journalDate).map(p=>({type:'settlement' as const,key:`settlement:${p.id}`,date:p.createdAt,value:p}))
 ]);
 if(!timeline.length)return <Text style={styles.muted}>Aucune opération enregistrée.</Text>;
 return timeline.map(item=>{
  const date=Number.isFinite(Date.parse(item.date))?new Date(item.date).toLocaleString('fr-FR',{timeZone:'Africa/Tunis'}):'Date indisponible';
  if(item.type==='invoice')return <View key={item.key} style={styles.card}><Text style={styles.cardTitle}>Facture préétablie</Text><Text style={styles.muted}>{date} · heure de Tunisie</Text><Row label="Montant TTC" value={money(item.value.amount)} /></View>;
  if(item.type==='receipt'){const r=item.value;return <View key={item.key} style={styles.card}><View style={styles.row}><Text style={styles.cardTitle}>{MODE_ICON[r.mode] ?? '💳'} {r.mode}</Text><Text style={styles.muted}>{date}</Text></View><View style={styles.miniRow}><Pill label={`Facture ${money(r.prePaid)}`} /><Pill tone="amber" label={`Ancienne dette ${money(r.oldDebtPaid)}`} />{r.creditFull ? <Pill tone="coral" label="Crédit total" /> : null}</View>{r.mode === 'Chèque' && <Text style={styles.muted}>Chèque {r.chequeNumber} · {r.chequeBank} · échéance {r.chequeDue}</Text>}</View>;}
  if(item.type==='settlement'){const p=item.value;return <View key={item.key} style={styles.card}><Text style={styles.cardTitle}>Règlement de dette · {p.mode}</Text><Text style={styles.muted}>{date} · heure de Tunisie</Text><Row label="Montant" value={money(p.amount)} />{p.mode==='Chèque'&&<Text style={styles.muted}>Chèque {p.chequeNumber} · {p.chequeBank} · échéance {p.chequeDue}</Text>}</View>;}
  if(item.type==='revision'){const r=item.value;return <View key={item.key} style={styles.card}><Text style={styles.cardTitle}>Modification vente #{r.current.id}</Text><Text style={styles.muted}>{date} · heure de Tunisie</Text><Row label="Ancien total" value={money(r.previous.total)} /><Row label="Nouveau total" value={money(r.current.total)} />{r.refund>0&&<Row label="Remboursement" value={money(r.refund)} />}{revisionCreditAdded(r)!==null&&<><Row label="Excédent supplémentaire conservé en crédit" value={money(revisionCreditAdded(r)!)} /><Text style={styles.hint}>Déduit des versions de la vente ; ce montant n’est pas nécessairement le solde global du client.</Text></>}</View>;}
  const sale=item.value,original=originalSaleById.get(sale.id);return <TouchableOpacity key={item.key} accessibilityRole="button" activeOpacity={0.8} style={styles.card} onPress={() => { void openSale(sale); }}><View style={styles.row}><View style={styles.flex}><Text style={styles.cardTitle}>Vente démo #{sale.id}</Text><Text style={styles.muted}>{date} · création · heure de Tunisie</Text><Text style={styles.muted}>{original ? `Total à la création : ${money(original.total)}` : "Total à la création indisponible"}</Text></View><Text style={styles.price}>{money(sale.total)}</Text><Text style={styles.chevron}>›</Text></View><Text style={styles.muted}>Montant actuel</Text></TouchableOpacity>;
 });
})()}<Text style={styles.disclaimer}>Opérations conservées sur ce téléphone ; seules les versions envoyées sont visibles sur le serveur.</Text></> : <Text style={styles.muted}>{journalLoading ? 'Chargement…' : 'Client non trouvé pour cette journée.'}</Text>}</>}
    {screen === 'journalPayment' && journalRow?.preInvoice && <><Header onBack={headerBack} title="Paiement du journal" detail={journalRow.clientName} /><Text style={styles.disclaimer}>Le premier montant règle uniquement la préétablie, pas les ventes en plus. Le second règle l’ancienne dette. L’opération reste locale jusqu’à son envoi manuel.</Text>{(() => { const pre = journalRow.preInvoice; if (!pre) return null; const sm = summarizePreInvoice(pre.amount, journalReceiptsFor(pre)); const percent = pre.amount > 0 ? (sm.prePaid * 100) / pre.amount : 0; return <><View style={styles.totalCard}><Row label="Facture préétablie" value={money(pre.amount)} /><ProgressBar percent={percent} /><Row label="Déjà payé sur la facture" value={money(sm.prePaid)} /><Row label="Reste sur la facture" value={money(sm.remaining)} strong /></View><StepTitle n={1} label="RÈGLEMENT DE LA FACTURE" /><View style={styles.amountCard}><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Règlement de la facture préétablie" style={styles.amountInput} keyboardType="decimal-pad" placeholder="0,000" value={prePaidInput} onChangeText={setPrePaidInput} /><Text style={styles.amountUnit}>DT</Text></View>{sm.remaining > 0 && <View style={styles.miniRow}><MiniButton label="Tout le reste" onPress={() => setPrePaidInput((sm.remaining / 1000).toFixed(3))} /></View>}<StepTitle n={2} label="RÈGLEMENT D’ANCIENNE DETTE" /><View style={styles.amountCard}><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Règlement ancienne dette" style={styles.amountInput} keyboardType="decimal-pad" placeholder="0,000" value={oldPaidInput} onChangeText={setOldPaidInput} /><Text style={styles.amountUnit}>DT</Text></View><Text style={styles.hint}>Le règlement ne peut pas dépasser la dette connue avant le traitement de la facture, moins les règlements déjà saisis.</Text><View style={styles.switchRow}><View style={styles.flex}><Text style={styles.menuLabel}>Facture entièrement à crédit</Text><Text style={styles.menuHint}>Cochez uniquement si rien n’est payé sur cette facture lors de son premier traitement.</Text></View><Switch accessibilityLabel="Facture entièrement à crédit" value={creditFull} onValueChange={setCreditFull} trackColor={{ false: '#D8D3C4', true: '#7FD1B9' }} thumbColor={creditFull ? '#0E8A6D' : '#FFFFFF'} /></View><StepTitle n={3} label="MODE DE PAIEMENT" /><Segmented value={journalMode} onChange={setJournalMode} options={[{ key: 'Espèces', label: '💵 Espèces' }, { key: 'Chèque', label: '🏦 Chèque' }, { key: 'Virement', label: '🔁 Virement' }]} />{journalMode==='Chèque' && <View style={styles.card}><Text style={styles.cardTitle}>Informations du chèque</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Numéro du chèque du journal" style={[styles.search,styles.inputGap]} value={journalChequeNumber} onChangeText={setJournalChequeNumber} placeholder="Numéro du chèque" /><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Banque du chèque du journal" style={[styles.search,styles.inputGap]} value={journalChequeBank} onChangeText={setJournalChequeBank} placeholder="Banque" /><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Échéance du chèque du journal" style={[styles.search,styles.inputGap]} value={journalChequeDue} onChangeText={setJournalChequeDue} placeholder="Échéance" /></View>}</>; })()}</>}
    {screen === 'clients' && <><Header onBack={headerBack} title="Plus" detail="Synchronisation, connexion et maintenance." /><Text style={styles.disclaimer}>Données de démonstration uniquement. Téléchargez les données avant de commencer une vente. Le solde inclut les opérations locales et le dernier état téléchargé. Les opérations des autres appareils ne sont connues qu’après actualisation.</Text><MenuList><MenuRow icon="📥" label="Télécharger / actualiser les données" hint="Clients et articles de l’administration" onPress={() => { setReferenceError(''); setScreen('sync'); }} /><MenuRow icon="🔐" label="Connexion commercial" onPress={() => {setCommercialResult('');setCommercialError('');setCommercialPassword('');setScreen('commercialLogin');}} /><MenuRow icon="📤" badge={pendingCount} label="Envoyer les opérations en attente" hint="Ventes, règlements et journal" disabled={(!outbox.length && !journalOutbox.length) || storageError || loading || journalLoading || !!journalError} onPress={() => { setReferenceError(''); setScreen('syncSales'); }} /><MenuRow icon="🧹" danger label="Nettoyer les opérations fictives de ce téléphone" disabled={saving || syncBusy || loading || journalLoading || commercialBusy} onPress={confirmClearPhone} /></MenuList><Text style={styles.hint}>Les anciennes opérations restent dans l’historique. Les anciens clients et articles intégrés ne sont plus proposés.</Text></>}
    {screen === 'reference' && <><Header onBack={headerBack} title="Clients" detail={reference ? `Dernier téléchargement · ${new Date(reference.syncedAt).toLocaleString('fr-FR')}` : 'Aucun téléchargement effectué.'} stats={[{ label: 'Clients', value: String(reference?.clients.length ?? 0) }, { label: 'Articles', value: String(reference?.articles.length ?? 0) }]} action={{ label: 'Actualiser les données', icon: '↻', onPress: () => { void refreshReferenceFromHeader(); }, disabled: syncBusy || saving || commercialBusy }} />{referenceNoticeVisible&&<View style={styles.noticeLine}><Text style={styles.noticeLineText}>Les soldes peuvent être périmés hors ligne. Les opérations sont envoyées manuellement.</Text><TouchableOpacity accessibilityRole="button" accessibilityLabel="Fermer l’information" onPress={()=>setReferenceNoticeVisible(false)} style={styles.noticeClose}><Text style={styles.noticeCloseText}>×</Text></TouchableOpacity></View>}{referenceError ? <Text style={styles.warning}>{referenceError}</Text> : null}<Segmented value={referenceTab} onChange={key => { setReferenceTab(key); setReferenceQuery(''); }} options={[{ key: 'clients', label: `👥 Clients (${reference?.clients.length ?? 0})` }, { key: 'articles', label: `📦 Articles (${reference?.articles.length ?? 0})` }]} /><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Rechercher dans les données téléchargées" style={[styles.search, styles.inputGap]} placeholder="Rechercher" value={referenceQuery} onChangeText={setReferenceQuery} /><Text style={styles.muted}>{referenceTab==='clients'?referenceClientPage.total:referenceArticlePage.total} résultat(s)</Text>{referenceTab === 'clients' ? referenceClientPage.items.map(c => <View key={c.id} style={styles.card}><Text style={styles.cardTitle}>{c.name}</Text><Text style={styles.muted}>{c.sector || 'Secteur non renseigné'}</Text>{toClient(c) ? <><View style={styles.miniRow}><MiniButton label="💰 Solde" disabled={loading || storageError} onPress={() => { const customer=toClient(c); if(customer) void openClientBalance(customer); }} /><MiniButton primary label="🛒 Nouvelle vente" disabled={loading || storageError} onPress={() => { const customer=toClient(c); if(customer) selectClient(customer,'reference'); }} /></View></> : <Text style={styles.warning}>Actualisez les données pour accéder aux soldes et ventes.</Text>}</View>) : referenceArticlePage.items.map(a => <View key={a.id} style={styles.card}><Text style={styles.cardTitle}>{a.name}</Text><Text style={styles.muted}>{a.code} · TVA {a.vatRate / 100} %</Text><Text style={styles.price}>{formatMillimes(a.saleTtc)} TTC / unité</Text></View>)}{(referenceTab==='clients'?referenceClientPage:referenceArticlePage).hasMore&&<LinkButton label={`Afficher plus (${referenceTab==='clients'?referenceClientPage.items.length:referenceArticlePage.items.length}/${referenceTab==='clients'?referenceClientPage.total:referenceArticlePage.total})`} onPress={referenceTab==='clients'?referenceClientPage.more:referenceArticlePage.more}/>}</>}
    {screen === 'commercialLogin' && <><Header onBack={headerBack} title="Connexion commercial" detail="Compte individuel" /><Text style={styles.disclaimer}>Le test ne lie pas le téléphone. La connexion individuelle lie ce téléphone au commercial et au serveur après synchronisation de toutes les opérations en attente. Le mot de passe n’est pas enregistré. La session est conservée de manière sécurisée jusqu’à minuit, heure de Tunisie. Après expiration, le travail hors ligne reste possible, mais la synchronisation nécessite une nouvelle connexion. En HTTP, utilisez seulement des identifiants fictifs sur un réseau privé de confiance.</Text>{v5Identity&&<Text selectable accessibilityLabel="Adresse actuellement liée au téléphone" style={styles.muted}>Adresse actuellement liée au téléphone : {v5Identity.serverOrigin}. La modifier ci-dessous ne change pas cette liaison.</Text>}{v5Identity&&<Button secondary label="Changer l’adresse du serveur" disabled={commercialBusy} onPress={()=>{void startAddressRecovery();}}/>}<Text style={styles.section}>ADRESSE DE L’API</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Adresse du serveur commercial" style={styles.search} autoCapitalize="none" autoCorrect={false} value={serverUrl} onChangeText={setServerUrl} placeholder="http://192.168.1.10:3001" /><Text style={styles.section}>IDENTIFIANT COMMERCIAL</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Identifiant commercial" style={styles.search} autoCapitalize="none" autoCorrect={false} value={commercialLogin} onChangeText={setCommercialLogin} /><Text style={styles.section}>MOT DE PASSE FICTIF</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Mot de passe commercial" style={styles.search} autoCapitalize="none" autoCorrect={false} secureTextEntry value={commercialPassword} onChangeText={setCommercialPassword} />{commercialError ? <Text style={styles.warning}>{commercialError}</Text> : null}{commercialResult ? <Text style={styles.muted}>Connexion de test réussie : {commercialResult}. Aucune opération n’a été attribuée.</Text> : null}</>}
    {screen === 'sync' && <><Header onBack={headerBack} title="Télécharger les données" detail="Connexion manuelle à l’API de démonstration" /><Text style={styles.disclaimer}>Le mode HTTP local n’est pas chiffré : uniquement sur un réseau privé de confiance et avec des données et un jeton de test. Le jeton n’est pas enregistré. N’utilisez jamais le mot de passe administrateur.</Text><Text style={styles.section}>ADRESSE DE L’API</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Adresse du serveur" style={styles.search} autoCapitalize="none" autoCorrect={false} value={serverUrl} onChangeText={setServerUrl} placeholder="http://192.168.1.10:3001" /><Text style={styles.section}>JETON DE DÉMONSTRATION MOBILE</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Jeton mobile" style={styles.search} autoCapitalize="none" autoCorrect={false} secureTextEntry value={syncToken} onChangeText={setSyncToken} placeholder="Jeton mobile de test" />{referenceError ? <Text style={styles.warning}>{referenceError}</Text> : null}</>}
    {screen === 'syncSales' && <><Header onBack={headerBack} title="Envoyer les opérations" detail={`${outbox.length} vente(s) ou règlement(s) et ${journalOutbox.length} version(s) de journal en attente`} /><Text style={styles.disclaimer}>Démonstration uniquement. Les échanges HTTP ne sont pas chiffrés. Les opérations sont fictives et ne sont pas des factures officielles. Le solde serveur dépend des opérations reçues.</Text><Text style={styles.section}>ADRESSE DE L’API</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Adresse du serveur" style={styles.search} autoCapitalize="none" autoCorrect={false} value={serverUrl} onChangeText={setServerUrl} placeholder="http://192.168.1.10:3001" /><Text style={styles.section}>JETON MOBILE DE TEST</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Jeton mobile" style={styles.search} autoCapitalize="none" autoCorrect={false} secureTextEntry value={syncToken} onChangeText={setSyncToken} placeholder="Jeton mobile de test" />{referenceError ? <Text style={styles.warning}>{referenceError}</Text> : null}</>}
    {screen === 'clientBalance' && balanceClient && <><Header onBack={headerBack} title="Solde client" detail={`${balanceClient.name} · ${balanceClient.sector}`} /><View style={styles.totalCard}><Row label="Dette actuelle" value={money(Math.max(0, balanceFor(balanceClient)))} strong /><Row label="Crédit en faveur du client" value={money(Math.max(0, -balanceFor(balanceClient)))} /><Row label="Plafond de crédit" value={money(balanceClient.limit)} /><Row label="Dernier solde serveur reçu" value={money(Number(reference?.clients.find(c => c.id === balanceClient.id)?.serverBalance ?? balanceClient.balance))} /></View><Text style={styles.hint}>Solde serveur au dernier téléchargement, ajusté par les opérations locales non encore prises en compte et par le journal local. Les opérations des autres appareils ne sont visibles qu’après actualisation.</Text>{balanceDetails(balanceClient).conflict && <Text style={styles.warning}>Solde ou journal incohérent : le montant affiché peut être incomplet. Actualisez les données ou contactez l’administrateur ; les nouvelles opérations sont bloquées.</Text>}{isSaleBlocked(balanceFor(balanceClient), balanceClient.limit, false) && <Text style={styles.warning}>Limite atteinte : vente bloquée.</Text>}
      {tourReceipts.some(r => r.clientId === balanceClient.id) && <Text style={styles.warning}>Règlement global temporairement indisponible pour ce client : utilisez le journal du jour.</Text>}<Text style={styles.hint}>Le règlement réduit la dette globale ; il n’est pas attribué à une facture particulière dans cette démo.</Text><Text style={styles.section}>OPÉRATIONS LOCALES · PLUS RÉCENTES D’ABORD</Text>{journalError && <Text style={styles.warning}>Historique du journal indisponible.</Text>}{journalLoading && <Text style={styles.muted}>Chargement du journal…</Text>}{clientRevisionsLoading && <Text style={styles.muted}>Chargement des modifications…</Text>}{clientRevisionsError && <><Text style={styles.warning}>Impossible de charger les modifications.</Text><Button label="Réessayer" secondary onPress={() => { void openClientBalance(balanceClient); }} /></>}{!balanceTimeline.length && !journalLoading && !clientRevisionsLoading && <Text style={styles.muted}>Aucune opération locale.</Text>}{timelinePage.items.map((item,index) => {
        const date = Number.isFinite(Date.parse(item.date)) ? new Date(item.date).toLocaleString('fr-FR',{timeZone:'Africa/Tunis'}) : 'Date indisponible';
        const showDay=index===0 || operationDay(item.date)!==operationDay(timelinePage.items[index-1].date);
        return <React.Fragment key={item.key}>{showDay && <Text style={styles.section}>{operationDayLabel(item.date)}</Text>}{(() => {
        if(item.type === 'invoice') { const p=item.value; const summary=summarizePreInvoice(p.amount,journalReceiptsFor(p)); return <View key={item.key} style={styles.card}><Text style={styles.cardTitle}>Facture préétablie</Text><Text style={styles.muted}>{date} · journée {p.journalDate} · {journalOutbox.some(x => x.invoiceId === p.id) ? "en attente" : "envoyé (actualiser les données)"}</Text><Row label="Montant" value={money(p.amount)} /><Row label="Paiements sur la facture" value={money(summary.prePaid)} /><Row label="Reste actuel" value={money(summary.remaining)} />{!summary.declared && <Text style={styles.warning}>Non traitée : le reste n’est pas encore inclus dans le solde.</Text>}</View>; }
        if(item.type === 'sale') { const s=item.value, original=item.original; return <TouchableOpacity key={item.key} accessibilityRole="button" style={styles.card} onPress={() => { void openSale(s); }}><Text style={styles.cardTitle}>Vente démo #{s.id}</Text><Text style={styles.muted}>{date} · création</Text>{original ? <><Row label="Total à la création" value={money(original.total)} /><Row label="Payé à la création" value={money(original.paid)} /></> : <Text style={styles.warning}>Montants à la création indisponibles.</Text>}<Text style={styles.hint}>Appuyez pour consulter les montants actuels et les modifications.</Text></TouchableOpacity>; }
        if(item.type === 'initialPayment') { const p=item.value; return <View key={item.key} style={styles.card}><Text style={styles.cardTitle}>Paiement initial · vente #{p.id}</Text><Text style={styles.muted}>{date} · {p.paymentMode}</Text><Row label="Montant encaissé à la vente" value={money(p.paid)} />{p.paymentMode === 'Chèque' && <Text style={styles.muted}>Chèque {p.chequeNumber} · {p.chequeBank} · échéance {p.chequeDue}</Text>}<Text style={styles.hint}>Déjà compris dans le paiement net de la vente.</Text></View>; }
        if(item.type === 'settlement') { const p=item.value; return <View key={item.key} style={styles.card}><Text style={styles.cardTitle}>Règlement : {money(p.amount)}</Text><Text style={styles.muted}>{date} · {p.mode} · {p.syncOperationId ? (outboxOperationIds.has(p.syncOperationId) ? 'En attente' : 'Envoyé') : 'Local seulement'}</Text>{p.mode === 'Chèque' && <Text style={styles.muted}>Chèque {p.chequeNumber} · {p.chequeBank} · échéance {p.chequeDue}</Text>}</View>; }
        if(item.type === 'receipt') { const r=item.value; return <View key={item.key} style={styles.card}><Text style={styles.cardTitle}>{r.creditFull ? 'Facture entièrement à crédit' : 'Paiement du journal'}</Text><Text style={styles.muted}>{date} · {r.mode}</Text><Row label="Paiement de la facture" value={money(r.prePaid)} /><Row label="Règlement d’ancienne dette" value={money(r.oldDebtPaid)} />{r.mode === 'Chèque' && <Text style={styles.muted}>Chèque {r.chequeNumber} · {r.chequeBank} · échéance {r.chequeDue}</Text>}</View>; }
        const r=item.value; return <View key={item.key} style={styles.card}><Text style={styles.cardTitle}>Modification vente #{r.current.id}</Text><Text style={styles.muted}>{date}</Text><Row label="Ancien total" value={money(r.previous.total)} /><Row label="Nouveau total" value={money(r.current.total)} />{r.refund>0 && <Row label="Remboursement" value={money(r.refund)} />}{revisionCreditAdded(r)!==null && <><Row label="Excédent supplémentaire conservé en crédit" value={money(revisionCreditAdded(r)!)} /><Text style={styles.hint}>Déduit des versions de la vente ; ce montant n’est pas nécessairement le solde global du client.</Text></>}</View>;
        })()}</React.Fragment>;
      })}{timelinePage.hasMore&&<LinkButton label={`Afficher plus (${timelinePage.items.length}/${timelinePage.total})`} onPress={timelinePage.more}/>}<Text style={styles.disclaimer}>Données fictives sur ce téléphone uniquement. Les remboursements sont enregistrés, pas effectués par l’application. Le crédit ne peut pas encore être utilisé pour payer une autre vente.</Text></>}
    {screen === 'products' && client && <><Header onBack={headerBack} title="Ajouter des articles" detail={`Client : ${client.name}`} stats={[{ label: 'Panier', value: `${cartQty} article${cartQty > 1 ? 's' : ''}` }, { label: 'Total TTC', value: money(totals ? totals.total : 0) }]} action={{ label: `Panier, ${cartQty} article(s)`, icon: 'cart', badge: cartQty, onPress: () => setScreen('cart'), disabled: !cart.length }} /><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Rechercher un article" style={styles.search} placeholder="Rechercher un article ou un code" value={query} onChangeText={setQuery} />{notice ? <Text accessibilityLiveRegion="polite" style={styles.success}>{notice}</Text> : null}<Text style={styles.section}>{saleSource === 'reference' ? 'CATALOGUE TÉLÉCHARGÉ · DÉMONSTRATION' : 'CATALOGUE DE DÉMONSTRATION'}</Text>{saleSource === 'reference' && <Text style={styles.warning}>Prix HT calculé depuis le TTC : arrondi provisoire à valider. Les ventes restent locales.</Text>}
      <Text style={styles.muted}>{productPage.total} article(s) trouvé(s)</Text>{productPage.items.map(a => {const p:Product={id:a.id,name:a.name,code:a.code,price:unitPriceExcludingVat(a.saleTtc,a.vatRate),vat:a.vatRate,saleTtc:Number(a.saleTtc)};return <View key={p.id} style={styles.card}><Text style={styles.cardTitle}>{p.name}</Text><Text style={styles.muted}>{p.code} · TVA {p.vat / 100} %</Text><View style={[styles.row, styles.cardBottom]}><View><Text style={styles.price}>{formatMillimes(a.saleTtc)} TTC</Text><Text style={styles.muted}>{money(p.price)} HT calculé</Text></View>{(() => { const q = cart.find(l => l.product.id === p.id)?.quantity ?? 0; return q ? <View style={styles.quantity}><TouchableOpacity accessibilityLabel={`Réduire la quantité de ${p.name}`} onPress={() => change(p.id, x => x.quantity === 1 ? null : { ...x, quantity: x.quantity - 1 })}><Text style={styles.quantityButton}>−</Text></TouchableOpacity><Text style={styles.quantityNumber}>{q}</Text><TouchableOpacity accessibilityLabel={`Ajouter ${p.name}`} onPress={() => add(p)}><Text style={styles.quantityButton}>+</Text></TouchableOpacity></View> : <RoundButton label="+" accessibilityLabel={`Ajouter ${p.name}`} onPress={() => add(p)} />; })()}</View></View>;})}{productPage.hasMore&&<LinkButton label={`Afficher plus d’articles (${productPage.items.length}/${productPage.total})`} onPress={productPage.more}/>}

    </>}
    {screen === 'cart' && client && <><Header onBack={headerBack} title="Votre panier" detail={client.name} />{cart.map(l => <View key={l.product.id} style={styles.card}><Text style={styles.cardTitle}>{l.product.name}</Text><Text style={styles.muted}>{money(l.product.price)} HT / unité</Text><View style={[styles.row, styles.cardBottom]}><View style={styles.quantity}><TouchableOpacity accessibilityLabel={`Réduire la quantité de ${l.product.name}`} onPress={() => change(l.product.id, x => x.quantity === 1 ? null : { ...x, quantity: x.quantity - 1 })}><Text style={styles.quantityButton}>−</Text></TouchableOpacity><Text style={styles.quantityNumber}>{l.quantity}</Text><TouchableOpacity accessibilityLabel={`Augmenter la quantité de ${l.product.name}`} onPress={() => change(l.product.id, x => ({ ...x, quantity: x.quantity + 1 }))}><Text style={styles.quantityButton}>+</Text></TouchableOpacity></View><TouchableOpacity accessibilityRole="button" onPress={() => change(l.product.id, () => null)}><Text style={styles.remove}>Supprimer</Text></TouchableOpacity></View><Text style={styles.muted}>Remise : {l.discount / 100} %</Text><View style={styles.discountRow}>{[0, 5, 10, 20].map(percent => <TouchableOpacity key={percent} accessibilityRole="button" onPress={() => change(l.product.id, x => ({ ...x, discount: percent * 100 }))} style={[styles.chip, l.discount === percent * 100 && styles.chipActive]}><Text style={l.discount === percent * 100 ? styles.chipActiveText : styles.chipText}>{percent} %</Text></TouchableOpacity>)}</View><Text style={styles.hint}>Remises prédéfinies pour cette démonstration.</Text></View>)}
      {totals && <View style={styles.totalCard}><Row label="Sous-total HT" value={money(totals.subtotal)} /><Row label="Remise" value={`− ${money(totals.discount)}`} /><Row label="Total HT" value={money(totals.net)} /><Row label="TVA" value={money(totals.vat)} /><Row label="Total TTC" value={money(totals.total)} strong /></View>}
      <LinkButton label="+ Ajouter d’autres articles" onPress={() => { setNotice(''); setQuery(''); setScreen('products'); }} />
    </>}
    {screen === 'summary' && client && totals && <><Header onBack={headerBack} title="Récapitulatif" detail="Vérifiez les informations de cette démonstration." /><View style={styles.card}><Text style={styles.section}>CLIENT</Text><Text style={styles.cardTitle}>{client.name}</Text><Text style={styles.muted}>{client.sector}</Text></View><View style={styles.card}><Text style={styles.section}>ARTICLES</Text>{cart.map(l => <Row key={l.product.id} label={`${l.quantity} × ${l.product.name}`} value={`${l.discount / 100} % remise`} />)}</View><View style={styles.totalCard}><Row label="Total HT" value={money(totals.net)} /><Row label="TVA" value={money(totals.vat)} /><Row label="Total TTC" value={money(totals.total)} strong /></View><Button secondary label={invoiceExportBusy?'Génération du PDF…':'Exporter la facture en PDF'} disabled={invoiceExportBusy} onPress={()=>{void exportSaleInvoice();}} /><Text style={styles.disclaimer}>Ceci est une vente de démonstration, pas une facture officielle. Aucun envoi au serveur.</Text><LinkButton danger label="Abandonner cette vente" onPress={reset} /></>}
    {screen === 'payment' && client && totals && <><Header onBack={headerBack} title="Paiement" detail={`Total : ${money(totals.total)}`} /><Text style={styles.section}>MODE DE PAIEMENT</Text><View style={styles.discountRow}>{['Espèces', 'Chèque', 'Virement', 'Crédit'].map(m => <TouchableOpacity key={m} accessibilityRole="button" onPress={() => setMode(m)} style={[styles.chip, mode === m && styles.chipActive]}><Text style={mode === m ? styles.chipActiveText : styles.chipText}>{m}</Text></TouchableOpacity>)}</View>
      {mode !== 'Crédit' && <><Text style={styles.section}>MONTANT ENCAISSÉ (DT)</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Montant encaissé en dinars" style={styles.search} value={paidInput} onChangeText={setPaidInput} keyboardType="decimal-pad" placeholder="0,000" /><Text style={styles.hint}>Maximum 3 décimales. Un paiement partiel est possible.</Text></>}
      {mode === 'Chèque' && <><Text style={styles.section}>INFORMATIONS DU CHÈQUE</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Numéro du chèque" style={styles.search} value={chequeNumber} onChangeText={setChequeNumber} placeholder="Numéro du chèque" /><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Banque" style={[styles.search, styles.inputGap]} value={chequeBank} onChangeText={setChequeBank} placeholder="Banque" /><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Échéance du chèque" style={[styles.search, styles.inputGap]} value={chequeDue} onChangeText={setChequeDue} placeholder="Échéance (ex. 30/12/2026)" /></>}
      <Text style={styles.disclaimer}>Données fictives uniquement : les ventes sont stockées sans chiffrement et envoyées manuellement.</Text></>}
    {screen === 'settlement' && balanceClient && <><Header onBack={headerBack} title="Règlement de dette" detail={balanceClient.name} /><View style={styles.totalCard}><Row label="Dette actuelle" value={money(Math.max(0, balanceFor(balanceClient)))} strong /></View><Text style={styles.section}>MODE DE PAIEMENT</Text><View style={styles.discountRow}>{['Espèces', 'Chèque', 'Virement'].map(m => <TouchableOpacity key={m} accessibilityRole="button" onPress={() => setSettlementMode(m)} style={[styles.chip, settlementMode === m && styles.chipActive]}><Text style={settlementMode === m ? styles.chipActiveText : styles.chipText}>{m}</Text></TouchableOpacity>)}</View><Text style={styles.section}>MONTANT ENCAISSÉ (DT)</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Montant du règlement" style={styles.search} value={settlementAmount} onChangeText={setSettlementAmount} keyboardType="decimal-pad" placeholder="0,000" /><Text style={styles.hint}>Le montant doit être positif et ne peut pas dépasser la dette globale.</Text>{settlementMode === 'Chèque' && <><Text style={styles.section}>INFORMATIONS DU CHÈQUE</Text><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Numéro du chèque" style={styles.search} value={settlementNumber} onChangeText={setSettlementNumber} placeholder="Numéro du chèque" /><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Banque" style={[styles.search, styles.inputGap]} value={settlementBank} onChangeText={setSettlementBank} placeholder="Banque" /><TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Échéance du chèque" style={[styles.search, styles.inputGap]} value={settlementDue} onChangeText={setSettlementDue} placeholder="Échéance (ex. 30/12/2026)" /></>}<Text style={styles.disclaimer}>Règlement fictif de la dette globale : aucune facture n’est marquée payée individuellement et aucun argent n’est transféré.</Text></>}
    {screen === 'history' && <><Header onBack={headerBack} title="Historique local" detail="Ventes et paiements fictifs enregistrés sur ce téléphone." /><Text style={styles.disclaimer}>Ventes, règlements et versions du journal en attente. Le journal nécessite une référence v3 et un serveur compatible ; les anciennes ventes restent locales.</Text><Text style={styles.muted}>{outbox.length} vente(s) ou règlement(s) et {journalOutbox.length} version(s) de journal en attente</Text><MenuList><MenuRow icon="📤" badge={pendingCount} label="Envoyer les opérations en attente" disabled={(!outbox.length && !journalOutbox.length) || storageError || loading || journalLoading || !!journalError} onPress={() => { setReferenceError(''); setScreen('syncSales'); }} /></MenuList>{outbox.some(x => x.lastError) && <Text style={styles.warning}>Dernière erreur : {outbox.find(x => x.lastError)?.lastError}</Text>}{!sales.length && !settlements.length && <Text style={styles.muted}>Aucune opération enregistrée.</Text>}{[
      ...sales.map(s => ({ key: `sale-${s.id}`, date: s.createdAt, type: 'sale' as const, sale: s })),
      ...originalSales.filter(s => s.paid > 0).map(s => ({ key: `payment-${s.id}`, date: s.createdAt, type: 'initial' as const, sale: s })),
      ...settlements.map(p => ({ key: `settlement-${p.id}`, date: p.createdAt, type: 'settlement' as const, payment: p })),
    ].sort((a, b) => b.date.localeCompare(a.date)).map(item => item.type === 'settlement' ? <View key={item.key} style={styles.card}><Text style={styles.cardTitle}>Règlement de dette · {item.payment.clientName}</Text><Text style={styles.muted}>{new Date(item.date).toLocaleString('fr-FR')} · {item.payment.mode}</Text><Text style={styles.price}>{money(item.payment.amount)}</Text>{item.payment.mode === 'Chèque' && <Text style={styles.muted}>Chèque {item.payment.chequeNumber} · {item.payment.chequeBank} · échéance {item.payment.chequeDue}</Text>}</View> : item.type === 'initial' ? <View key={item.key} style={styles.card}><Text style={styles.cardTitle}>Paiement à la vente · {item.sale.clientName}</Text><Text style={styles.muted}>{new Date(item.date).toLocaleString('fr-FR')} · {item.sale.paymentMode} · vente démo #{item.sale.id}</Text><Text style={styles.price}>{money(item.sale.paid)}</Text>{item.sale.paymentMode === 'Chèque' && <Text style={styles.muted}>Chèque {item.sale.chequeNumber} · {item.sale.chequeBank} · échéance {item.sale.chequeDue}</Text>}</View> : <TouchableOpacity key={item.key} accessibilityRole="button" style={styles.card} onPress={() => { void openSale(item.sale); }}><Text style={styles.cardTitle}>Vente · {item.sale.clientName}</Text><Text style={styles.muted}>{new Date(item.date).toLocaleString('fr-FR')} · Démo #{item.sale.id} · total actuel</Text><View style={styles.row}><Text style={styles.price}>{money(item.sale.total)}</Text><Text style={styles.muted}>{saleSyncStatus(item.sale,outbox,reference,storageError||loading||syncBusy)}</Text><Text style={styles.chevron}>›</Text></View></TouchableOpacity>)}</>}
    {screen === 'detail' && selectedSale && <><Header onBack={headerBack} title={`Vente démo #${selectedSale.id}`} detail={selectedSale.clientName} /><View style={styles.card}>{selectedSale.lines.map((l, i) => <View key={i}><Row label={`${l.quantity} × ${l.name}`} value={`${l.discount / 100} % remise`} /><Text style={styles.muted}>{l.code} · {money(l.unitPrice)} HT · TVA {l.vat / 100} %</Text></View>)}</View><View style={styles.totalCard}><Row label="Total TTC" value={money(selectedSale.total)} strong /><Row label="Encaissé" value={money(selectedSale.paid)} /><Row label="Reste à payer" value={money(Math.max(0, selectedSale.total - selectedSale.paid))} />{selectedSale.paid > selectedSale.total && <Row label="Crédit en faveur du client" value={money(selectedSale.paid - selectedSale.total)} />}<Row label="Mode" value={selectedSale.paymentMode} />{selectedSale.paymentMode === 'Chèque' && <><Row label="Numéro" value={selectedSale.chequeNumber} /><Row label="Banque" value={selectedSale.chequeBank} /><Row label="Échéance" value={selectedSale.chequeDue} /></>}</View><Text style={styles.disclaimer}>Démonstration locale : le règlement global du client n’est pas imputé à cette vente. {saleSyncStatus(selectedSale,outbox,reference,storageError||loading||syncBusy)}. Le dernier téléchargement peut être ancien.</Text><Text style={styles.section}>HISTORIQUE DES MODIFICATIONS</Text>{revisionError && <Text style={styles.warning}>Impossible de charger l’historique des modifications.</Text>}{!revisionError && !revisions.length && <Text style={styles.muted}>Aucune modification enregistrée.</Text>}{revisions.map(r => <View key={r.id} style={styles.card}><Text style={styles.cardTitle}>{new Date(r.createdAt).toLocaleString('fr-FR')}</Text><Row label="Ancien total" value={money(r.previous.total)} /><Row label="Nouveau total" value={money(r.current.total)} />{r.refund > 0 && <Row label="Remboursement" value={money(r.refund)} />}{revisionCreditAdded(r)!==null && <><Row label="Excédent supplémentaire conservé en crédit" value={money(revisionCreditAdded(r)!)} /><Text style={styles.hint}>Déduit des versions de la vente ; ce montant n’est pas nécessairement le solde global du client.</Text></>}</View>)}</>}
    {screen === 'edit' && selectedSale && <><Header onBack={headerBack} title="Modifier la vente" detail={`Démo #${selectedSale.id} · ${selectedSale.clientName}`} /><Text style={styles.disclaimer}>Modifiez les quantités ou les remises. Le paiement déjà enregistré est conservé.</Text>{editLines.map((l, index) => <View key={`${l.code}-${index}`} style={styles.card}><Text style={styles.cardTitle}>{l.name}</Text><Text style={styles.muted}>{money(l.unitPrice)} HT / unité</Text><View style={styles.row}><View style={styles.quantity}><TouchableOpacity accessibilityLabel={`Réduire ${l.name}`} onPress={() => l.quantity > 1 ? modifyLine(index, {quantity: l.quantity - 1}) : setEditLines(lines => lines.filter((_, i) => i !== index))}><Text style={styles.quantityButton}>−</Text></TouchableOpacity><Text style={styles.quantityNumber}>{l.quantity}</Text><TouchableOpacity accessibilityLabel={`Augmenter ${l.name}`} onPress={() => modifyLine(index, {quantity: l.quantity + 1})}><Text style={styles.quantityButton}>+</Text></TouchableOpacity></View><TouchableOpacity onPress={() => setEditLines(lines => lines.filter((_, i) => i !== index))}><Text style={styles.remove}>Supprimer</Text></TouchableOpacity></View><Text style={styles.muted}>Remise : {l.discount / 100} %</Text><View style={styles.discountRow}>{[0, 5, 10, 20].map(percent => <TouchableOpacity key={percent} accessibilityRole="button" onPress={() => modifyLine(index, {discount: percent * 100})} style={[styles.chip, l.discount === percent * 100 && styles.chipActive]}><Text style={l.discount === percent * 100 ? styles.chipActiveText : styles.chipText}>{percent} %</Text></TouchableOpacity>)}</View></View>)}
      <Text style={styles.section}>AJOUTER UN ARTICLE</Text><TextInput accessibilityLabel="Rechercher un article à ajouter" style={styles.search} value={editQuery} onChangeText={setEditQuery} placeholder="Nom, code ou code-barres"/><Text style={styles.muted}>{editPage.total} article(s) trouvé(s)</Text>{(selectedSale && /^[0-9a-f-]{36}$/i.test(selectedSale.clientId) ? editPage.items : []).map(a => {const p:Product={id:a.id,name:a.name,code:a.code,price:unitPriceExcludingVat(a.saleTtc,a.vatRate),vat:a.vatRate};return <View key={p.id} style={styles.row}><Text style={styles.rowLabel}>{p.name}</Text><RoundButton label="+" accessibilityLabel={`Ajouter ${p.name}`} onPress={() => setEditLines(lines => [...lines, { name: p.name, code: p.code, quantity: 1, unitPrice: p.price, discount: 0, vat: p.vat }])} /></View>;})}{/^[0-9a-f-]{36}$/i.test(selectedSale.clientId)&&editPage.hasMore&&<LinkButton label={`Afficher plus d’articles (${editPage.items.length}/${editPage.total})`} onPress={editPage.more}/>}
      {editTotals && <View style={styles.totalCard}><Row label="Nouveau total TTC" value={money(editTotals.total)} strong /><Row label="Paiement conservé" value={money(selectedSale.paid)} /></View>}</>}
    {screen === 'editConfirm' && selectedSale && editTotals && <><Header onBack={headerBack} title="Confirmer la modification" detail={selectedSale.clientName} /><View style={styles.totalCard}><Row label="Ancien total" value={money(selectedSale.total)} /><Row label="Nouveau total" value={money(editTotals.total)} strong /><Row label="Paiement déjà enregistré" value={money(selectedSale.paid)} /></View>{selectedSale.paid > editTotals.total ? <><Text style={styles.warning}>Trop-perçu : {money(selectedSale.paid - editTotals.total)}. Choisissez une option :</Text><ChoiceRow label="Retourner l’argent au client" selected={disposition === 'refund'} onPress={() => setDisposition('refund')} /><ChoiceRow label="Garder en crédit client" selected={disposition === 'credit'} onPress={() => setDisposition('credit')} /><Text style={styles.hint}>La validation enregistre le remboursement : assurez-vous de remettre l’argent au client.</Text></> : <Text style={styles.muted}>Nouveau reste à payer : {money(editTotals.total - selectedSale.paid)}</Text>}</>}
    <Text style={styles.footer}>SLS MOBILE · VERSION DE DÉMONSTRATION</Text>
  </ScrollView>
  {bar && <ActionBar actions={bar.actions} info={bar.info} />}
  {showFab && <Fab label="+ Facture préétablie" disabled={journalLoading || loading || storageError} onPress={() => { setJournalPick(null); setJournalAmount(''); setJournalSector(''); setJournalQuery(''); setScreen('journalAdd'); }} />}
  {showTabs && <TabBar current={screen} badges={{ history: pendingCount }} onSelect={next => { if (next === 'reference') setReferenceQuery(''); setScreen(next); }} />}
  </SafeAreaView>;
}
// Palette bleu nuit et turquoise fournie pour l’application.
const C = {
  paper: '#F4F5FA', card: '#FFFFFF', ink: '#0F1B3D', inkSoft: '#1B2A57', muted: '#5A6482', line: '#E6E9F5',
  primary: '#1B2A57', primaryDark: '#0F1B3D', mint: '#D9F5F0', amber: '#FFB020', amberSoft: '#FFF1CF', amberInk: '#7A4E0B',
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
  noticeLine: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.amberSoft, borderRadius: 14, paddingLeft: 14, marginBottom: 8 },
  noticeLineText: { flex: 1, color: C.amberInk, fontSize: 13, lineHeight: 18, paddingVertical: 9 },
  noticeClose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  noticeCloseText: { fontSize: 22, color: C.amberInk },
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
  // Barre d'action fixe, onglets, bouton flottant
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.98)', borderTopWidth: 1, borderTopColor: C.line, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 20, elevation: 14, shadowColor: '#0B3F38', shadowOpacity: 0.12, shadowRadius: 14, shadowOffset: { width: 0, height: -6 } },
  barInfo: { color: C.inkSoft, fontWeight: '800', fontSize: 13, textAlign: 'center', marginBottom: 8 },
  barRow: { flexDirection: 'row', gap: 10 },
  barCell: { flex: 1 },
  buttonCompact: { marginTop: 0 },
  tabbar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: C.line, paddingTop: 8, paddingBottom: 18, paddingHorizontal: 8, gap: 4, elevation: 16, shadowColor: '#0B3F38', shadowOpacity: 0.12, shadowRadius: 14, shadowOffset: { width: 0, height: -6 } },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 16 },
  tabActive: { backgroundColor: C.mint },
  tabIcon: { fontSize: 21 },
  tabLabel: { fontSize: 11, fontWeight: '700', color: C.muted, marginTop: 2 },
  tabLabelActive: { color: C.primaryDark, fontWeight: '800' },
  tabBadge: { position: 'absolute', top: 2, right: '22%', backgroundColor: C.coral, borderRadius: 999, minWidth: 18, height: 18, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  fab: { position: 'absolute', right: 16, bottom: 98, backgroundColor: C.amber, borderRadius: 999, paddingHorizontal: 22, height: 54, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 4, borderBottomColor: '#D98A00', elevation: 10, shadowColor: '#0B3F38', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
  fabText: { color: C.ink, fontWeight: '800', fontSize: 15, letterSpacing: 0.2 },

  // Listes d'actions
  menu: { backgroundColor: C.card, borderRadius: 22, borderWidth: 1, borderColor: C.line, marginTop: 12, overflow: 'hidden', ...shadow },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 14, minHeight: 62 },
  menuSep: { borderTopWidth: 1, borderTopColor: C.line },
  menuIcon: { width: 40, height: 40, borderRadius: 14, backgroundColor: C.mint, alignItems: 'center', justifyContent: 'center' },
  menuIconDanger: { backgroundColor: C.coralSoft },
  menuIconText: { fontSize: 19 },
  menuLabel: { color: C.ink, fontSize: 15, fontWeight: '700' },
  menuLabelDanger: { color: C.coralInk },
  menuHint: { color: C.muted, fontSize: 12, marginTop: 2 },
  badge: { backgroundColor: C.coral, borderRadius: 999, minWidth: 24, height: 24, paddingHorizontal: 7, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },

  // Pastilles, onglets segmentés, choix, boutons ronds, liens
  mini: { backgroundColor: C.mint, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10 },
  miniPrimary: { backgroundColor: C.primary },
  miniText: { color: C.primaryDark, fontWeight: '800', fontSize: 13 },
  miniTextPrimary: { color: '#FFFFFF' },
  miniRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  segmented: { flexDirection: 'row', backgroundColor: '#E9E3D3', borderRadius: 16, padding: 4, marginTop: 12 },
  seg: { flex: 1, alignItems: 'center', paddingVertical: 11, borderRadius: 12 },
  segActive: { backgroundColor: C.card, elevation: 2, shadowColor: '#0B3F38', shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  segText: { color: C.muted, fontWeight: '700', fontSize: 13 },
  segTextActive: { color: C.primaryDark, fontWeight: '800' },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.card, borderWidth: 2, borderColor: C.line, borderRadius: 18, padding: 16, marginTop: 10 },
  choiceActive: { borderColor: C.primary, backgroundColor: '#EEFAF4' },
  radio: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: '#B9C4BF', alignItems: 'center', justifyContent: 'center' },
  radioActive: { borderColor: C.primary },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: C.primary },
  choiceText: { color: C.inkSoft, fontWeight: '700', fontSize: 15, flex: 1 },
  choiceTextActive: { color: C.primaryDark, fontWeight: '800' },
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 3, borderBottomColor: C.primaryDark },
  roundText: { color: '#FFFFFF', fontSize: 24, fontWeight: '800', marginTop: -2 },
  link: { alignSelf: 'center', paddingVertical: 14, paddingHorizontal: 12, marginTop: 6 },
  linkText: { color: C.primary, fontWeight: '800', fontSize: 14 },
  linkDanger: { color: C.coralInk },

  // Facture préétablie : étapes, montant, choix du client, suivi du règlement
  step: { flexDirection: 'row', alignItems: 'center', marginTop: 24, marginBottom: 12 },
  stepNum: { width: 26, height: 26, borderRadius: 13, backgroundColor: C.amber, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  stepNumText: { color: C.ink, fontWeight: '800', fontSize: 13 },
  stepLabel: { color: C.inkSoft, fontWeight: '800', fontSize: 11.5, letterSpacing: 1.5 },
  amountCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 22, borderWidth: 2, borderColor: '#2DD4BF', paddingHorizontal: 18, ...shadow },
  amountInput: { flex: 1, height: 74, fontSize: 36, fontWeight: '800', color: C.ink, letterSpacing: -0.5 },
  amountUnit: { color: C.primary, fontSize: 20, fontWeight: '800', marginLeft: 8 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.card, borderRadius: 18, borderWidth: 2, borderColor: C.line, padding: 12, marginTop: 10 },
  pickRowActive: { borderColor: C.primary, backgroundColor: '#EEFAF4' },
  pickRowNote: { opacity: 0.7 },
  pickNote: { color: C.coralInk, fontSize: 12, fontWeight: '700', marginTop: 4 },
  avatar: { width: 44, height: 44, borderRadius: 16, backgroundColor: C.mint, alignItems: 'center', justifyContent: 'center' },
  avatarActive: { backgroundColor: C.primary },
  avatarText: { color: C.primaryDark, fontWeight: '800', fontSize: 15 },
  avatarTextActive: { color: '#FFFFFF' },
  clientHero: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: C.card, borderRadius: 22, borderWidth: 1, borderColor: C.line, padding: 14, marginBottom: 4, ...shadow },
  clientHeroName: { color: C.ink, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  clientHeroSector: { color: C.muted, fontSize: 13, marginTop: 2 },
  statRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  stat: { flex: 1, backgroundColor: C.card, borderRadius: 16, padding: 12 },
  statAmber: { backgroundColor: C.amberSoft },
  statLabel: { color: C.muted, fontSize: 11.5, fontWeight: '700' },
  statValue: { color: C.ink, fontSize: 15, fontWeight: '800', marginTop: 4 },
  progress: { height: 10, borderRadius: 5, backgroundColor: '#E4EDE8', overflow: 'hidden', marginVertical: 10 },
  progressFill: { height: 10, borderRadius: 5, backgroundColor: C.primary },
  pill: { color: C.primaryDark, backgroundColor: C.mint, borderRadius: 999, overflow: 'hidden', paddingHorizontal: 12, paddingVertical: 5, fontSize: 12.5, fontWeight: '800' },
  pillAmber: { color: C.amberInk, backgroundColor: C.amberSoft },
  pillCoral: { color: C.coralInk, backgroundColor: C.coralSoft },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.card, borderRadius: 18, borderWidth: 1, borderColor: C.line, padding: 14, marginTop: 14 },

  footer: { color: '#A3A89E', textAlign: 'center', fontSize: 10, letterSpacing: 1.8, fontWeight: '700', marginTop: 38 },
});
