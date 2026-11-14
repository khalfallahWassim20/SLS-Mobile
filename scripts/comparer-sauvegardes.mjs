import {open,realpath,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';

const unchanged = (a,b) => a.size===b.size && a.mtimeNs===b.mtimeNs && a.ctimeNs===b.ctimeNs && a.dev===b.dev && a.ino===b.ino;
async function digest(handle) {
 const hash=createHash('sha256');
 await pipeline(handle.createReadStream({autoClose:false,start:0}),hash);
 return hash.digest('hex');
}
/** Compare deux fichiers existants sans écrire ; ne valide pas leur contenu. */
export async function compareBackups(original,copy) {
 if (await realpath(original) === await realpath(copy)) throw Error('Choisir deux fichiers distincts.');
 const [initialA,initialB]=await Promise.all([stat(original),stat(copy)]);
 if(!initialA.isFile()||!initialB.isFile()) throw Error('Les deux fichiers doivent être réguliers et non vides.');
 const first=await open(original,'r');
 try {
  const second=await open(copy,'r');
  try {
   const a=await first.stat({bigint:true}),b=await second.stat({bigint:true});
   if(!a.isFile()||!b.isFile()||a.size===0n||b.size===0n) throw Error('Les deux fichiers doivent être réguliers et non vides.');
   if(a.ino!==0n&&b.ino!==0n&&a.dev===b.dev&&a.ino===b.ino) throw Error('Les deux chemins désignent le même fichier.');
   const hashA=await digest(first),hashB=await digest(second);
   const [endA,endB,pathA,pathB]=await Promise.all([first.stat({bigint:true}),second.stat({bigint:true}),openPathStat(original),openPathStat(copy)]);
   if(!unchanged(a,endA)||!unchanged(b,endB)||!unchanged(a,pathA)||!unchanged(b,pathB)) throw Error('Un fichier a changé pendant la comparaison.');
   if(a.size!==b.size||hashA!==hashB) throw Error('La copie est différente de l’original.');
   return {size:a.size.toString(),sha256:hashA};
  } finally {await second.close();}
 } finally {await first.close();}
}
async function openPathStat(path) {
 const handle=await open(path,'r');
 try{return await handle.stat({bigint:true});}finally{await handle.close();}
}
async function main(){
 const [original,copy,...extra]=process.argv.slice(2);
 if(!original||!copy||extra.length)throw Error('Usage : node scripts/comparer-sauvegardes.mjs ORIGINAL COPIE');
 const result=await compareBackups(original,copy);
 console.log(`Fichiers identiques : ${result.size} octets ; SHA-256 : ${result.sha256}`);
 console.log('Une copie identique ne prouve ni que la sauvegarde est restaurable ni qu’elle est stockée hors site.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error('Comparaison échouée :',error.message);process.exitCode=1;});
