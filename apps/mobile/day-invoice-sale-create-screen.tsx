/** Écran préparatoire non monté dans le parcours actif. La tentative et son
 * reçu sont conservés dans SQLite ; aucune erreur ne crée une seconde vente. */
import React,{useEffect,useRef,useState} from 'react';
import {StyleSheet,Text,TextInput,TouchableOpacity,View} from 'react-native';
import {randomUUID} from 'expo-crypto';
import {addSaleEditArticle,parseSaleEditLines,searchSaleEditArticles,type SaleEditArticle,type SaleEditDraftLine} from './day-invoice-sale-edit-input';
import {makeNewSaleAttempt,type NewSalePreview} from './day-invoice-sale-create-input';
import {startSaleAttempt,resumeSaleAttempt,finishSaleAttempt,abandonSaleAttempt,type SaleAttemptIO,type StoredSaleAttempt} from './day-invoice-sale-attempt-flow';
import type {SavedSale} from './storage';
type Line=SavedSale['lines'][number];
/** bindingKey must change when the bound commercial or server changes. */
type Props={bindingKey:string;clientId:string;clientName:string;day:string;articles:readonly SaleEditArticle[];capture:(clientId:string,day:string,lines:Line[])=>Promise<NewSalePreview>;attempts:SaleAttemptIO;onBack:()=>void;onSaved:()=>void;onAbandoned?:()=>void};
const money=(value:number)=>`${(value/1000).toFixed(3)} DT`;
export function DayInvoiceSaleCreateScreen({bindingKey,clientId,clientName,day,articles,capture,attempts,onBack,onSaved,onAbandoned}:Props){
 const [draft,setDraft]=useState<SaleEditDraftLine[]>([]),[query,setQuery]=useState(''),[preview,setPreview]=useState<NewSalePreview|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [loaded,setLoaded]=useState(false),[stored,setStored]=useState<StoredSaleAttempt|null>(null),[reload,setReload]=useState(0);
 const epoch=useRef(0),working=useRef(false),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;};},[]);
 useEffect(()=>{const current=++epoch.current;setLoaded(false);setStored(null);setPreview(null);setDraft([]);setQuery('');setError('');
  void attempts.read().then(value=>{if(mounted.current&&epoch.current===current){setStored(value);setLoaded(true);}},e=>{if(mounted.current&&epoch.current===current){setError(e instanceof Error?e.message:'Lecture de la tentative impossible.');setLoaded(false);}});
  return()=>{epoch.current++;};
 },[bindingKey,clientId,day,reload]);
 const locked=busy||!loaded||!!stored,other=!!stored&&(stored.attempt.clientId!==clientId||stored.attempt.day!==day);
 const change=(index:number,key:'quantity'|'discount',value:string)=>{if(locked||working.current)return;epoch.current++;setPreview(null);setError('');setDraft(items=>items.map((item,i)=>i===index?{...item,[key]:value}:item));};
 const remove=(index:number)=>{if(locked||working.current)return;epoch.current++;setPreview(null);setError('');setDraft(items=>items.filter((_,i)=>i!==index));};
 const add=(article:SaleEditArticle)=>{if(locked||working.current)return;try{const next=addSaleEditArticle(draft,article,articles);epoch.current++;setPreview(null);setDraft(next);setQuery('');setError('');}catch(e){setError(e instanceof Error?e.message:'Article invalide.');}};
 const showPreview=async()=>{if(locked||working.current)return;let lines:Line[];try{lines=parseSaleEditLines(draft);}catch(e){setError(e instanceof Error?e.message:'Articles invalides.');return;}
  working.current=true;setBusy(true);setPreview(null);setError('');const current=epoch.current;
  try{const value=await capture(clientId,day,lines);if(mounted.current&&epoch.current===current){if(value.clientId!==clientId||value.day!==day)throw Error('Client ou journée incohérent.');setPreview(value);}}catch(e){if(mounted.current&&epoch.current===current)setError(e instanceof Error?e.message:'Aperçu impossible.');}finally{working.current=false;if(mounted.current)setBusy(false);}
 };
 // Après toute erreur de transaction, seule une relecture peut déverrouiller
 // les champs : l'écriture a pu être commise malgré une réponse perdue.
 const run=async(work:(current:()=>boolean)=>Promise<void>)=>{if(working.current)return;working.current=true;setBusy(true);setError('');const current=epoch.current;
  try{await work(()=>mounted.current&&epoch.current===current);}catch(e){if(mounted.current&&epoch.current===current){setLoaded(false);setError(e instanceof Error?e.message:'Résultat inconnu : vérifiez la tentative.');}}
  finally{working.current=false;if(mounted.current)setBusy(false);}
 };
 const save=()=>{if(!preview||locked)return;let attempt;try{attempt=makeNewSaleAttempt(preview,new Date(),randomUUID);}catch(e){setPreview(null);setError(e instanceof Error?e.message:'Vente invalide.');return;}
  void run(async current=>{const result=await startSaleAttempt(attempts,attempt);if(current()){setStored(result);setPreview(null);}});
 };
 const resume=()=>{if(!stored||other||stored.result)return;void run(async current=>{const result=await resumeSaleAttempt(attempts,stored.attempt);if(current())setStored(result);});};
 const finish=()=>{if(!stored||other||!stored.result)return;void run(async current=>{await finishSaleAttempt(attempts,stored.attempt);if(current()){setStored(null);onSaved();}});};
 const cancel=()=>{if(!stored||other||stored.result)return;void run(async current=>{await abandonSaleAttempt(attempts,stored.attempt);if(current()){if(onAbandoned)onAbandoned();else{setStored(null);setPreview(null);setDraft([]);}}});};
 return <View style={styles.container}>
  <View style={styles.header}><TouchableOpacity accessibilityRole="button" accessibilityLabel="Retour" disabled={busy||!loaded} onPress={onBack}><Text style={styles.back}>‹</Text></TouchableOpacity><View style={{flex:1}}><Text style={styles.title}>Nouvelle vente</Text><Text style={styles.subtitle}>{clientName} · {day}</Text></View></View>
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  {!loaded&&<><Text style={styles.muted}>Vérification de la tentative enregistrée…</Text><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>setReload(n=>n+1)}><Text style={styles.link}>Vérifier à nouveau</Text></TouchableOpacity></>}
  {loaded&&stored&&<View style={styles.card}>{other?<Text style={styles.error}>Une vente attend vérification pour un autre client ou une autre journée ({stored.attempt.clientId} · {stored.attempt.day}). Revenez à cette vente avant d’en créer une nouvelle.</Text>:<><Text style={styles.name}>{stored.result?'Vente enregistrée':'Vente à confirmer'}</Text><Text style={styles.muted}>Tentative du {stored.attempt.createdAt} ; les mêmes identifiants seront conservés.</Text>{stored.result&&<Text style={styles.value}>Montant : {money(stored.result.sale.total)}</Text>}
   <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={stored.result?finish:resume} style={[styles.button,busy&&styles.disabled]}><Text style={styles.buttonText}>{stored.result?'Terminer':'Reprendre la confirmation'}</Text></TouchableOpacity>
   {!stored.result&&<TouchableOpacity accessibilityRole="button" disabled={busy} onPress={cancel}><Text style={styles.link}>Abandonner cette tentative non confirmée</Text></TouchableOpacity>}</>}
  </View>}
  {loaded&&!stored&&<><Text style={styles.muted}>Ajoutez les articles. La vente rejoint la facture du jour ; son règlement sera saisi séparément, sans choisir de composante.</Text>
   {draft.map((item,index)=><View key={`${item.line.code}-${index}`} style={styles.card}><Text style={styles.name}>{item.line.name}</Text><Text style={styles.muted}>{item.line.code}</Text><Text style={styles.label}>Quantité</Text><TextInput accessibilityLabel={`Quantité ${item.line.name}`} editable={!locked} keyboardType="number-pad" value={item.quantity} onChangeText={v=>change(index,'quantity',v)} style={styles.input}/><Text style={styles.label}>Remise (%)</Text><TextInput accessibilityLabel={`Remise ${item.line.name}`} editable={!locked} keyboardType="decimal-pad" value={item.discount} onChangeText={v=>change(index,'discount',v)} style={styles.input}/><TouchableOpacity accessibilityRole="button" disabled={locked} onPress={()=>remove(index)}><Text style={styles.link}>Retirer cet article</Text></TouchableOpacity></View>)}
   <Text style={styles.label}>Ajouter un article du catalogue</Text><TextInput accessibilityLabel="Rechercher un article" editable={!locked} value={query} onChangeText={setQuery} placeholder="Code ou nom" style={styles.input}/>
   {searchSaleEditArticles(articles,draft,query).map(article=><TouchableOpacity key={article.code} accessibilityRole="button" disabled={locked} onPress={()=>add(article)} style={styles.card}><Text style={styles.name}>{article.name}</Text><Text style={styles.muted}>{article.code} · {money(Number(article.saleTtc))} TTC</Text></TouchableOpacity>)}
   <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>{void showPreview();}} style={[styles.button,busy&&styles.disabled]}><Text style={styles.buttonText}>Vérifier la vente</Text></TouchableOpacity>
   {preview&&<View style={styles.card}><Text style={styles.label}>Vente sur place</Text><Text style={styles.value}>{money(preview.total)}</Text><Text style={styles.label}>Total de la facture du jour après ajout</Text><Text style={styles.total}>{money(preview.invoiceTotal)}</Text><Text style={styles.label}>Solde client avant / après</Text><Text style={styles.value}>{money(preview.balanceBefore)} / {money(preview.balanceAfter)}</Text><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={save} style={[styles.button,busy&&styles.disabled]}><Text style={styles.buttonText}>Confirmer la vente</Text></TouchableOpacity></View>}
  </>}
 </View>;
}
const styles=StyleSheet.create({container:{gap:12},header:{backgroundColor:'#0F1B3D',borderRadius:24,padding:16,flexDirection:'row',alignItems:'center',gap:12},back:{fontSize:30,color:'#FFFFFF'},title:{fontSize:21,fontWeight:'800',color:'#FFFFFF'},subtitle:{color:'#A3AECB'},card:{backgroundColor:'#FFFFFF',borderRadius:20,padding:16,gap:6},name:{fontWeight:'800',color:'#0F1B3D',fontSize:17},label:{color:'#506178',fontWeight:'600'},value:{color:'#0F1B3D',fontWeight:'700',fontSize:16},total:{color:'#0F1B3D',fontWeight:'800',fontSize:21},muted:{color:'#66758C',lineHeight:19},error:{color:'#A02D34',fontWeight:'700'},link:{color:'#087D73',fontWeight:'700'},input:{backgroundColor:'#FFFFFF',borderColor:'#B6C4CD',borderWidth:1,borderRadius:12,padding:12,color:'#0F1B3D'},button:{padding:15,borderRadius:14,backgroundColor:'#2DD4BF',alignItems:'center'},buttonText:{fontWeight:'800',color:'#0F1B3D'},disabled:{opacity:0.45}});
