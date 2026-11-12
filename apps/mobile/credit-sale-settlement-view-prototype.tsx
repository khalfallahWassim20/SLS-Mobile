/** Formulaires v5 préparatoires, non activés dans App.tsx. */
import React,{useMemo,useRef,useState} from 'react';
import {ScrollView,StyleSheet,Text,TextInput,TouchableOpacity,View} from 'react-native';
import {calculateInvoice} from '@sls/domain';
import {unitPriceExcludingVat} from './reference';
import {saveSale,saveSettlement} from './storage';
import type {CreditWriteContext} from './credit-note-write-guard-prototype';
import {prepareCreditSale,prepareCreditSettlement,type CreditFormArticle,type CreditFormClient,type CreditPayment} from './credit-sale-settlement-prototype';

type Draft={article:CreditFormArticle;quantity:number;discount:string};
type Props={kind:'sale'|'settlement';client:CreditFormClient;context:CreditWriteContext;articles:CreditFormArticle[];onDone:()=>void;onCancel:()=>void};
const money=(v:number)=>`${(v/1000).toFixed(3)} DT`;
const discount=(value:string)=>{const m=/^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(value.trim());if(!m)throw Error('Remise invalide : indiquez un pourcentage entre 0 et 100.');const result=Number(m[1])*100+Number((m[2]??'').padEnd(2,'0'));if(result>10000)throw Error('Remise supérieure à 100 %.');return result;};
export function CreditSaleSettlementViewPrototype({kind,client,context,articles,onDone,onCancel}:Props){
 const [query,setQuery]=useState(''),[cart,setCart]=useState<Draft[]>([]),[mode,setMode]=useState<CreditPayment['mode']>('Espèces'),[paid,setPaid]=useState('0'),[number,setNumber]=useState(''),[bank,setBank]=useState(''),[due,setDue]=useState(''),[busy,setBusy]=useState(false),[complete,setComplete]=useState(false),[error,setError]=useState('');
 const lock=useRef(false),saved=useRef(false);
 const found=useMemo(()=>{const q=query.trim().toLocaleLowerCase();return articles.filter(a=>`${a.name} ${a.code} ${a.barcode}`.toLocaleLowerCase().includes(q));},[query,articles]);
 const total=useMemo(()=>{try{return cart.length?calculateInvoice(cart.map(l=>({quantity:l.quantity,unitPrice:unitPriceExcludingVat(l.article.saleTtc,l.article.vatRate),discountRate:discount(l.discount),vatRate:l.article.vatRate}))).total:null;}catch{return null;}},[cart]);
 const add=(article:CreditFormArticle)=>setCart(current=>current.some(l=>l.article.id===article.id)?current.map(l=>l.article.id===article.id?{...l,quantity:Math.min(1000000,l.quantity+1)}:l):[...current,{article,quantity:1,discount:'0'}]);
 const change=(id:string,fn:(l:Draft)=>Draft|null)=>setCart(current=>current.flatMap(l=>l.article.id===id?((value)=>value?[value]:[])(fn(l)):[l]));
 const submit=async()=>{
  if(lock.current||saved.current)return;lock.current=true;setBusy(true);setError('');
  try{
   const payment:CreditPayment={mode,paid,chequeNumber:number,chequeBank:bank,chequeDue:due},createdAt=new Date().toISOString();
   if(kind==='sale')await saveSale(prepareCreditSale(client,context,cart.map(l=>({...l,discount:discount(l.discount)})),payment,createdAt),true,context);
   else await saveSettlement(prepareCreditSettlement(client,context,payment,createdAt),true,context);
   // Dès le commit, ne jamais proposer de réenregistrer si le retour échoue.
   saved.current=true;setComplete(true);onDone();
  }catch(e){setError(saved.current?'Opération enregistrée. Revenez à la liste pour actualiser.':e instanceof Error?e.message:'Enregistrement impossible.');}
  finally{lock.current=false;setBusy(false);}
 };
 return <ScrollView contentContainerStyle={styles.container}>
  <Text style={styles.title}>{kind==='sale'?'Nouvelle vente':'Règlement de dette'} · {client.name}</Text>
  <Text style={styles.notice}>Solde connu avant opération : {money(client.balance??0)}. Les opérations hors ligne des autres appareils ne sont pas encore visibles.</Text>
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  {kind==='sale'&&<><TextInput accessibilityLabel="Rechercher un article" style={styles.input} value={query} onChangeText={setQuery} placeholder="Nom, code ou code-barres"/>
   <Text>{found.length} article(s) trouvé(s){found.length>50?' · affinez la recherche':''}</Text>
   {found.slice(0,50).map(a=><TouchableOpacity key={a.id} accessibilityRole="button" disabled={busy||complete} onPress={()=>add(a)} style={styles.card}><Text>{a.name} · {a.code}</Text><Text>Prix TTC unitaire : {money(Number(a.saleTtc))} · Ajouter</Text></TouchableOpacity>)}
   <Text style={styles.heading}>Panier</Text>{cart.map(l=><View key={l.article.id} style={styles.card}><Text>{l.article.name} · quantité {l.quantity}</Text><View style={styles.actions}><TouchableOpacity accessibilityRole="button" disabled={busy||complete} onPress={()=>change(l.article.id,x=>x.quantity<=1?null:{...x,quantity:x.quantity-1})}><Text style={styles.link}>−</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={busy||complete} onPress={()=>change(l.article.id,x=>({...x,quantity:Math.min(1000000,x.quantity+1)}))}><Text style={styles.link}>+</Text></TouchableOpacity><Text>Remise (%)</Text><TextInput accessibilityLabel={`Remise ${l.article.name}`} style={styles.smallInput} keyboardType="decimal-pad" value={l.discount} onChangeText={v=>change(l.article.id,x=>({...x,discount:v}))}/></View></View>)}
   <Text style={styles.heading}>Total : {total===null?'—':money(total)}</Text></>}
  <Text style={styles.heading}>Mode de paiement</Text><View style={styles.actions}>{(['Espèces','Chèque','Virement',...(kind==='sale'?['Crédit']:[])] as CreditPayment['mode'][]).map(value=><TouchableOpacity accessibilityRole="button" accessibilityState={{selected:mode===value}} disabled={busy||complete} key={value} onPress={()=>setMode(value)}><Text style={styles.link}>{mode===value?'✓ ':''}{value}</Text></TouchableOpacity>)}</View>
  {mode!=='Crédit'&&<TextInput accessibilityLabel={kind==='sale'?'Montant encaissé':'Montant du règlement'} style={styles.input} keyboardType="decimal-pad" value={paid} onChangeText={setPaid} placeholder="Montant en DT"/>}
  {mode==='Chèque'&&<><TextInput accessibilityLabel="Numéro du chèque" style={styles.input} value={number} onChangeText={setNumber} placeholder="Numéro du chèque"/><TextInput accessibilityLabel="Banque" style={styles.input} value={bank} onChangeText={setBank} placeholder="Banque"/><TextInput accessibilityLabel="Échéance" style={styles.input} value={due} onChangeText={setDue} placeholder="Échéance"/></>}
  <View style={styles.actions}><TouchableOpacity accessibilityRole="button" disabled={busy||complete} onPress={()=>void submit()} style={styles.button}><Text style={styles.buttonText}>{busy?'Enregistrement…':'Enregistrer'}</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onCancel}><Text style={styles.link}>Retour</Text></TouchableOpacity></View>
 </ScrollView>;
}
const styles=StyleSheet.create({container:{padding:16,gap:12},title:{fontSize:20,fontWeight:'700',color:'#173c32'},heading:{fontWeight:'700',fontSize:16},notice:{backgroundColor:'#fff4de',padding:10,borderRadius:8,color:'#89511e'},error:{backgroundColor:'#ffebe8',padding:10,borderRadius:8,color:'#842c23'},input:{backgroundColor:'#fff',borderWidth:1,borderColor:'#c5d7cc',padding:10,borderRadius:8},smallInput:{backgroundColor:'#fff',borderWidth:1,borderColor:'#c5d7cc',padding:7,borderRadius:8,minWidth:65},card:{backgroundColor:'#fff',borderRadius:10,padding:12,gap:6},actions:{flexDirection:'row',flexWrap:'wrap',gap:16,alignItems:'center'},link:{color:'#176745',fontWeight:'700',paddingVertical:8},button:{backgroundColor:'#176745',padding:14,borderRadius:10},buttonText:{color:'#fff',fontWeight:'700'}});
