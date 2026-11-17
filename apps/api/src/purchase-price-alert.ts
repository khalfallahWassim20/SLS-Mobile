/** Repère les lignes de vente dont le prix net TTC est inférieur au prix d'achat TTC de l'article.
 * La vente est toujours acceptée : ce repérage sert uniquement au contrôle par l'administration.
 * Il se calcule à la consultation, d'après le prix d'achat actuel de l'article. */
export type PurchaseReference = { purchaseTtc: bigint; vatRate: number };
type SaleLine = { code?: unknown; unitPrice?: unknown; discount?: unknown };

/** unitPrice : prix unitaire HT en millimes ; discount : remise en centièmes de pour cent.
 * Tolérance d'un millime : l'aller-retour TTC → HT → TTC peut perdre un millime et ne doit pas
 * signaler à tort une vente faite exactement au prix d'achat. */
export function isBelowPurchase(line: SaleLine, article: PurchaseReference | undefined): boolean {
  if (!article || article.purchaseTtc <= 0n) return false;
  const price = line.unitPrice, discount = line.discount;
  if (typeof price !== 'number' || !Number.isSafeInteger(price) || price < 0) return false;
  if (typeof discount !== 'number' || !Number.isSafeInteger(discount) || discount < 0 || discount > 10000) return false;
  const netHt = (BigInt(price) * BigInt(10000 - discount) + 5000n) / 10000n;
  const ttc = (netHt * BigInt(10000 + article.vatRate) + 5000n) / 10000n;
  return ttc + 1n < article.purchaseTtc;
}

/** Positions (à partir de 0) des lignes vendues sous le prix d'achat. */
export function belowPurchaseLines(lines: unknown, articlesByCode: Map<string, PurchaseReference>): number[] {
  if (!Array.isArray(lines)) return [];
  const flagged: number[] = [];
  lines.forEach((line: unknown, index: number) => {
    if (!line || typeof line !== 'object') return;
    const code = (line as SaleLine).code;
    if (typeof code === 'string' && isBelowPurchase(line as SaleLine, articlesByCode.get(code))) flagged.push(index);
  });
  return flagged;
}
