import express,{type Express,type RequestHandler} from 'express';
import {isAbsolute,join} from 'node:path';
import {lstatSync,readdirSync} from 'node:fs';
import type {TransportConfig} from './https-config.js';

type Environment=Record<string,string|undefined>;
/** Publie uniquement l'interface construite, jamais le dossier du projet.
 * Le propriétaire doit empêcher toute modification du dossier pendant le service. */
export function mountHttpsAdmin(app:Express,env:Environment,transport:TransportConfig):boolean {
 const root=env.SLS_ADMIN_STATIC_DIR;if(root===undefined)return false;
 if(env.SLS_REQUIRE_HTTPS!=='1'||!transport.tls||!transport.expectedHost)throw Error('L’administration statique exige HTTPS obligatoire et un nom vérifié.');
 if(!root||root!==root.trim()||!isAbsolute(root))throw Error('SLS_ADMIN_STATIC_DIR doit être un chemin absolu vers la construction admin.');
 const directory=lstatSync(root);if(!directory.isDirectory()||directory.isSymbolicLink())throw Error('Répertoire admin invalide.');
 const index=join(root,'index.html'),indexStat=lstatSync(index);if(!indexStat.isFile()||indexStat.isSymbolicLink())throw Error('Interface admin construite introuvable.');
 const assets=join(root,'assets'),assetStat=lstatSync(assets);if(!assetStat.isDirectory()||assetStat.isSymbolicLink())throw Error('Actifs admin construits introuvables.');
 let count=0;
 const inspect=(directory:string,depth:number)=>{
  if(depth>16)throw Error('Arborescence admin trop profonde.');
  for(const entry of readdirSync(directory,{withFileTypes:true})){
   if(++count>20000)throw Error('Trop de fichiers admin.');
   if(entry.isSymbolicLink()||(!entry.isDirectory()&&!entry.isFile()))throw Error('Liens symboliques ou fichiers spéciaux interdits dans les actifs admin.');
   if(entry.isDirectory())inspect(join(directory,entry.name),depth+1);
  }
 };
 inspect(assets,0);
 const host=transport.expectedHost;
 const protect:RequestHandler=(req,res,next)=>{
  res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');
  res.set('Referrer-Policy','no-referrer');res.set('X-Frame-Options','DENY');
  res.set('Content-Security-Policy',"base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
  // Le serveur TLS est direct, sans confiance envers X-Forwarded-*.
  if(!req.secure||typeof req.hostname!=='string'||req.hostname.toLowerCase().replace(/^\[|\]$/g,'')!==host){res.status(421).type('text/plain').send('Origine administrative refusée.');return;}
  next();
 };
 app.get('/',protect,(_req,res,next)=>res.sendFile(index,error=>{if(error)next(error);}));
 app.use('/assets',protect,express.static(assets,{dotfiles:'deny',index:false,redirect:false,fallthrough:true}));
 return true;
}
