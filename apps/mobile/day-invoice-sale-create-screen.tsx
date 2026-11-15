/** Écran préparatoire non monté : la tentative de confirmation est en mémoire
 * pendant son montage uniquement et exige une reprise durable avant activation. */
import React,{useEffect,useRef,useState} from 'react';
import {StyleSheet,Text,TextInput,TouchableOpacity,View} from 'react-native';
import {randomUUID} from 'expo-crypto';
import {addSaleEditArticle,parseSaleEditLines,searchSaleEditArticles,type SaleEditArticle,type SaleEditDraftLine} from './day-invoice-sale-edit-input';
import {makeNewSaleAttempt,type NewSalePreview,type NewSaleAttempt} from './day-invoice-sale-create-input';
import type {SavedSale} from './storage';
type Line=SavedSale['lines'][number];
type Props={clientId:string;clientName:string;day:string;articles:readonly SaleEditArticle[];capture:(clientId:string,day:string,lines:Line[])=>Promise<NewSalePreview>;confirm:(input:NewSaleAttempt)=>Promise<unknown>;onBack:()=>void;onSaved:()=>void};
const money=(value:number)=>`${(value/1000).toFixed(3)} DT`;
export function DayInvoiceSaleCreateScreen({clientId,clientName,day,articles,capture,confirm,onBack,onSaved}:Props){
 const [draft,setDraft]=useState<SaleEditDraftLine[]>([]),[query,setQuery]=useState(''),[preview,setPreview]=useState<NewSalePreview|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false);
 const epoch=useRef(0),working=useRef(false),mounted=useRef(true),attempt=useRef<NewSaleAttempt|null>(null);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;};},[]);
 useEffect(()=>{epoch.current++;if(!attempt.current){setDraft([]);setQuery('');setPreview(null);setError('');}},[clientId,day]);
 const locked=busy||uncertain;
 const change=(index:number,key:'quantity'|'discount',value:string)=>{if(working.current||attempt.current)return;epoch.current++;setPreview(null);setError('');setDraft(items=>items.map((item,i)=>i===index?{...item,[key]:value}:item));};
 const remove=(index:number)=>{if(working.current||attempt.current)return;epoch.current++;setPreview(null);setError('');setDraft(items=>items.filter((_,i)=>i!==index));};
 const add=(article:SaleEditArticle)=>{if(working.current||attempt.current)return;try{const next=addSaleEditArticle(draft,article,articles);epoch.current++;setPreview(null);setDraft(next);setQuery('');setError('');}catch(e){setError(e instanceof Error?e.message:'Article invalide.');}};
 const showPreview=async()=>{if(working.current||attempt.current)return;let lines:Line[];try{lines=parseSaleEditLines(draft);}catch(e){setError(e instanceof Error?e.message:'Articles invalides.');return;}
  working.current=true;setBusy(true);setPreview(null);setError('');const current=epoch.current;
  try{const value=await capture(clientId,day,lines);if(mounted.current&&epoch.current===current){if(value.clientId!==clientId||value.day!==day)throw Error('Client ou journée incohérent.');setPreview(value);}}catch(e){if(mounted.current&&epoch.current===current)setError(e instanceof Error?e.message:'Aperçu impossible.');}finally{working.current=false;if(mounted.current)setBusy(false);}
 };
 const save=async()=>{if(working.current||!preview)return;
  if(!attempt.current){try{attempt.current=makeNewSaleAttempt(preview,new Date(),randomUUID);}catch(e){setPreview(null);setError(e instanceof Error?e.message:'Vente invalide.');return;}}
  if(attempt.current.clientId!==clientId||attempt.current.day!==day){setUncertain(true);setError('Client ou journée modifié : rapprochement nécessaire.');return;}
  working.current=true;setBusy(true);setError('');let saved=false;
  try{await confirm(attempt.current);saved=true;}catch(e){if(mounted.current){setUncertain(true);setError(e instanceof Error?e.message:'Résultat inconnu.');}}
  finally{working.current=false;if(mounted.current)setBusy(false);}
  if(saved&&mounted.current){attempt.current=null;setUncertain(false);setPreview(null);onSaved();}
 };
 return <View style={styles.container}>
  <View style={styles.header}><TouchableOpacity accessibilityRole="button" accessibilityLabel="Retour" disabled={locked} onPress={onBack}><Text style={styles.back}>‹</Text></TouchableOpacity><View style={{flex:1}}><Text style={styles.title}>Nouvelle vente</Text><Text style={styles.subtitle}>{clientName} · {day}</Text></View></View>
  <Text style={styles.muted}>Ajoutez les articles. La vente rejoint la facture du jour ; son règlement sera saisi séparément, sans choisir de composante.</Text>
  {draft.map((item,index)=><View key={`${item.line.code}-${index}`} style={styles.card}><Text style={styles.name}>{item.line.name}</Text><Text style={styles.muted}>{item.line.code}</Text><Text style={styles.label}>Quantité</Text><TextInput accessibilityLabel={`Quantité ${item.line.name}`} editable={!locked} keyboardType="number-pad" value={item.quantity} onChangeText={v=>change(index,'quantity',v)} style={styles.input}/><Text style={styles.label}>Remise (%)</Text><TextInput accessibilityLabel={`Remise ${item.line.name}`} editable={!locked} keyboardType="decimal-pad" value={item.discount} onChangeText={v=>change(index,'discount',v)} style={styles.input}/><TouchableOpacity accessibilityRole="button" disabled={locked} onPress={()=>remove(index)}><Text style={styles.link}>Retirer cet article</Text></TouchableOpacity></View>)}
  <Text style={styles.label}>Ajouter un article du catalogue</Text><TextInput accessibilityLabel="Rechercher un article" editable={!locked} value={query} onChangeText={setQuery} placeholder="Code ou nom" style={styles.input}/>
  {searchSaleEditArticles(articles,draft,query).map(article=><TouchableOpacity key={article.code} accessibilityRole="button" disabled={locked} onPress={()=>add(article)} style={styles.card}><Text style={styles.name}>{article.name}</Text><Text style={styles.muted}>{article.code} · {money(Number(article.saleTtc))} TTC</Text></TouchableOpacity>)}
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  {!uncertain&&<TouchableOpacity accessibilityRole="button" disabled={busy} accessibilityState={{disabled:busy}} onPress={()=>{void showPreview();}} style={[styles.button,busy&&styles.disabled]}><Text style={styles.buttonText}>Vérifier la vente</Text></TouchableOpacity>}
  {preview&&<View style={styles.card}><Text style={styles.label}>Vente sur place</Text><Text style={styles.value}>{money(preview.total)}</Text><Text style={styles.label}>Total de la facture du jour après ajout</Text><Text style={styles.total}>{money(preview.invoiceTotal)}</Text><Text style={styles.label}>Solde client avant / après</Text><Text style={styles.value}>{money(preview.balanceBefore)} / {money(preview.balanceAfter)}</Text>
   <TouchableOpacity accessibilityRole="button" disabled={busy} accessibilityState={{disabled:busy}} onPress={()=>{void save();}} style={[styles.button,busy&&styles.disabled]}><Text style={styles.buttonText}>{busy?'Enregistrement…':uncertain?'Reprendre la même vente':'Confirmer la vente'}</Text></TouchableOpacity>
   {uncertain&&<Text style={styles.error}>Résultat incertain : reprenez la même vente. Ne créez pas une nouvelle opération avant vérification.</Text>}
  </View>}
 </View>;
}
const styles=StyleSheet.create({container:{gap:12},header:{backgroundColor:'#0F1B3D',borderRadius:24,padding:16,flexDirection:'row',alignItems:'center',gap:12},back:{fontSize:30,color:'#FFFFFF'},title:{fontSize:21,fontWeight:'800',color:'#FFFFFF'},subtitle:{color:'#A3AECB'},card:{backgroundColor:'#FFFFFF',borderRadius:20,padding:16,gap:6},name:{fontWeight:'800',color:'#0F1B3D',fontSize:17},label:{color:'#506178',fontWeight:'600'},value:{color:'#0F1B3D',fontWeight:'700',fontSize:16},total:{color:'#0F1B3D',fontWeight:'800',fontSize:21},muted:{color:'#66758C',lineHeight:19},error:{color:'#A02D34',fontWeight:'700'},link:{color:'#087D73',fontWeight:'700'},input:{backgroundColor:'#FFFFFF',borderColor:'#B6C4CD',borderWidth:1,borderRadius:12,padding:12,color:'#0F1B3D'},button:{padding:15,borderRadius:14,backgroundColor:'#2DD4BF',alignItems:'center'},buttonText:{fontWeight:'800',color:'#0F1B3D'},disabled:{opacity:0.45}});
