import {formatMillimes,unitMargin,unitPriceExcludingVat,type RefArticle} from './reference';

/** Modèle de la fiche article : texte prêt à afficher, sans logique dans le composant.
 * Le prix d'achat et la marge ne sont produits que si le serveur a transmis purchaseTtc
 * ET que l'utilisateur les a explicitement affichés : rien n'en fuit autrement. */
export type DetailRow = { label: string; value: string; negative?: boolean };
export type ArticleDetail = { title: string; rows: DetailRow[]; purchase: { revealed: boolean; rows: DetailRow[] } | null };

const signedMoney = (millimes: number) => (millimes < 0 ? '\u2212 ' : '') + formatMillimes(String(Math.abs(millimes)));
const percent = (hundredths: number) => (hundredths < 0 ? '\u2212 ' : '') + (Math.abs(hundredths) / 100).toFixed(2).replace('.', ',') + ' %';
const vatLabel = (rate: number) => String(rate / 100).replace('.', ',') + ' %';

export function describeArticle(article: RefArticle, revealPurchase: boolean): ArticleDetail {
  const rows: DetailRow[] = [
    { label: 'Référence', value: article.code },
    { label: 'Code-barres', value: article.barcode.trim() || '\u2014' },
    { label: 'TVA', value: vatLabel(article.vatRate) },
    { label: 'Prix de vente TTC / unité', value: formatMillimes(article.saleTtc) },
    { label: 'Prix de vente HT / unité', value: formatMillimes(String(unitPriceExcludingVat(article.saleTtc, article.vatRate))) },
    { label: 'Quantité par carton', value: String(article.unitsPerCarton) },
  ];
  if (article.unitsPerCarton > 1) rows.push({ label: 'Prix du carton TTC', value: formatMillimes((BigInt(article.saleTtc) * BigInt(article.unitsPerCarton)).toString()) });
  // Pas de droit (ou serveur plus ancien) : aucune trace du prix d'achat, pas même un bouton.
  if (article.purchaseTtc === undefined) return { title: article.name, rows, purchase: null };
  if (!revealPurchase) return { title: article.name, rows, purchase: { revealed: false, rows: [] } };
  const margin = unitMargin(article.saleTtc, article.purchaseTtc, article.vatRate);
  return {
    title: article.name, rows,
    purchase: {
      revealed: true,
      rows: [
        { label: 'Prix d\u2019achat TTC / unité', value: formatMillimes(article.purchaseTtc) },
        { label: 'Marge unitaire HT', value: signedMoney(margin.amount), negative: margin.amount < 0 },
        { label: 'Taux de marge', value: percent(margin.rate), negative: margin.rate < 0 },
      ],
    },
  };
}
