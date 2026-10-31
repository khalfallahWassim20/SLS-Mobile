import React, { useMemo, useState } from 'react';
import { Alert, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { calculateInvoice, isSaleBlocked } from '@sls/domain';

// Données de démonstration uniquement. Aucun prix ou client réel n'est enregistré.
type Client = { id: string; name: string; sector: string; balance: number; limit: number };
type Product = { id: string; name: string; code: string; price: number; vat: number };
type CartLine = { product: Product; quantity: number; discount: number };
const clients: Client[] = [
  { id: 'c1', name: 'Garage du Sud', sector: 'Tataouine', balance: 150000, limit: 2000000 },
  { id: 'c2', name: 'Auto Services Médenine', sector: 'Médenine', balance: 2000000, limit: 2000000 },
  { id: 'c3', name: 'Lubrifiants Djerba', sector: 'Djerba', balance: 0, limit: 1000000 },
];
const products: Product[] = [
  { id: 'p1', name: 'Huile moteur 5 L', code: 'HUI-001', price: 33000, vat: 1900 },
  { id: 'p2', name: 'Filtre à air', code: 'FIL-002', price: 13752, vat: 1900 },
  { id: 'p3', name: 'Liquide de refroidissement', code: 'LIQ-003', price: 18000, vat: 1900 },
  { id: 'p4', name: 'Graisse multi-usage', code: 'GRA-004', price: 12500, vat: 1900 },
];
const money = (amount: number) => `${(amount / 1000).toFixed(3)} DT`;
const normalize = (s: string) => s.trim().toLocaleLowerCase();

function Button({ label, onPress, secondary = false, disabled = false }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.button, secondary && styles.buttonSecondary, disabled && styles.disabled]}><Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{label}</Text></TouchableOpacity>;
}
function Header({ title, detail }: { title: string; detail?: string }) {
  return <View style={styles.header}><Text style={styles.brand}>SLS MOBILE  /  DÉMO</Text><Text style={styles.title}>{title}</Text>{detail && <Text style={styles.subtitle}>{detail}</Text>}</View>;
}
function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <View style={styles.row}><Text style={[styles.rowLabel, strong && styles.strong]}>{label}</Text><Text style={[styles.rowValue, strong && styles.strong]}>{value}</Text></View>;
}
export default function App() {
  const [screen, setScreen] = useState<'clients' | 'products' | 'cart' | 'summary'>('clients');
  const [client, setClient] = useState<Client | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const totals = useMemo(() => cart.length ? calculateInvoice(cart.map(l => ({ quantity: l.quantity, unitPrice: l.product.price, discountRate: l.discount, vatRate: l.product.vat }))) : null, [cart]);
  const selectClient = (value: Client) => {
    if (isSaleBlocked(value.balance, value.limit, false)) { Alert.alert('Vente bloquée', 'Ce client a atteint sa limite de crédit. Seul un administrateur peut autoriser la reprise des ventes.'); return; }
    setClient(value); setCart([]); setQuery(''); setScreen('products');
  };
  const add = (product: Product) => {
    setCart(current => current.some(l => l.product.id === product.id) ? current.map(l => l.product.id === product.id ? { ...l, quantity: l.quantity + 1 } : l) : [...current, { product, quantity: 1, discount: 0 }]);
    setNotice(`${product.name} ajouté`);
  };
  const change = (id: string, fn: (line: CartLine) => CartLine | null) => setCart(current => current.flatMap(line => line.product.id === id ? ((updated) => updated ? [updated] : [])(fn(line)) : [line]));
  const reset = () => { setClient(null); setCart([]); setQuery(''); setNotice(''); setScreen('clients'); };
  return <SafeAreaView style={styles.safe}><StatusBar barStyle="dark-content" /><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    <View style={styles.demo}><Text style={styles.demoText}>Prototype • données fictives • rien n’est enregistré</Text></View>
    {screen === 'clients' && <><Header title="Nouvelle vente" detail="Choisissez un client pour commencer." /><TextInput accessibilityLabel="Rechercher un client" style={styles.search} placeholder="Rechercher un client ou un secteur" value={query} onChangeText={setQuery} />
      <Text style={styles.section}>CLIENTS</Text>{clients.filter(c => normalize(`${c.name} ${c.sector}`).includes(normalize(query))).map(c => <TouchableOpacity accessibilityRole="button" key={c.id} style={styles.card} onPress={() => selectClient(c)}><View style={styles.row}><View style={styles.flex}><Text style={styles.cardTitle}>{c.name}</Text><Text style={styles.muted}>{c.sector} · Solde : {money(c.balance)}</Text></View><Text style={styles.chevron}>›</Text></View>{isSaleBlocked(c.balance, c.limit, false) && <Text style={styles.warning}>Limite atteinte · vente bloquée</Text>}</TouchableOpacity>)}
    </>}
    {screen === 'products' && client && <><Header title="Ajouter des articles" detail={`Client : ${client.name}`} /><TextInput accessibilityLabel="Rechercher un article" style={styles.search} placeholder="Rechercher un article ou un code" value={query} onChangeText={setQuery} />{notice ? <Text accessibilityLiveRegion="polite" style={styles.success}>{notice}</Text> : null}<Text style={styles.section}>CATALOGUE DE DÉMONSTRATION</Text>
      {products.filter(p => normalize(`${p.name} ${p.code}`).includes(normalize(query))).map(p => <View key={p.id} style={styles.card}><Text style={styles.cardTitle}>{p.name}</Text><Text style={styles.muted}>{p.code} · TVA {p.vat / 100} %</Text><View style={[styles.row, styles.cardBottom]}><Text style={styles.price}>{money(p.price)} HT</Text><Button label="+ Ajouter" secondary onPress={() => add(p)} /></View></View>)}
      <Button label={`Voir le panier (${cart.reduce((n, l) => n + l.quantity, 0)})`} onPress={() => setScreen('cart')} disabled={!cart.length} /><Button label="Changer de client" secondary onPress={reset} />
    </>}
    {screen === 'cart' && client && <><Header title="Votre panier" detail={client.name} />{cart.map(l => <View key={l.product.id} style={styles.card}><Text style={styles.cardTitle}>{l.product.name}</Text><Text style={styles.muted}>{money(l.product.price)} HT / unité</Text><View style={[styles.row, styles.cardBottom]}><View style={styles.quantity}><TouchableOpacity accessibilityLabel={`Réduire la quantité de ${l.product.name}`} onPress={() => change(l.product.id, x => x.quantity === 1 ? null : { ...x, quantity: x.quantity - 1 })}><Text style={styles.quantityButton}>−</Text></TouchableOpacity><Text style={styles.quantityNumber}>{l.quantity}</Text><TouchableOpacity accessibilityLabel={`Augmenter la quantité de ${l.product.name}`} onPress={() => change(l.product.id, x => ({ ...x, quantity: x.quantity + 1 }))}><Text style={styles.quantityButton}>+</Text></TouchableOpacity></View><TouchableOpacity accessibilityRole="button" onPress={() => change(l.product.id, () => null)}><Text style={styles.remove}>Supprimer</Text></TouchableOpacity></View><Text style={styles.muted}>Remise : {l.discount / 100} %</Text><View style={styles.discountRow}>{[0, 5, 10, 20].map(percent => <TouchableOpacity key={percent} accessibilityRole="button" onPress={() => change(l.product.id, x => ({ ...x, discount: percent * 100 }))} style={[styles.chip, l.discount === percent * 100 && styles.chipActive]}><Text style={l.discount === percent * 100 ? styles.chipActiveText : styles.chipText}>{percent} %</Text></TouchableOpacity>)}</View><Text style={styles.hint}>Remises prédéfinies pour cette démonstration.</Text></View>)}
      {totals && <View style={styles.totalCard}><Row label="Sous-total HT" value={money(totals.subtotal)} /><Row label="Remise" value={`− ${money(totals.discount)}`} /><Row label="Total HT" value={money(totals.net)} /><Row label="TVA" value={money(totals.vat)} /><Row label="Total TTC" value={money(totals.total)} strong /></View>}
      <Button label="Vérifier la vente" disabled={!totals} onPress={() => setScreen('summary')} /><Button label="+ Ajouter des articles" secondary onPress={() => { setNotice(''); setQuery(''); setScreen('products'); }} />
    </>}
    {screen === 'summary' && client && totals && <><Header title="Récapitulatif" detail="Vérifiez les informations de cette démonstration." /><View style={styles.card}><Text style={styles.section}>CLIENT</Text><Text style={styles.cardTitle}>{client.name}</Text><Text style={styles.muted}>{client.sector}</Text></View><View style={styles.card}><Text style={styles.section}>ARTICLES</Text>{cart.map(l => <Row key={l.product.id} label={`${l.quantity} × ${l.product.name}`} value={`${l.discount / 100} % remise`} />)}</View><View style={styles.totalCard}><Row label="Total HT" value={money(totals.net)} /><Row label="TVA" value={money(totals.vat)} /><Row label="Total TTC" value={money(totals.total)} strong /></View><Text style={styles.disclaimer}>Ceci n’est pas une facture émise. Paiement, enregistrement, PDF et synchronisation seront ajoutés ensuite.</Text><Button label="Modifier le panier" secondary onPress={() => setScreen('cart')} /><Button label="Commencer une nouvelle démo" onPress={reset} /></>}
    <Text style={styles.footer}>SLS MOBILE · VERSION DE DÉMONSTRATION</Text>
  </ScrollView></SafeAreaView>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f5f7f6' }, content: { padding: 20, paddingBottom: 40, maxWidth: 650, width: '100%', alignSelf: 'center' }, demo: { backgroundColor: '#fff2d7', borderRadius: 10, padding: 12 }, demoText: { color: '#795317', fontSize: 12, fontWeight: '600' }, header: { marginTop: 28, marginBottom: 22 }, brand: { color: '#168064', fontSize: 11, letterSpacing: 1.4, fontWeight: '800' }, title: { fontSize: 30, fontWeight: '800', color: '#142b27', marginTop: 9 }, subtitle: { color: '#647773', fontSize: 15, marginTop: 7, lineHeight: 22 }, search: { borderWidth: 1, borderColor: '#dce6e2', backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 15, height: 52, color: '#142b27', fontSize: 15 }, section: { color: '#71827e', fontWeight: '800', fontSize: 11, letterSpacing: 1, marginTop: 22, marginBottom: 12 }, card: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e3ebe8', borderRadius: 14, padding: 16, marginBottom: 10 }, cardTitle: { fontSize: 16, fontWeight: '700', color: '#19332d' }, muted: { color: '#70817c', fontSize: 13, marginTop: 6 }, row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginVertical: 5 }, flex: { flex: 1 }, chevron: { color: '#7a9089', fontSize: 28 }, warning: { color: '#a64e29', fontSize: 12, fontWeight: '700', marginTop: 10 }, success: { color: '#168064', fontSize: 13, marginTop: 12 }, price: { color: '#1b5142', fontWeight: '800', fontSize: 15 }, cardBottom: { marginTop: 14 }, button: { backgroundColor: '#176d55', borderRadius: 11, paddingVertical: 15, paddingHorizontal: 18, alignItems: 'center', marginTop: 10 }, buttonSecondary: { backgroundColor: '#e8f3ee' }, buttonText: { color: '#fff', fontWeight: '700', fontSize: 14 }, buttonSecondaryText: { color: '#176d55' }, disabled: { opacity: 0.45 }, quantity: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f2f7f4', borderRadius: 9 }, quantityButton: { fontSize: 23, color: '#176d55', paddingHorizontal: 13, paddingVertical: 4 }, quantityNumber: { minWidth: 20, textAlign: 'center', fontWeight: '700', color: '#19332d' }, remove: { color: '#a5554a', fontWeight: '600' }, discountRow: { flexDirection: 'row', gap: 7, marginTop: 10 }, chip: { borderWidth: 1, borderColor: '#dce8e2', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 }, chipActive: { backgroundColor: '#176d55', borderColor: '#176d55' }, chipText: { color: '#48635b' }, chipActiveText: { color: '#fff', fontWeight: '700' }, hint: { color: '#81908c', fontSize: 11, marginTop: 8 }, totalCard: { backgroundColor: '#e9f4ee', borderRadius: 14, padding: 16, marginTop: 8, marginBottom: 10 }, rowLabel: { color: '#62756f', flexShrink: 1 }, rowValue: { color: '#263f38', fontWeight: '600' }, strong: { color: '#165d49', fontWeight: '800', fontSize: 18, marginTop: 8 }, disclaimer: { color: '#826039', backgroundColor: '#fff2d7', borderRadius: 10, padding: 14, lineHeight: 20, marginBottom: 5 }, footer: { color: '#9caaa6', textAlign: 'center', fontSize: 10, letterSpacing: 1, marginTop: 35 },
});
