/** Écran d'édition v6 préparatoire : ne pas monter dans le parcours hérité. */
import React,{useEffect,useRef,useState} from 'react';
import {StyleSheet,Text,TextInput,TouchableOpacity,View} from 'react-native';
import type {SavedSale} from './storage';
import type {captureDayInvoiceSaleEdit} from './day-invoice-sale-edit';
import {draftSaleLines,parseSaleEditLines,searchSaleEditArticles,addSaleEditArticle,type SaleEditDraftLine,type SaleEditArticle} from './day-invoice-sale-edit-input';

type Line=SavedSale['lines'][number];
type Preview=Awaited<ReturnType<typeof captureDayInvoiceSaleEdit>>;
type Props={sale:SavedSale;articles:readonly SaleEditArticle[];capture:(saleId:number,lines:Line[])=>Promise<Preview>;confirm:(input:{saleId:number;lines:Line[];fingerprint:string;recordedAt:string})=>Promise<unknown>;onBack:()=>void;onSaved:()=>void};
const money=(n:number)=>`${(n/1000).toFixed(3)} DT`;
export function DayInvoiceSaleEditScreen({sale,articles,capture,confirm,onBack,onSaved}:Props){
 const [draft,setDraft]=useState<SaleEditDraftLine[]>(()=>draftSaleLines(sale.lines));
 const [query,setQuery]=useState('');
 const [preview,setPreview]=useState<Preview|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const epoch=useRef(0),working=useRef(false),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;};},[]);
 useEffect(()=>{epoch.current++;setDraft(draftSaleLines(sale.lines));setQuery('');setPreview(null);setError('');},[sale.id,sale.syncVersion]);
 const change=(index:number,key:'quantity'|'discount',value:string)=>{epoch.current++;setPreview(null);setError('');setDraft(items=>items.map((item,i)=>i===index?{...item,[key]:value}:item));};
 const remove=(index:number)=>{epoch.current++;setPreview(null);setError('');setDraft(items=>items.filter((_,i)=>i!==index));};
 const add=(article:SaleEditArticle)=>{try{const next=addSaleEditArticle(draft,article,articles,sale.lines);epoch.current++;setPreview(null);setDraft(next);setQuery('');setError('');}catch(e){setError(e instanceof Error?e.message:'Article invalide.');}};
 const showPreview=async()=>{if(working.current)return;let lines:Line[];try{lines=parseSaleEditLines(draft);}catch(e){setError(e instanceof Error?e.message:'Articles invalides.');return;}
  working.current=true;setBusy(true);setPreview(null);setError('');const current=epoch.current;
  try{const value=await capture(sale.id,lines);if(mounted.current&&epoch.current===current)setPreview(value);}catch(e){if(mounted.current&&epoch.current===current)setError(e instanceof Error?e.message:'Aperçu impossible.');}finally{working.current=false;if(mounted.current)setBusy(false);}
 };
 const save=async()=>{if(working.current||!preview||preview.assessment.requiresChoice)return;working.current=true;setBusy(true);setError('');const current=epoch.current;
  try{await confirm({saleId:sale.id,lines:preview.lines,fingerprint:preview.fingerprint,recordedAt:new Date().toISOString()});if(mounted.current&&epoch.current===current){setPreview(null);onSaved();}}
  catch(e){if(mounted.current&&epoch.current===current){setPreview(null);setError(e instanceof Error?e.message:'Modification impossible.');}}
  finally{working.current=false;if(mounted.current)setBusy(false);}
 };
 return <View style={styles.container}>
  <View style={styles.header}><TouchableOpacity accessibilityRole="button" accessibilityLabel="Retour" disabled={busy} onPress={onBack}><Text style={styles.back}>‹</Text></TouchableOpacity><View style={{flex:1}}><Text style={styles.title}>Modifier la vente</Text><Text style={styles.subtitle}>{sale.clientName}</Text></View></View>
  <Text style={styles.muted}>Modifiez les quantités ou remises, retirez ou ajoutez un article. Les prix déjà enregistrés ne sont pas modifiés.</Text>
  {draft.map((item,index)=><View key={`${item.line.code}-${index}`} style={styles.card}><Text style={styles.name}>{item.line.name}</Text><Text style={styles.muted}>{item.line.code}</Text><Text style={styles.label}>Quantité</Text><TextInput accessibilityLabel={`Quantité ${item.line.name}`} editable={!busy} keyboardType="number-pad" value={item.quantity} onChangeText={v=>change(index,'quantity',v)} style={styles.input}/><Text style={styles.label}>Remise (%)</Text><TextInput accessibilityLabel={`Remise ${item.line.name}`} editable={!busy} keyboardType="decimal-pad" value={item.discount} onChangeText={v=>change(index,'discount',v)} style={styles.input}/><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>remove(index)}><Text style={styles.link}>Retirer cet article</Text></TouchableOpacity></View>)}
  <Text style={styles.label}>Ajouter un article du catalogue</Text><TextInput accessibilityLabel="Rechercher un article" editable={!busy} value={query} onChangeText={setQuery} placeholder="Code ou nom" style={styles.input}/>
  {searchSaleEditArticles(articles,draft,query).map(article=><TouchableOpacity key={article.code} accessibilityRole="button" disabled={busy} onPress={()=>add(article)} style={styles.card}><Text style={styles.name}>{article.name}</Text><Text style={styles.muted}>{article.code}{sale.lines.some(line=>line.code===article.code)?" · Prix initial conservé":` · ${money(Number(article.saleTtc))} TTC`}</Text></TouchableOpacity>)}
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  <TouchableOpacity accessibilityRole="button" disabled={busy} accessibilityState={{disabled:busy}} onPress={()=>{void showPreview();}} style={[styles.button,busy&&styles.disabled]}><Text style={styles.buttonText}>Vérifier la modification</Text></TouchableOpacity>
  {preview&&<View style={styles.card}><Text style={styles.label}>Facture du jour avant modification</Text><Text style={styles.value}>{money(preview.assessment.previousTotal)}</Text><Text style={styles.label}>Facture du jour après modification</Text><Text style={styles.total}>{money(preview.assessment.total)}</Text><Text style={styles.label}>Déjà payé</Text><Text style={styles.value}>{money(preview.assessment.paid)}</Text><Text style={styles.label}>Reste à payer</Text><Text style={styles.value}>{money(preview.assessment.remaining)}</Text><Text style={styles.label}>Solde client après modification</Text><Text style={styles.value}>{money(preview.balanceAfter)}</Text>
   {preview.assessment.requiresChoice?<Text style={styles.error}>Trop-perçu : {money(preview.assessment.excess)}. Le choix remboursement ou crédit n’est pas encore disponible ; la modification ne peut pas être enregistrée.</Text>:<TouchableOpacity accessibilityRole="button" disabled={busy} accessibilityState={{disabled:busy}} onPress={()=>{void save();}} style={[styles.button,busy&&styles.disabled]}><Text style={styles.buttonText}>{busy?'Enregistrement…':'Confirmer la modification'}</Text></TouchableOpacity>}
  </View>}
 </View>;
}
const styles=StyleSheet.create({container:{gap:12},header:{backgroundColor:'#0F1B3D',borderRadius:24,padding:16,flexDirection:'row',alignItems:'center',gap:12},back:{fontSize:30,color:'#FFFFFF'},title:{fontSize:21,fontWeight:'800',color:'#FFFFFF'},subtitle:{color:'#A3AECB'},card:{backgroundColor:'#FFFFFF',borderRadius:20,padding:16,gap:6},name:{fontWeight:'800',color:'#0F1B3D',fontSize:17},label:{color:'#506178',fontWeight:'600'},value:{color:'#0F1B3D',fontWeight:'700',fontSize:16},total:{color:'#0F1B3D',fontWeight:'800',fontSize:21},muted:{color:'#66758C',lineHeight:19},error:{color:'#A02D34',fontWeight:'700'},link:{color:'#087D73',fontWeight:'700'},input:{backgroundColor:'#FFFFFF',borderColor:'#B6C4CD',borderWidth:1,borderRadius:12,padding:12,color:'#0F1B3D'},button:{padding:15,borderRadius:14,backgroundColor:'#2DD4BF',alignItems:'center'},buttonText:{fontWeight:'800',color:'#0F1B3D'},disabled:{opacity:0.45}});
