/** Activation des avoirs côté serveur : arrêt (par défaut), essai fictif isolé,
 * ou pilote réel limité à UN commercial nommé. Aucun mode ne peut être déduit
 * d'une variable intégrée à l'application mobile. */
export type CreditProtocolConfig={mode:'off'|'test'|'pilot';enabled:boolean;pilotCommercialId:string|null};
const TEST_VALUE='DONNEES_FICTIVES_ISOLEES',PILOT_ACK='J_ACCEPTE_UN_PILOTE_AVOIRS';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseCreditProtocolConfig(env:Record<string,string|undefined>):CreditProtocolConfig{
 const test=env.SLS_V5_TEST_ONLY===TEST_VALUE,pilot=(env.SLS_V5_PILOT_COMMERCIAL_ID??'').trim(),ack=env.SLS_V5_PILOT_ACK;
 if(!pilot){
  if(ack!==undefined&&ack!=='')throw Error('SLS_V5_PILOT_ACK sans SLS_V5_PILOT_COMMERCIAL_ID : configuration refusée.');
  return test?{mode:'test',enabled:true,pilotCommercialId:null}:{mode:'off',enabled:false,pilotCommercialId:null};
 }
 if(test)throw Error('Le pilote d’avoirs ne peut pas être combiné au mode d’essai fictif.');
 if(!uuid.test(pilot))throw Error('SLS_V5_PILOT_COMMERCIAL_ID doit être l’identifiant du commercial pilote.');
 if(ack!==PILOT_ACK)throw Error(`Le pilote d’avoirs exige SLS_V5_PILOT_ACK=${PILOT_ACK}.`);
 return {mode:'pilot',enabled:true,pilotCommercialId:pilot.toLowerCase()};
}
/** Seul le pilote nommé (ou tout commercial en essai fictif) peut utiliser les avoirs. */
export function creditAllowedForCommercial(config:CreditProtocolConfig,commercialId:string):boolean{
 return config.enabled&&(config.pilotCommercialId===null||config.pilotCommercialId===commercialId.toLowerCase());
}
