import {calculateInvoice} from '@sls/domain';
/** Facture client PDF : prix unitaire TTC et total TTC par article.
 * Montants en millimes. Module pur (sans accès fichier) pour rester testable. */
export type InvoicePdfLine = {
  name: string; code: string; quantity: number;
  unitPrice: number;      // prix unitaire HT en millimes
  discountRate: number;   // centièmes de pour cent (500 = 5 %)
  vatRate: number;        // centièmes de pour cent (1900 = 19 %)
  unitTtc?: number;       // prix catalogue TTC si connu ; sinon calculé depuis le HT
};
export type InvoicePdfTotals = { subtotal: number; discount: number; net: number; vat: number; total: number; vatByRate: { rate: number; base: number; vat: number }[] };
export type InvoicePdfInput = { client: { name: string; sector: string }; commercial?: string; issuedAt: string; lines: InvoicePdfLine[]; totals: InvoicePdfTotals };

const roundRatio = (value: bigint, numerator: number, denominator = 10000n): bigint => (value * BigInt(numerator) + denominator / 2n) / denominator;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
/** Même format que l'écran : 554.381 DT. */
export const dt = (amount: number) => {if(!Number.isSafeInteger(amount)||amount<0)throw Error('Montant invalide.');const n=BigInt(amount);return `${n/1000n}.${(n%1000n).toString().padStart(3,'0')} DT`;};

/** Prix unitaire TTC et total TTC de chaque ligne.
 * Le total TTC de chaque ligne est réparti (plus grand reste) pour que leur somme
 * soit exactement le total TTC de la facture calculé par l'application. */
export function invoiceLineAmounts(lines: InvoicePdfLine[], totals: InvoicePdfTotals) {
  const expected=calculateInvoice(lines.map(({quantity,unitPrice,discountRate,vatRate})=>({quantity,unitPrice,discountRate,vatRate})));
  if(!totals||['subtotal','discount','net','vat','total'].some(key=>totals[key as keyof InvoicePdfTotals]!==expected[key as keyof typeof expected])||!Array.isArray(totals.vatByRate)||totals.vatByRate.length!==expected.vatByRate.length||totals.vatByRate.some((g,i)=>!g||g.rate!==expected.vatByRate[i].rate||g.base!==expected.vatByRate[i].base||g.vat!==expected.vatByRate[i].vat))throw Error('Totaux de facture incohérents.');
  for(const line of lines){if(typeof line.name!=='string'||!line.name.trim()||typeof line.code!=='string'||!line.code.trim()||line.unitTtc!==undefined&&(!Number.isSafeInteger(line.unitTtc)||line.unitTtc<0))throw Error('Article de facture invalide.');}
  const nets = lines.map(l => roundRatio(BigInt(l.quantity) * BigInt(l.unitPrice), 10000 - l.discountRate));
  const vatShare: bigint[] = lines.map(() => 0n);
  for (const group of totals.vatByRate) {
    const idx = lines.map((l, i) => i).filter(i => lines[i].vatRate === group.rate);
    const exact = idx.map(i => nets[i] * BigInt(group.rate));            // × 10000 près
    const floors = exact.map(v => v / 10000n);
    let remaining = BigInt(group.vat) - floors.reduce((s, v) => s + v, 0n);
    idx.forEach((i, k) => { vatShare[i] = floors[k]; });
    const order = idx.map((i, k) => ({ i, rest: exact[k] % 10000n })).sort((a, b) => (a.rest === b.rest ? a.i - b.i : a.rest > b.rest ? -1 : 1));
    if(remaining<0n||remaining>BigInt(order.length))throw Error('TVA de facture incohérente.');
    for (let k = 0; remaining > 0n && order.length; k = (k + 1) % order.length) { vatShare[order[k].i] += 1n; remaining -= 1n; }
  }
  return lines.map((l, i) => ({
    unitTtc: l.unitTtc ?? Number(roundRatio(BigInt(l.unitPrice), 10000 + l.vatRate)),
    totalTtc: Number(nets[i] + vatShare[i])
  }));
}

