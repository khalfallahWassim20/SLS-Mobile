import React,{useEffect,useRef,useState} from 'react';
import {Text,TextInput,TouchableOpacity,View,Switch} from 'react-native';
import {randomUUID} from 'expo-crypto';
import {apiOrigin,openCommercialSession,type CommercialSession} from './commercial-login';
import {fetchServerLineage} from './server-lineage-proof';
import {runAddressRecoveryTest,runAddressRecoveryPrivate} from './storage';
import {isPrivateHttpOrigin} from './private-api-origin';
import type {DeviceIdentity} from './identified-device';

type Prepared={requestId:string;commercialId:string;previousOrigin:string;targetOrigin:string;lineageId:string};
/** Écran de test fermé pendant le travail : pas d'envoi automatique. */
export function AddressRecoveryTest({old,onBack,onMigrated,allowPrivateHttp=false}:{old:DeviceIdentity;onBack:()=>void;onMigrated:(identity:DeviceIdentity)=>void;allowPrivateHttp?:boolean}){
 const [acknowledged,setAcknowledged]=useState(false);
 const [url,setUrl]=useState(''),[login,setLogin]=useState(''),[password,setPassword]=useState(''),[code,setCode]=useState('');
 const [prepared,setPrepared]=useState<Prepared|null>(null),[session,setSession]=useState<CommercialSession|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const active=useRef(true),running=useRef(false),generation=useRef(0);
 useEffect(()=>{active.current=true;return()=>{active.current=false;generation.current++;};},[]);
 async function prepare(){if(running.current)return;running.current=true;setBusy(true);setError('');setPrepared(null);setSession(null);
  const ticket=++generation.current,pass=password;setPassword('');
  try{
   const target=apiOrigin(url);if(allowPrivateHttp&&!acknowledged)throw Error('Confirmez les risques du HTTP avant de continuer.');if(!target.startsWith('https://')&&!(allowPrivateHttp&&isPrivateHttpOrigin(target)))throw Error('Adresse refusée : HTTPS ou IP privée autorisée requis. Aucun mot de passe envoyé.');
   if(target===old.serverOrigin)throw Error('La nouvelle adresse doit être différente.');
   const value=await openCommercialSession(target,login,pass,fetch);
   if(!active.current||generation.current!==ticket)return;
   if(value.id!==old.commercialId)throw Error('Ce compte n’est pas le commercial déjà lié.');
   const candidate=await fetchServerLineage(value,fetch,allowPrivateHttp);if(!active.current||generation.current!==ticket)return;
   setSession(value);setPrepared({requestId:randomUUID(),commercialId:old.commercialId,previousOrigin:old.serverOrigin,targetOrigin:target,lineageId:candidate.lineageId});
  }catch(e){if(active.current&&generation.current===ticket)setError(e instanceof Error?e.message:'Préparation impossible.');}
  finally{running.current=false;if(active.current)setBusy(false);}
 }
 async function change(){if(running.current||!prepared||!session)return;running.current=true;setBusy(true);setError('');const ticket=generation.current,secret=code.trim();setCode('');
  try{
   if(allowPrivateHttp)await runAddressRecoveryPrivate(old,session,prepared.requestId,secret,()=>active.current&&generation.current===ticket);
   else await runAddressRecoveryTest(old,session,prepared.requestId,secret,()=>active.current&&generation.current===ticket);
   if(active.current&&generation.current===ticket)onMigrated({commercialId:old.commercialId,serverOrigin:prepared.targetOrigin});
  }catch(e){if(active.current&&generation.current===ticket)setError(e instanceof Error?e.message:'Changement impossible.');}
  finally{running.current=false;if(active.current)setBusy(false);}
 }
 const input={borderWidth:1,borderColor:'#cbd5d0',borderRadius:8,padding:12,marginVertical:5} as const;
 const button=(label:string,press:()=>void,disabled=false)=><TouchableOpacity accessibilityRole="button" disabled={disabled} onPress={press} style={{padding:12,backgroundColor:disabled?'#a2aaa6':'#0e8a6d',borderRadius:8,marginVertical:5}}><Text style={{color:'white',textAlign:'center'}}>{label}</Text></TouchableOpacity>;
 return <View><Text style={{fontWeight:'bold',fontSize:20}}>Changer l’adresse API</Text><Text>L’ancienne base n’est pas prouvée par ce contrôle. L’administrateur doit vérifier la base ; aucune opération ne sera synchronisée automatiquement.</Text>{allowPrivateHttp?<><Text style={{color:'#a12b23'}}>Attention : HTTP ne chiffre ni le mot de passe, ni le code, ni les données. Ils peuvent être interceptés ou modifiés. Utilisez seulement un réseau privé de confiance.</Text><View><Switch accessibilityLabel="J’accepte les risques du HTTP" value={acknowledged} onValueChange={setAcknowledged}/><Text>J’ai compris et j’accepte les risques du HTTP.</Text></View></>:<Text>Données fictives uniquement.</Text>}<Text>Adresse liée : {old.serverOrigin}</Text>
 {!prepared?<><TextInput style={input} accessibilityLabel="Nouvelle adresse du serveur" placeholder="http://192.168.100.23:3001" value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false}/><TextInput style={input} accessibilityLabel="Identifiant de test" placeholder="Identifiant commercial" value={login} onChangeText={setLogin} autoCapitalize="none"/><TextInput style={input} accessibilityLabel="Mot de passe de test" placeholder="Mot de passe commercial" value={password} onChangeText={setPassword} secureTextEntry/>{button(busy?'Vérification…':'Préparer la demande',()=>{void prepare();},busy)}</>:<><Text>Transmettez cette demande à l’administrateur :</Text><Text selectable style={{padding:8,backgroundColor:'#eef4f1'}}>{JSON.stringify(prepared)}</Text><Text>Le code doit être reçu par un canal de confiance et expire après cinq minutes.</Text><TextInput style={input} accessibilityLabel="Code d’autorisation" value={code} onChangeText={setCode} placeholder="Code temporaire" autoCapitalize="none" autoCorrect={false}/>{button(busy?'Vérification…':'Vérifier et changer l’adresse',()=>{void change();},busy||!code.trim())}</>}
 {!!error&&<Text accessibilityRole="alert" style={{color:'#a12b23'}}>{error}</Text>}{button('Retour sans synchroniser',onBack,busy)}
 </View>;
}
