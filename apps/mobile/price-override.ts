import {parseDinars} from '@sls/domain';
import {unitPriceExcludingVat} from './reference';

/** Prix de vente modifié à la main dans le panier. Le commercial saisit un prix TTC en dinars
 * (virgule ou point, 3 décimales maximum) ; le calcul des factures travaille en HT, en millimes. */
export type PriceOverrideInput = { saleTtc: string; vatRate: number; purchaseTtc?: string };
export type PriceOverride =
  | {
      ok: true;
      /** Prix unitaire HT à placer sur la ligne du panier, en millimes. */
      unitPriceHt: number;
      /** TTC réellement obtenu après conversion en HT : peut différer d'un millime du prix saisi. */
      effectiveTtc: number;
      /** Faux si le prix saisi équivaut au prix catalogue : aucune trace de modification à conserver. */
      changed: boolean;
      /** Vrai seulement si le serveur a transmis le prix d'achat à ce commercial. */
      belowPurchase: boolean;
    }
  | { ok: false; error: string };

export function resolvePriceOverride(text: string, article: PriceOverrideInput): PriceOverride {
  let typed: number;
  try { typed = parseDinars(text); }
  catch (error) { return { ok: false, error: error instanceof RangeError ? error.message : 'Montant invalide.' }; }
  if (typed <= 0) return { ok: false, error: 'Le prix doit être supérieur à 0.' };
  try {
    const unitPriceHt = unitPriceExcludingVat(String(typed), article.vatRate);
    const catalogHt = unitPriceExcludingVat(article.saleTtc, article.vatRate);
    const effectiveTtc = Number((BigInt(unitPriceHt) * BigInt(10000 + article.vatRate) + 5000n) / 10000n);
    return {
      ok: true, unitPriceHt, effectiveTtc,
      changed: unitPriceHt !== catalogHt,
      belowPurchase: article.purchaseTtc !== undefined && typed < Number(article.purchaseTtc),
    };
  } catch { return { ok: false, error: 'Prix trop élevé.' }; }
}
