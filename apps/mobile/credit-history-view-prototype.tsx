/** Historique local et révision v5 expérimentaux, non montés dans App.tsx. */
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Alert,ScrollView,StyleSheet,Text,TextInput,TouchableOpacity,View} from 'react-native';
import type {DeviceIdentity} from './identified-device';
import {getCreditHistoryPrototype,updateSale,getRemoteSaleEditCapturePrototype,getRemoteSaleEditPreviewPrototype,commitRemoteSaleEditPrototype,type SavedSale} from './storage';
import {randomUUID} from 'expo-crypto';
import type {RemoteSaleKey} from './credit-remote-sale-edit-prototype';
import {prepareCreditSaleEdit} from './credit-sale-edit-prototype';
import {calculateInvoice} from '@sls/domain';
import {unitPriceExcludingVat} from './reference';
type History=Awaited<ReturnType<typeof getCreditHistoryPrototype>>;
type Props={identity:DeviceIdentity;clientId:string;onBack:()=>void;onChanged:()=>void;refreshSources:((clientId:string)=>Promise<unknown>)|null};
const money=(n:number)=>`${(n/1000).toFixed(3)} DT`;
const percent=(text:string)=>{const m=/^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.trim());if(!m)throw Error('Remise invalide.');const n=Number(m[1])*100+Number((m[2]??'').padEnd(2,'0'));if(n>10000)throw Error('Remise supérieure à 100 %.');return n;};
type Line={line:SavedSale['lines'][number];quantity:string;discount:string};
export function CreditHistoryViewPrototype({identity,clientId,onBack,onChanged,refreshSources}:Props){
 const [history,setHistory]=useState<History|null>(null),[selected,setSelected]=useState<SavedSale|null>(null),[lines,setLines]=useState<Line[]>([]),[choice,setChoice]=useState<'refund'|'credit'|undefined>(),[query,setQuery]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [remote,setRemote]=useState<{key:RemoteSaleKey;expectedBalance:number}|null>(null);
 const mounted=useRef(false),lock=useRef(false),saved=useRef(false),generation=useRef(0);
 const load=async()=>{const seq=++generation.current;setBusy(true);setError('');try{const h=await getCreditHistoryPrototype(identity,clientId);if(mounted.current&&seq===generation.current)setHistory(h);}catch(e){if(mounted.current&&seq===generation.current){setHistory(null);setError(e instanceof Error?e.message:'Historique indisponible.');}}finally{if(mounted.current&&seq===generation.current)setBusy(false);}};
 useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;generation.current++;};},[identity.commercialId,identity.serverOrigin,clientId]);
 const parsed=useMemo(()=>{try{return lines.map(d=>{if(!/^\d+$/.test(d.quantity))throw Error('Quantité entière requise.');return {...d.line,quantity:Number(d.quantity),discount:percent(d.discount)};});}catch{return null;}},[lines]);
 const total=useMemo(()=>{try{return parsed?.length?calculateInvoice(parsed.map(l=>({quantity:l.quantity,unitPrice:l.unitPrice,discountRate:l.discount,vatRate:l.vat}))).total:null;}catch{return null;}},[parsed]);
 const refreshRemote=async()=>{if(lock.current||!refreshSources)return;lock.current=true;setBusy(true);setError('');try{await refreshSources(clientId);if(mounted.current)await load();}catch(e){if(mounted.current){setHistory(null);setError(e instanceof Error?e.message:'Sources indisponibles.');}}finally{lock.current=false;if(mounted.current)setBusy(false);}};
 const edit=(sale:SavedSale)=>{saved.current=false;setRemote(null);setSelected(sale);setChoice(undefined);setQuery('');setError('');setLines(sale.lines.map(line=>({line,quantity:String(line.quantity),discount:String(line.discount/100)})));};
 const editRemote=async(sale:History['remoteSales'][number])=>{if(lock.current||!history||history.client.balance===null)return;lock.current=true;setBusy(true);setError('');try{
  const key={clientId,invoiceId:sale.invoiceId,version:sale.version,hash:sale.hash},context={identity:{...identity},expectedBalance:history.client.balance};
  const capture=await getRemoteSaleEditCapturePrototype(context,key,new Date().toISOString());
  if(mounted.current){edit(capture.sale);setRemote({key,expectedBalance:context.expectedBalance});}
 }catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Facture distante indisponible.');}finally{lock.current=false;if(mounted.current)setBusy(false);}};
 const submit=async()=>{if(lock.current||saved.current||!selected||!history)return;lock.current=true;setBusy(true);setError('');try{
  if(!parsed||history.client.balance===null)throw Error('Quantité, remise ou solde invalide.');
  const context={identity:{...identity},expectedBalance:remote?.expectedBalance??history.client.balance};
  if(remote){
   const recordedAt=new Date().toISOString(),preview=await getRemoteSaleEditPreviewPrototype(context,remote.key,recordedAt,parsed,choice);
   await commitRemoteSaleEditPrototype({operationId:randomUUID(),context,key:remote.key,recordedAt,lines:parsed,choice,preview});saved.current=true;
   if(mounted.current){setSelected(null);onChanged();Alert.alert('Modification en attente','Synchronisez pour confirmer la modification. Le client concerné et la clôture restent bloqués entre-temps. Les autres clients restent disponibles.');onBack();}
  }else{
   const result=prepareCreditSaleEdit(history.client,context,selected,parsed,choice,history.articles);
   await updateSale(selected,result.updated,result.refund,context);saved.current=true;
   if(mounted.current){setSelected(null);onChanged();await load();}
  }
 }catch(e){if(mounted.current)setError(saved.current?'Modification enregistrée ; actualisez l’historique.':e instanceof Error?e.message:'Modification impossible.');}finally{lock.current=false;if(mounted.current)setBusy(false);}};
 const change=(i:number,update:Partial<Line>)=>setLines(current=>current.map((l,index)=>index===i?{...l,...update}:l));
 return <ScrollView contentContainerStyle={styles.container}>
  <Text style={styles.title}>{selected?(remote?'Modifier une vente synchronisée':'Modifier la vente'):'Historique local'} · {history?.client.name??''}</Text>
  <Text style={styles.notice}>Les détails et paiements locaux concernent ce téléphone. Les ventes d’autres appareils ne sont visibles qu’après récupération des sources. Les remboursements sont enregistrés, pas effectués par l’application.</Text>
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  {selected?<>
   {lines.map((d,i)=><View style={styles.card} key={d.line.code}><Text>{d.line.name} · {money(d.line.unitPrice)} HT · TVA {d.line.vat/100} %</Text><View style={styles.actions}><Text>Quantité</Text><TextInput accessibilityLabel={`Quantité ${d.line.name}`} keyboardType="number-pad" style={styles.input} value={d.quantity} onChangeText={v=>change(i,{quantity:v})}/><Text>Remise %</Text><TextInput accessibilityLabel={`Remise ${d.line.name}`} keyboardType="decimal-pad" style={styles.input} value={d.discount} onChangeText={v=>change(i,{discount:v})}/><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>setLines(v=>v.filter((_,j)=>j!==i))}><Text style={styles.link}>Retirer</Text></TouchableOpacity></View></View>)}
   <Text>Ancien total : {money(selected.total)} · déjà payé : {money(selected.paid)}</Text><Text style={styles.heading}>Nouveau total : {total===null?'—':money(total)}</Text>
   {total!==null&&selected.paid>total&&<><Text>Le client a payé {money(selected.paid-total)} de plus. Choisissez :</Text><View style={styles.actions}>{(['refund','credit'] as const).map(value=><TouchableOpacity key={value} accessibilityRole="button" accessibilityState={{selected:choice===value}} disabled={busy} onPress={()=>setChoice(value)}><Text style={styles.link}>{choice===value?'✓ ':''}{value==='refund'?'Rembourser':'Conserver en crédit client'}</Text></TouchableOpacity>)}</View></>}
   {selected.lines.filter(old=>!lines.some(d=>d.line.code===old.code)).map(old=><TouchableOpacity key={`restore:${old.code}`} accessibilityRole="button" disabled={busy} style={styles.card} onPress={()=>setLines(current=>[...current,{line:{...old},quantity:String(old.quantity),discount:String(old.discount/100)}])}><Text>Rétablir {old.name} · prix de la facture d’origine</Text></TouchableOpacity>)}
   <Text style={styles.heading}>Ajouter un article</Text><TextInput accessibilityLabel="Rechercher un article à ajouter" style={styles.input} value={query} onChangeText={setQuery} placeholder="Nom, code ou code-barres"/>
   {history?.articles.filter(a=>!selected.lines.some(l=>l.code===a.code)&&!lines.some(l=>l.line.code===a.code)&&`${a.name} ${a.code} ${a.barcode}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0,25).map(a=><TouchableOpacity key={a.id} accessibilityRole="button" disabled={busy} style={styles.card} onPress={()=>setLines(current=>[...current,{line:{name:a.name,code:a.code,quantity:1,unitPrice:unitPriceExcludingVat(a.saleTtc,a.vatRate),discount:0,vat:a.vatRate},quantity:'1',discount:'0'}])}><Text>{a.name} · {a.code} · {money(Number(a.saleTtc))} TTC · Ajouter</Text></TouchableOpacity>)}
   <Text>Les nouveaux articles utilisent les prix du catalogue connu ; le prix est revérifié à l’enregistrement.</Text><View style={styles.actions}><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>void submit()} style={styles.button}><Text style={styles.buttonText}>{busy?'Enregistrement…':'Enregistrer'}</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>{setSelected(null);setRemote(null);setError('');}}><Text style={styles.link}>Annuler</Text></TouchableOpacity></View>
  </>:<>
   <View style={styles.actions}><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onBack}><Text style={styles.link}>Retour</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={()=>void load()}><Text style={styles.link}>Actualiser</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={busy||!refreshSources} onPress={()=>void refreshRemote()}><Text style={styles.link}>Récupérer les ventes synchronisées</Text></TouchableOpacity></View>
   {!history&&<Text>{busy?'Chargement…':'Historique indisponible.'}</Text>}
   {history&&<><Text style={styles.heading}>Ventes sur ce téléphone</Text>{history.sales.length===0&&<Text>Aucune vente locale.</Text>}{history.sales.map(({sale,revisions,editable,blocked})=><View key={sale.id} style={styles.card}><Text style={styles.heading}>Vente · {sale.createdAt.slice(0,10)} · {money(sale.total)}</Text><Text>Payé : {money(sale.paid)} · {sale.paymentMode}</Text>{blocked&&<Text>Modification indisponible : {blocked==='avoir-existant'?'facture annulée':'rapprochement nécessaire'}.</Text>}<TouchableOpacity accessibilityRole="button" disabled={busy||!editable} onPress={()=>edit(sale)}><Text style={styles.link}>{editable?'Modifier':'Modification indisponible'}</Text></TouchableOpacity>{revisions.map(r=><Text key={r.id}>{r.createdAt.slice(0,10)} · {money(r.previous.total)} → {money(r.current.total)}{r.refund?` · remboursement ${money(r.refund)}`:''}</Text>)}</View>)}
    <Text style={styles.heading}>Ventes synchronisées d’autres appareils</Text>{!history.remoteAvailable?<Text>Sources non récupérées. Connectez-vous puis récupérez les ventes synchronisées.</Text>:history.remoteSales.length===0?<Text>Aucune vente distante disponible dans le cache.</Text>:history.remoteSales.map(s=><View key={s.invoiceId} style={styles.card}><Text style={styles.heading}>{s.invoiceDay} · {money(s.total)}</Text><Text>Payé : {money(s.paid)} · version {s.version}</Text><Text>Vente d’un autre appareil · mise à jour après synchronisation.</Text>{s.blocked&&<Text>Rapprochement nécessaire.</Text>}<TouchableOpacity accessibilityRole="button" disabled={busy||!!s.blocked||history.client.conflict||history.client.balance===null} onPress={()=>void editRemote(s)}><Text style={styles.link}>Modifier cette vente</Text></TouchableOpacity></View>)}
    <Text style={styles.heading}>Règlements de dette locaux</Text>{history.settlements.length===0&&<Text>Aucun règlement local.</Text>}{history.settlements.map(p=><Text key={p.id}>{p.createdAt.slice(0,10)} · {money(p.amount)} · {p.mode}</Text>)}
    <Text style={styles.heading}>Paiements du journal locaux</Text>{history.receipts.length===0&&<Text>Aucun paiement local.</Text>}{history.receipts.map(p=><Text key={p.id}>{p.createdAt.slice(0,10)} · facture {money(p.prePaid)} · ancienne dette {money(p.oldDebtPaid)} · {p.mode}{p.creditFull?' · crédit total':''}</Text>)}
   </>}
  </>}
 </ScrollView>;
}
const styles=StyleSheet.create({container:{padding:16,gap:12},title:{fontSize:20,fontWeight:'700',color:'#173c32'},heading:{fontSize:16,fontWeight:'700'},notice:{backgroundColor:'#fff4de',padding:10,borderRadius:8,color:'#89511e'},error:{backgroundColor:'#ffebe8',padding:10,borderRadius:8,color:'#842c23'},card:{backgroundColor:'#fff',borderRadius:10,padding:12,gap:7},actions:{flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:12},input:{backgroundColor:'#fff',borderWidth:1,borderColor:'#c5d7cc',padding:8,borderRadius:8,minWidth:60},link:{color:'#176745',fontWeight:'700',paddingVertical:8},button:{backgroundColor:'#176745',padding:14,borderRadius:10},buttonText:{color:'#fff',fontWeight:'700'}});
