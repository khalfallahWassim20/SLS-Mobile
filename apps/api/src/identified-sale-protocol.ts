/** Schémas partagés des événements de vente identifiés. */
import {z} from 'zod';
const uuid=z.string().uuid(), money=z.number().int().safe().nonnegative();
export const saleSchema=z.object({createdAt:z.string().datetime(),clientId:uuid,clientName:z.string().min(1).max(200),syncSaleId:uuid,syncVersion:z.number().int().min(1).max(1000000),
 lines:z.array(z.object({name:z.string().min(1).max(200),code:z.string().min(1).max(100),quantity:z.number().int().min(1).max(1000000),unitPrice:money,discount:z.number().int().min(0).max(10000),vat:z.number().int().min(0).max(10000)}).strict()).min(1).max(200),
 total:money,paid:money,remaining:money,paymentMode:z.enum(['Espèces','Chèque','Virement','Crédit']),chequeNumber:z.string().max(100),chequeBank:z.string().max(100),chequeDue:z.string().max(100)}).strict();
export const saleEventSchema=z.object({operationId:uuid,saleId:uuid,version:z.number().int().min(1).max(1000000),recordedAt:z.string().datetime(),sale:saleSchema,refund:money}).strict();
