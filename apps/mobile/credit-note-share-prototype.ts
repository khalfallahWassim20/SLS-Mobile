/** Partage local v5. Les dépendances natives sont fournies par l'appelant ;
 * l'instantané doit provenir d'une transaction SQLite v5 vérifiée. */
import {journalCsv,journalHtml,type JournalExport} from './journal-export';
type IO={cacheDirectory:string|null;available:()=>Promise<boolean>;write:(uri:string,data:string,encoding:'utf8'|'base64')=>Promise<void>;print:(html:string)=>Promise<{base64?:string}>;share:(uri:string,options:{mimeType:string;dialogTitle:string;UTI:string})=>Promise<void>;now:()=>number};
export async function shareCreditJournalPrototype(data:JournalExport,format:'csv'|'pdf',io:IO){
 if(format!=='csv'&&format!=='pdf')throw Error('Format de journal invalide.');
 const parsed=new Date(`${data.day}T00:00:00.000Z`);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(data.day)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==data.day||!Array.isArray(data.credits))throw Error('Instantané du journal v5 invalide.');
 // Valider intégralement avant de créer ou partager un fichier.
 const content=format==='csv'?journalCsv(data):journalHtml(data);
 if(!await io.available())throw Error('Le partage de fichiers n’est pas disponible sur cet appareil.');
 if(!io.cacheDirectory)throw Error('Stockage temporaire indisponible.');
 const stamp=io.now();if(!Number.isSafeInteger(stamp)||stamp<0)throw Error('Date d’export invalide.');
 const uri=`${io.cacheDirectory}journal-${data.day}-${stamp}.${format}`;
 if(format==='pdf'){
  const result=await io.print(content);if(!result.base64)throw Error('Le fichier PDF généré est vide ou indisponible.');
  await io.write(uri,result.base64,'base64');
 }else await io.write(uri,content,'utf8');
 await io.share(uri,{mimeType:format==='pdf'?'application/pdf':'text/csv',dialogTitle:'Partager le journal local',UTI:format==='pdf'?'com.adobe.pdf':'public.comma-separated-values-text'});
 return uri;
}