export function saleInvoiceHtml(input: InvoicePdfInput): string {
  if(!input||!input.client||typeof input.client.name!=='string'||!input.client.name.trim()||typeof input.client.sector!=='string'||typeof input.issuedAt!=='string'||!input.issuedAt.trim())throw Error('Client ou date de facture invalide.');
  const amounts = invoiceLineAmounts(input.lines, input.totals);
  const sum = amounts.reduce((s, a) => s + a.totalTtc, 0);
  if (sum !== input.totals.total) throw new Error('Facture incohérente : le total des lignes ne correspond pas au total TTC.');
  const showDiscount = input.lines.some(l => l.discountRate > 0);
  const rows = input.lines.map((l, i) => `<tr><td class="name">${esc(l.name)}<small>${esc(l.code)} · TVA ${l.vatRate / 100} %</small></td><td class="num">${l.quantity}</td><td class="num">${dt(amounts[i].unitTtc)}</td>${showDiscount ? `<td class="num">${l.discountRate / 100} %</td>` : ''}<td class="num strong">${dt(amounts[i].totalTtc)}</td></tr>`).join('');
  const vatRows = input.totals.vatByRate.map(g => `<tr><td>TVA ${g.rate / 100} % sur ${dt(g.base)}</td><td class="num">${dt(g.vat)}</td></tr>`).join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Facture client</title><style>
@page{size:A4;margin:16mm}*{box-sizing:border-box}body{font:12px Helvetica,Arial,sans-serif;color:#10213f;margin:0}
.top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #f5a623;padding-bottom:12px}
h1{font-size:22px;margin:0 0 4px;color:#14234a}.muted{color:#6b7790}.brand{font-size:26px;font-weight:700;color:#14234a}
.client{margin:18px 0;padding:12px 14px;background:#f3f6fb;border-radius:10px}.client strong{font-size:15px;display:block;margin-bottom:2px}
table{border-collapse:collapse;width:100%}thead{display:table-header-group}th{background:#14234a;color:#fff;text-align:left;font-size:10.5px;letter-spacing:.4px;padding:8px}
td{padding:8px;border-bottom:1px solid #dfe5f0;vertical-align:top}tr{break-inside:avoid}.num{text-align:right;white-space:nowrap}th.num{text-align:right}
.name{font-weight:700}.name small{display:block;font-weight:400;color:#6b7790;margin-top:2px}.strong{font-weight:700}
.totals{width:52%;margin:16px 0 0 auto}.totals td{border:0;padding:5px 8px}.totals .grand td{font-size:15px;font-weight:700;background:#d9f2ee;padding:10px 8px}
.note{margin-top:26px;font-size:10.5px;color:#6b7790;border-top:1px solid #dfe5f0;padding-top:8px}
</style></head><body>
<div class="top"><div><div class="brand">SLS</div><div class="muted">Facture client</div></div><div style="text-align:right"><h1>Récapitulatif de vente</h1><div class="muted">Date : ${esc(input.issuedAt)}</div>${input.commercial ? `<div class="muted">Commercial : ${esc(input.commercial)}</div>` : ''}</div></div>
<div class="client"><span class="muted">CLIENT</span><strong>${esc(input.client.name)}</strong>${input.client.sector ? `<span class="muted">${esc(input.client.sector)}</span>` : ''}</div>
<table><thead><tr><th>ARTICLE</th><th class="num">QTÉ</th><th class="num">PRIX UNIT. TTC</th>${showDiscount ? '<th class="num">REMISE</th>' : ''}<th class="num">TOTAL TTC</th></tr></thead><tbody>${rows}</tbody></table>
<table class="totals"><tbody><tr><td>Total HT</td><td class="num">${dt(input.totals.net)}</td></tr>${vatRows}<tr class="grand"><td>Total TTC</td><td class="num">${dt(input.totals.total)}</td></tr></tbody></table>
<p class="note">Document généré par l’application SLS Mobile. Les prix unitaires TTC sont indiqués avant remise. Les totaux tiennent compte des remises et des arrondis de TVA appliqués par l’application. Récapitulatif avant validation : ce document ne confirme pas une vente et ne constitue pas une facture officielle.</p>
</body></html>`;
}
