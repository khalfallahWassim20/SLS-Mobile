/** Routes préparatoires volontairement non montées : avant toute activation,
 * configurer TLS sans faire confiance à des en-têtes de proxy non vérifiés,
 * puis terminer le rapprochement de l'ancien téléphone et le client mobile. */
import {Router,type NextFunction,type RequestHandler,type Response} from 'express';
import {rateLimit} from 'express-rate-limit';
import {ZodError} from 'zod';
import type {Pool} from 'pg';
import {isPrivateHttpOrigin} from '../../mobile/private-api-origin.js';
import {AddressApprovalRejected,issueAddressApproval,redeemAddressApproval,revokeAddressApproval} from './mobile-address-approval.js';

function error(e:unknown,res:Response,next:NextFunction){
 if(e instanceof AddressApprovalRejected){res.status(409).json({error:e.message});return;}
 if(e instanceof ZodError||e instanceof RangeError){res.status(400).json({error:'Demande invalide.'});return;}
 next(e);
}
function preparedRouter(allowPrivateHttp=false){
 const r=Router();r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 // Express ne doit pas être configuré en trust proxy général : l'en-tête
 // X-Forwarded-Proto ne suffit pas à établir la sécurité du transport.
 r.use((req,res,next)=>{
  if(req.secure){next();return;}
  // Pas de confiance aux en-têtes de proxy. IP source privée ou boucle locale,
  // et hôte littéral privé ou boucle locale seulement ; aucune confidentialité.
  const peer=req.socket.remoteAddress?.replace(/^::ffff:/,'')??'',host=req.hostname;
  const privatePeer=isPrivateHttpOrigin(`http://${peer}`),privateHost=isPrivateHttpOrigin(`http://${host}`);
  const loopPeer=peer==='127.0.0.1'||peer==='::1',loopHost=host==='127.0.0.1'||host==='localhost'||host==='::1';
  if(!allowPrivateHttp||!(privatePeer||loopPeer)||!(privateHost||loopHost)){res.status(403).json({error:'HTTPS requis.'});return;}
  next();
 });
 r.use(rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:'draft-8',legacyHeaders:false}));return r;
}
export function addressApprovalAdminRoutes(pool:Pool,authenticateAdmin:RequestHandler,adminName:string,allowPrivateHttp=false){
 const r=preparedRouter(allowPrivateHttp);r.use(authenticateAdmin);
 r.post('/',async(req,res,next)=>{try{res.status(201).json(await issueAddressApproval(pool,adminName,req.body,allowPrivateHttp));}catch(e){error(e,res,next);}});
 r.post('/:requestId/revoke',async(req,res,next)=>{try{res.json(await revokeAddressApproval(pool,adminName,req.params.requestId));}catch(e){error(e,res,next);}});
 return r;
}
export function addressApprovalCommercialRoutes(pool:Pool,secret:string,allowPrivateHttp=false){
 const r=preparedRouter(allowPrivateHttp);
 r.post('/redeem',async(req,res,next)=>{try{const token=req.get('Authorization')?.match(/^Bearer (.+)$/)?.[1]??'';res.json(await redeemAddressApproval(pool,secret,token,req.body,allowPrivateHttp));}catch(e){error(e,res,next);}});
 return r;
}
