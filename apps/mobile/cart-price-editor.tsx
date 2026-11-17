import {useState} from 'react';
import {StyleSheet,Text,TextInput,TouchableOpacity,View} from 'react-native';
import {formatMillimes,unitPriceExcludingVat,type RefArticle} from './reference';
import {resolvePriceOverride} from './price-override';

/** Prix unitaire modifiable d'une ligne du panier. Le commercial saisit un prix TTC ; la vente reste
 * acceptée même sous le prix d'achat, mais elle est signalée à l'administration. Sans article de
 * référence (catalogue de démonstration intégré), rien n'est affiché. */
export function CartPriceEditor({article,unitPriceHt,onApply}:{article:RefArticle|undefined;unitPriceHt:number;onApply:(unitPriceHt:number)=>void}) {
  const [editing,setEditing]=useState(false);
  const [text,setText]=useState('');
  if(!article)return null;
  const toTtc=(ht:number)=>Number((BigInt(ht)*BigInt(10000+article.vatRate)+5000n)/10000n);
  const catalogHt=unitPriceExcludingVat(article.saleTtc,article.vatRate);
  const overridden=unitPriceHt!==catalogHt;
  const currentTtc=formatMillimes(String(toTtc(unitPriceHt)));
  const result=editing?resolvePriceOverride(text,article):null;
  const canApply=!!result&&result.ok;
  const open=()=>{setText(currentTtc.replace(' DT',''));setEditing(true);};
  const apply=()=>{if(result&&result.ok){onApply(result.unitPriceHt);setEditing(false);}};
  const reset=()=>{onApply(catalogHt);setEditing(false);};
  return (
    <View style={styles.box}>
      <View style={styles.row}>
        <Text style={styles.price}>{currentTtc} TTC / unité</Text>
        {overridden&&<Text style={styles.badge}>Prix modifié</Text>}
        {!editing&&<TouchableOpacity accessibilityRole="button" accessibilityLabel="Modifier le prix unitaire" onPress={open}><Text style={styles.link}>✎ Modifier le prix</Text></TouchableOpacity>}
      </View>
      {editing&&(
        <View style={styles.editor}>
          <TextInput placeholderTextColor="#9AA39F" selectionColor="#0E8A6D" accessibilityLabel="Nouveau prix unitaire TTC en dinars" style={styles.input} value={text} onChangeText={setText} keyboardType="decimal-pad" placeholder="Prix unitaire TTC (DT)" autoFocus />
          {result&&!result.ok&&<Text style={styles.error}>{result.error}</Text>}
          {result&&result.ok&&<Text style={styles.hint}>Prix retenu : {formatMillimes(String(result.effectiveTtc))} TTC · {formatMillimes(String(result.unitPriceHt))} HT</Text>}
          {result&&result.ok&&result.belowPurchase&&<Text style={styles.warning}>Prix inférieur au prix d’achat : la vente reste possible et sera signalée à l’administration.</Text>}
          <View style={styles.actions}>
            <TouchableOpacity accessibilityRole="button" onPress={()=>setEditing(false)}><Text style={styles.link}>Annuler</Text></TouchableOpacity>
            {overridden&&<TouchableOpacity accessibilityRole="button" onPress={reset}><Text style={styles.link}>Prix catalogue</Text></TouchableOpacity>}
            <TouchableOpacity accessibilityRole="button" disabled={!canApply} onPress={apply} style={[styles.apply,!canApply&&styles.applyOff]}><Text style={styles.applyText}>Appliquer</Text></TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}
// Couleurs approchées de l'application : à aligner sur la palette de App.tsx si besoin.
const styles=StyleSheet.create({
  box:{marginTop:6,marginBottom:6},
  row:{flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:10},
  price:{fontSize:15,fontWeight:'700',color:'#1E4D40'},
  badge:{fontSize:12,fontWeight:'800',color:'#8A5A00',backgroundColor:'#FCEFC7',paddingHorizontal:8,paddingVertical:3,borderRadius:10,overflow:'hidden'},
  link:{fontSize:14,fontWeight:'800',color:'#0E8A6D'},
  editor:{marginTop:8,gap:8},
  input:{borderWidth:1,borderColor:'#D8D3C4',borderRadius:14,paddingHorizontal:14,paddingVertical:10,fontSize:16,color:'#1E4D40',backgroundColor:'#FFFFFF'},
  hint:{fontSize:13,color:'#6B6B63'},
  error:{fontSize:13,fontWeight:'700',color:'#A63A2B'},
  warning:{fontSize:13,fontWeight:'700',color:'#8A5A00'},
  actions:{flexDirection:'row',alignItems:'center',gap:16},
  apply:{marginLeft:'auto',backgroundColor:'#3E8A6B',paddingHorizontal:18,paddingVertical:10,borderRadius:14},
  applyOff:{opacity:0.4},
  applyText:{fontSize:14,fontWeight:'800',color:'#FFFFFF'},
});
