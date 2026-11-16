import {useEffect,useState} from 'react';
import {AppState,Modal,Pressable,ScrollView,StyleSheet,Text,View} from 'react-native';
import type {RefArticle} from './reference';
import {describeArticle,type DetailRow} from './article-detail';

/** Fiche article en panneau du bas. Le prix d'achat et la marge restent masqués
 * tant que le commercial ne les affiche pas, et se remasquent à la fermeture, au
 * changement d'article et quand l'application passe en arrière-plan. */
export function ArticleDetailSheet({article,onClose}:{article:RefArticle|null;onClose:()=>void}) {
  const [revealed,setRevealed]=useState(false);
  useEffect(()=>{setRevealed(false);},[article?.id]);
  useEffect(()=>{
    const subscription=AppState.addEventListener('change',state=>{if(state!=='active')setRevealed(false);});
    return ()=>subscription.remove();
  },[]);
  if(!article)return null;
  const detail=describeArticle(article,revealed);
  const close=()=>{setRevealed(false);onClose();};
  return (
    <Modal transparent animationType="slide" visible onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="Fermer la fiche article" />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>{detail.title}</Text>
          {detail.rows.map(row=><Row key={row.label} row={row} />)}
          {detail.purchase && (
            <View style={styles.purchaseBox}>
              {detail.purchase.revealed
                ? <>{detail.purchase.rows.map(row=><Row key={row.label} row={row} />)}
                    <Pressable style={styles.secondaryButton} onPress={()=>setRevealed(false)} accessibilityRole="button"><Text style={styles.secondaryText}>Masquer le prix d’achat</Text></Pressable></>
                : <Pressable style={styles.secondaryButton} onPress={()=>setRevealed(true)} accessibilityRole="button"><Text style={styles.secondaryText}>Afficher le prix d’achat et la marge</Text></Pressable>}
            </View>
          )}
        </ScrollView>
        <Pressable style={styles.closeButton} onPress={close} accessibilityRole="button"><Text style={styles.closeText}>Fermer</Text></Pressable>
      </View>
    </Modal>
  );
}
function Row({row}:{row:DetailRow}) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{row.label}</Text>
      <Text style={[styles.value,row.negative&&styles.negative]}>{row.value}</Text>
    </View>
  );
}
// Couleurs approchées de l'application : à aligner sur la palette de App.tsx si besoin.
const styles=StyleSheet.create({
  backdrop:{flex:1,backgroundColor:'rgba(0,0,0,0.4)'},
  sheet:{backgroundColor:'#FFFFFF',borderTopLeftRadius:28,borderTopRightRadius:28,maxHeight:'80%',paddingBottom:24},
  handle:{alignSelf:'center',width:44,height:5,borderRadius:3,backgroundColor:'#D9D3C3',marginTop:10},
  content:{padding:20,gap:4},
  title:{fontSize:20,fontWeight:'800',color:'#1E4D40',marginBottom:12},
  row:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingVertical:10,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:'#E5E0D2'},
  label:{flex:1,fontSize:15,color:'#6B6B63',fontWeight:'600'},
  value:{fontSize:16,color:'#1E4D40',fontWeight:'800',marginLeft:12},
  negative:{color:'#A63A2B'},
  purchaseBox:{marginTop:16,padding:14,borderRadius:18,backgroundColor:'#DDF0E4'},
  secondaryButton:{marginTop:8,paddingVertical:12,borderRadius:14,alignItems:'center',backgroundColor:'#FFFFFF'},
  secondaryText:{fontSize:15,fontWeight:'800',color:'#1E4D40'},
  closeButton:{marginHorizontal:20,marginTop:8,paddingVertical:14,borderRadius:18,alignItems:'center',backgroundColor:'#3E8A6B'},
  closeText:{fontSize:16,fontWeight:'800',color:'#FFFFFF'},
});
