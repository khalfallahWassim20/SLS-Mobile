/** Composition de bout en bout uniquement pour une installation et un serveur
 * fictifs isolés. Aucun chemin n'ouvre ou migre la base mobile normale. */
import React,{useEffect,useRef,useState} from 'react';
import {SafeAreaView,ScrollView,StyleSheet,Text,TextInput,TouchableOpacity,View} from 'react-native';
import type {CommercialSession} from './commercial-login';
import {validSession} from './secure-commercial-session';
import {connectIsolatedDayInvoice} from './day-invoice-isolated-connect';
import {DAY_INVOICE_TEST_ACK} from './day-invoice-isolated-mode';
import {DayInvoiceWorkspace} from './day-invoice-workspace';
import {tunisDay} from './journal';
import {getBoundIdentity,readIsolatedDayInvoiceSetupStorage,initializeIsolatedDayInvoiceStorage,synchronizeDayInvoiceStoragePrototype,synchronizeCompensationTestPrototype,reconcileCompensatedInvoiceTestPrototype,readCompensatedJournalTestPrototype,closeDayInvoiceStoragePrototype} from './storage';
type Setup=NonNullable<Awaited<ReturnType<typeof readIsolatedDayInvoiceSetupStorage>>>;
export function DayInvoiceIsolatedApp(){
 const [setup,setSetup]=useState<Setup|null>(null),[ready,setReady]=useState(false),[session,setSession]=useState<CommercialSession|null>(null),[address,setAddress]=useState(''),[login,setLogin]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[day,setDay]=useState(()=>tunisDay(new Date())),[loginOpen,setLoginOpen]=useState(false);
 const mounted=useRef(false),running=useRef(false),generation=useRef(0),live=useRef<CommercialSession|null>(null);
 useEffect(()=>{mounted.current=true;void readIsolatedDayInvoiceSetupStorage().then(value=>{if(mounted.current){setSetup(value);if(value)setAddress(value.identity.serverOrigin);setReady(true);}}).catch(e=>{if(mounted.current){setError(e instanceof Error?e.message:'Stockage indisponible.');setReady(true);}});return()=>{mounted.current=false;generation.current++;live.current=null;};},[]);
 useEffect(()=>{if(!session)return;const delay=Math.max(0,Date.parse(session.expiresAt)-Date.now());const timer=setTimeout(()=>{if(live.current?.token===session.token){live.current=null;setSession(null);setLoginOpen(true);setError('Session expirée : les données locales restent disponibles hors ligne. Reconnectez-vous pour synchroniser.');}},Math.min(delay,2147483647));return()=>clearTimeout(timer);},[session]);
 const current=(s:CommercialSession)=>!!mounted.current&&live.current?.token===s.token&&live.current.id===s.id&&live.current.serverOrigin===s.serverOrigin&&live.current.expiresAt===s.expiresAt;
 const unauthorized=(s:CommercialSession)=>{if(current(s)){live.current=null;setSession(null);setLoginOpen(true);setError('Session refusée : reconnectez-vous. Les opérations locales sont conservées.');}};
 const connect=async()=>{
  if(running.current||!ready)return;running.current=true;setBusy(true);setError('');const g=++generation.current,secret=password;setPassword('');
  try{
   const result=await connectIsolatedDayInvoice(address,login,secret,{request:fetch,readIdentity:getBoundIdentity,readSetup:readIsolatedDayInvoiceSetupStorage,initialize:initializeIsolatedDayInvoiceStorage,isCurrent:()=>mounted.current&&generation.current===g});
   live.current=result.session;setSession(result.session);setSetup(result.setup);setAddress(result.session.serverOrigin);setLoginOpen(false);
  }catch(e){if(mounted.current&&generation.current===g)setError(e instanceof Error?e.message:'Connexion impossible.');}
  finally{running.current=false;if(mounted.current)setBusy(false);}
 };
 const required=()=>{const s=live.current;if(!setup||!s||!current(s)||!validSession(s,setup.identity))throw Error('Reconnectez le commercial pour synchroniser ; les opérations locales sont conservées.');return s;};
 const sync=async()=>{if(!setup)throw Error('Liaison indisponible.');const s=required();await synchronizeDayInvoiceStoragePrototype(setup.identity,s,setup.pin,()=>current(s),()=>unauthorized(s),true);};
 const syncCompensation=async()=>{if(!setup)throw Error('Liaison indisponible.');const s=required();await synchronizeCompensationTestPrototype(setup.identity,s,setup.pin,()=>current(s),()=>unauthorized(s),DAY_INVOICE_TEST_ACK,true);};
 const reconcile=async()=>{if(!setup)throw Error('Liaison indisponible.');const s=required();return reconcileCompensatedInvoiceTestPrototype(setup.identity,s,setup.pin,()=>current(s),()=>unauthorized(s),DAY_INVOICE_TEST_ACK,true);};
 const journal=async()=>{if(!setup)throw Error('Liaison indisponible.');const s=required();return readCompensatedJournalTestPrototype(setup.identity,s,setup.pin,()=>current(s),()=>unauthorized(s),DAY_INVOICE_TEST_ACK,true);};
 const close=async()=>{if(!setup)throw Error('Liaison indisponible.');const s=required();await closeDayInvoiceStoragePrototype(setup.identity,day,s,setup.pin,()=>current(s),()=>unauthorized(s),true);};
 const signOut=()=>{generation.current++;live.current=null;setSession(null);setLoginOpen(true);setError('Session fermée. Les opérations locales sont conservées.');};
 return <SafeAreaView style={styles.safe}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.top}>
  <Text style={styles.title}>Facture du jour · données fictives</Text><Text style={styles.notice}>Banc isolé : stockage séparé, serveur de test obligatoire. Ce parcours n'est pas disponible pour les données réelles.</Text>
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  {!ready&&<Text>Lecture de la liaison…</Text>}
  {ready&&setup&&<><Text style={styles.text}>{setup.name} · {session?'session active':'hors ligne / session absente'}</Text><Text style={styles.text}>Journée : {day}</Text><View style={styles.row}><TouchableOpacity disabled={busy} onPress={()=>setLoginOpen(x=>!x)}><Text style={styles.link}>{session?'Changer la session':'Se reconnecter'}</Text></TouchableOpacity>{session&&<TouchableOpacity disabled={busy} onPress={signOut}><Text style={styles.link}>Déconnexion</Text></TouchableOpacity>}<TouchableOpacity disabled={busy} onPress={()=>setDay(tunisDay(new Date()))}><Text style={styles.link}>Aujourd'hui</Text></TouchableOpacity></View></>}
  {ready&&(!setup||loginOpen)&&<View style={styles.card}><Text style={styles.text}>Connexion au serveur fictif</Text><TextInput accessibilityLabel="Adresse du serveur de test" autoCapitalize="none" editable={!busy&&!setup} value={address} onChangeText={setAddress} placeholder="http://adresse-du-serveur:3001" style={styles.input}/><TextInput accessibilityLabel="Identifiant commercial" autoCapitalize="none" editable={!busy} value={login} onChangeText={setLogin} placeholder="Identifiant" style={styles.input}/><TextInput accessibilityLabel="Mot de passe" secureTextEntry editable={!busy} value={password} onChangeText={setPassword} placeholder="Mot de passe" style={styles.input}/><TouchableOpacity accessibilityRole="button" disabled={busy} style={styles.button} onPress={()=>{void connect();}}><Text style={styles.buttonText}>{busy?'Connexion…':'Se connecter'}</Text></TouchableOpacity></View>}
 </ScrollView>{ready&&setup&&<DayInvoiceWorkspace identity={setup.identity} day={day} commercial={setup.name} onSynchronize={sync} onClose={close} compensationTestOnly={DAY_INVOICE_TEST_ACK} onSynchronizeCompensation={syncCompensation} onReconcileCompensation={reconcile} onReadCompensatedJournal={journal}/>}</SafeAreaView>;
}
const styles=StyleSheet.create({safe:{flex:1,backgroundColor:'#F2F6F7'},top:{padding:16,gap:8},title:{fontWeight:'800',fontSize:20,color:'#0F1B3D'},notice:{color:'#506178'},text:{color:'#0F1B3D'},error:{color:'#A02D34',fontWeight:'700'},row:{flexDirection:'row',flexWrap:'wrap',gap:20},link:{color:'#087D73',fontWeight:'700'},card:{backgroundColor:'#FFFFFF',borderRadius:16,padding:12,gap:8},input:{borderColor:'#B6C4CD',borderWidth:1,borderRadius:10,padding:10},button:{backgroundColor:'#2DD4BF',borderRadius:12,padding:12,alignItems:'center'},buttonText:{color:'#0F1B3D',fontWeight:'800'}});
