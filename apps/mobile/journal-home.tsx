import React, { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

// Écran « Journal du jour » v2 : présentation uniquement. Toute la logique reste dans App.tsx.
const J = {
  ink: '#0F1B3D', accent: '#2DD4BF', bg: '#F4F5FA', muted: '#5A6482', mutedOnInk: '#A3AECB', track: '#2A3560',
  chip: '#E6E9F5', okBg: '#DDF5EA', okText: '#0B6B4A', warnBg: '#FFF0C2', warnText: '#6B4E00', badBg: '#FFE0E4', badText: '#A3203A', danger: '#FF9FAE',
};
export type JournalTone = 'mint' | 'amber' | 'coral';
export type JournalHomeRow = { id: string; name: string; sector: string; total: string; status: string; tone: JournalTone };
type Filter = 'all' | 'todo' | 'paid';

const initialsOf = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?';
const splitMoney = (value: string) => { const i = value.lastIndexOf(' '); return i < 0 ? { n: value, u: '' } : { n: value.slice(0, i), u: value.slice(i + 1) }; };
const toneStyle = (tone: JournalTone) => tone === 'mint' ? { bg: J.okBg, fg: J.okText } : tone === 'amber' ? { bg: J.warnBg, fg: J.warnText } : { bg: J.badBg, fg: J.badText };

export function JournalHome(p: {
  title: string; subtitle: string; commercialName: string; pendingCount: number; pendingKnown: boolean; onOpenMenu: () => void;
  notices: string[]; errorNotice?: string;
  total: string; clientCount: number; collected: string; rest: string; settledPercent: number | null;
  rows: JournalHomeRow[]; loading: boolean;
  addDisabled: boolean; exportDisabled: boolean; onAdd: () => void; onExport: () => void; onOpenRow: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [dismissed, setDismissed] = useState(false);
  const todo = p.rows.filter(r => r.tone !== 'mint');
  const paid = p.rows.filter(r => r.tone === 'mint');
  const shown = filter === 'todo' ? todo : filter === 'paid' ? paid : p.rows;
  const t = splitMoney(p.total);
  const pct = p.settledPercent===null ? null : Math.max(0, Math.min(100, p.settledPercent));
  const chips: { key: Filter; label: string }[] = [{ key: 'all', label: `Toutes ${p.rows.length}` }, { key: 'todo', label: `À encaisser ${todo.length}` }, { key: 'paid', label: `Soldées ${paid.length}` }];
  return <View style={s.root}>
    <View style={s.top}>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Ouvrir le menu" onPress={p.onOpenMenu} style={s.avatar}><Text style={s.avatarText}>{initialsOf(p.commercialName)}</Text></TouchableOpacity>
      <View style={s.flex}><Text style={s.title}>{p.title}</Text><Text style={s.subtitle}>{p.subtitle}</Text></View>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Ouvrir le menu des opérations locales" onPress={p.onOpenMenu} style={s.sync}><View style={[s.dot, p.pendingKnown && p.pendingCount === 0 && { backgroundColor: '#1F9D6B' }]} /><Text style={s.syncText}>{!p.pendingKnown ? 'À vérifier' : p.pendingCount > 0 ? `${p.pendingCount} en attente` : 'Local : 0 en attente'}</Text></TouchableOpacity>
    </View>
    {!!p.errorNotice && <Text accessibilityRole="alert" style={s.error}>{p.errorNotice}</Text>}
    {!dismissed && p.notices.length > 0 && <View style={s.banner}><View style={s.flex}>{p.notices.map((n, i) => <Text key={i} style={s.bannerText}>{n}</Text>)}</View><TouchableOpacity accessibilityRole="button" accessibilityLabel="Fermer l’information" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} onPress={() => setDismissed(true)} style={s.bannerClose}><Text style={s.bannerCloseText}>×</Text></TouchableOpacity></View>}
    <View style={s.hero}>
      <View style={s.heroTop}><Text style={s.heroLabel}>Total facturé du jour</Text><Text style={s.heroChip}>{p.clientCount} client{p.clientCount > 1 ? 's' : ''}</Text></View>
      <Text style={s.heroAmount} adjustsFontSizeToFit numberOfLines={1}>{t.n}<Text style={s.heroUnit}> {t.u}</Text></Text>
      {pct!==null&&<View style={s.track}><View style={[s.fill, { width: `${pct}%` }]} /></View>}
      <Text style={s.heroNote}>{pct===null ? 'Règlements à vérifier sur ce téléphone' : `${Math.round(pct)} % du montant facturé réglé · sur ce téléphone`}</Text>
    </View>
    <View style={s.tiles}>
      <View style={s.tile}><Text style={s.tileLabel}>Encaissé (net, local)</Text><Text style={s.tileValue}>{p.collected}</Text></View>
      <View style={[s.tile, { backgroundColor: J.warnBg }]}><Text style={[s.tileLabel, { color: J.warnText }]}>Reste sur factures</Text><Text style={s.tileValue}>{p.rest}</Text></View>
    </View>
    <View style={s.actions}>
      <TouchableOpacity accessibilityRole="button" activeOpacity={0.85} disabled={p.addDisabled} onPress={p.onAdd} style={[s.add, p.addDisabled && s.off]}><Text style={s.addText}>+ Facture préétablie</Text></TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Exporter le journal" activeOpacity={0.85} disabled={p.exportDisabled} onPress={p.onExport} style={[s.exp, p.exportDisabled && s.off]}><Text style={s.expText}>⤓</Text></TouchableOpacity>
    </View>
    <Text style={s.section}>Clients du jour</Text>
    <View style={s.chips}>{chips.map(c => <TouchableOpacity key={c.key} accessibilityRole="button" accessibilityState={{ selected: filter === c.key }} onPress={() => setFilter(c.key)} style={[s.chipBtn, filter === c.key && s.chipOn]}><Text style={[s.chipText, filter === c.key && s.chipTextOn]}>{c.label}</Text></TouchableOpacity>)}</View>
    {p.loading ? <Text style={s.empty}>Chargement du journal…</Text> : shown.length === 0 ? <Text style={s.empty}>{p.rows.length === 0 ? 'Aucun client dans le journal du jour.' : 'Aucun client dans ce filtre.'}</Text> : null}
    {shown.map(r => { const tone = toneStyle(r.tone); return <TouchableOpacity key={r.id} accessibilityRole="button" activeOpacity={0.8} onPress={() => p.onOpenRow(r.id)} style={s.row}>
      <View style={s.ic}><Text style={s.icText}>{initialsOf(r.name)}</Text></View>
      <View style={s.flex}><Text style={s.rowName} numberOfLines={1}>{r.name}</Text><Text style={s.rowSub} numberOfLines={1}>{r.sector}</Text></View>
      <View style={s.amount}><Text style={s.rowTotal}>{r.total}</Text><Text style={[s.status, { backgroundColor: tone.bg, color: tone.fg }]}>{r.status}</Text></View>
    </TouchableOpacity>; })}
  </View>;
}

export type DrawerItem = { key: string; label: string; hint?: string; onPress: () => void; disabled?: boolean };

export function JournalDrawer(p: {
  visible: boolean; onClose: () => void; name: string; sessionLabel: string; pendingCount: number; pendingKnown: boolean;
  syncBusy: boolean; syncDisabled: boolean; onSync: () => void; items: DrawerItem[]; closeItem?: DrawerItem; footer: string;
}) {
  const run = (fn: () => void) => () => { p.onClose(); fn(); };
  return <Modal visible={p.visible} transparent animationType="fade" onRequestClose={p.onClose}>
    <View style={d.wrap}>
      <View style={[d.panel, Platform.OS === 'android' ? { paddingTop: (StatusBar.currentHeight ?? 0) + 24 } : null]}>
        <ScrollView showsVerticalScrollIndicator contentContainerStyle={d.menuContent}>
        <View style={d.me}><View style={d.avatar}><Text style={d.avatarText}>{initialsOf(p.name)}</Text></View><View style={d.flex}><Text style={d.name} numberOfLines={1}>{p.name}</Text><Text style={d.session}>{p.sessionLabel}</Text></View></View>
        <View style={d.card}>
          <Text style={d.cardLabel}>Éléments locaux en attente</Text>
          <Text style={d.cardValue}>{p.pendingKnown ? String(p.pendingCount) : 'À vérifier'}</Text>
          <TouchableOpacity accessibilityRole="button" disabled={p.syncDisabled} onPress={run(p.onSync)} style={[d.cardBtn, p.syncDisabled && d.off]}><Text style={d.cardBtnText}>{p.syncBusy ? 'Synchronisation…' : 'Synchroniser maintenant'}</Text></TouchableOpacity>
        </View>
        {p.items.map(i => <TouchableOpacity key={i.key} accessibilityRole="button" disabled={i.disabled} onPress={run(i.onPress)} style={[d.item, i.disabled && d.off]}><Text style={d.itemLabel}>{i.label}</Text>{i.hint ? <Text style={d.itemHint}>{i.hint}</Text> : null}</TouchableOpacity>)}
        <View style={d.flex} />
        {p.closeItem ? <TouchableOpacity accessibilityRole="button" disabled={p.closeItem.disabled} onPress={run(p.closeItem.onPress)} style={[d.close, p.closeItem.disabled && d.off]}><Text style={d.closeText}>{p.closeItem.label}</Text></TouchableOpacity> : null}
        <Text style={d.footer}>{p.footer}</Text>
        </ScrollView>
      </View>
      <Pressable accessibilityLabel="Fermer le menu" accessibilityRole="button" onPress={p.onClose} style={d.scrim} />
    </View>
  </Modal>;
}

const s = StyleSheet.create({
  root: { marginBottom: 8 }, flex: { flex: 1 }, off: { opacity: 0.45 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: J.ink, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: J.accent, fontWeight: '800', fontSize: 15 },
  title: { fontSize: 22, fontWeight: '800', color: J.ink, letterSpacing: -0.3 }, subtitle: { fontSize: 12.5, color: J.muted },
  sync: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, paddingHorizontal: 14, borderRadius: 22, backgroundColor: '#FFFFFF' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#F2A93B' }, syncText: { fontSize: 13, fontWeight: '700', color: J.ink },
  banner: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1EEE4', borderRadius: 14, paddingLeft: 14, minHeight: 44, marginBottom: 8, paddingVertical: 8 },
  bannerText: { fontSize: 13, lineHeight: 18, color: '#4F5E59' }, bannerClose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, bannerCloseText: { fontSize: 22, color: '#4F5E59' },
  error: { color: J.badText, backgroundColor: J.badBg, borderRadius: 14, overflow: 'hidden', padding: 12, fontSize: 13, fontWeight: '700', marginBottom: 8 },
  hero: { backgroundColor: J.ink, borderRadius: 32, padding: 20 },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, heroLabel: { color: J.mutedOnInk, fontSize: 13.5, fontWeight: '600' },
  heroChip: { backgroundColor: J.accent, color: J.ink, fontSize: 12, fontWeight: '700', borderRadius: 999, overflow: 'hidden', paddingHorizontal: 10, paddingVertical: 5 },
  heroAmount: { color: '#FFFFFF', fontSize: 44, fontWeight: '800', letterSpacing: -1.2, marginTop: 10, marginBottom: 14 }, heroUnit: { color: J.accent, fontSize: 18, fontWeight: '800' },
  track: { height: 12, borderRadius: 6, backgroundColor: J.track, overflow: 'hidden' }, fill: { height: 12, borderRadius: 6, backgroundColor: J.accent },
  heroNote: { color: J.mutedOnInk, fontSize: 12.5, marginTop: 8 },
  tiles: { flexDirection: 'row', gap: 8, marginTop: 8 }, tile: { flex: 1, backgroundColor: '#FFFFFF', borderRadius: 24, padding: 14 },
  tileLabel: { fontSize: 12.5, color: J.muted, fontWeight: '600' }, tileValue: { fontSize: 18, fontWeight: '800', color: J.ink, marginTop: 2 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  add: { flex: 1, height: 56, borderRadius: 28, backgroundColor: J.accent, alignItems: 'center', justifyContent: 'center' }, addText: { color: J.ink, fontSize: 16, fontWeight: '800' },
  exp: { width: 56, height: 56, borderRadius: 28, backgroundColor: J.ink, alignItems: 'center', justifyContent: 'center' }, expText: { color: '#FFFFFF', fontSize: 24, fontWeight: '700' },
  section: { fontSize: 15, fontWeight: '800', color: J.ink, marginTop: 18, marginBottom: 8, marginLeft: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  chipBtn: { height: 44, borderRadius: 22, paddingHorizontal: 16, justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: J.chip },
  chipOn: { backgroundColor: J.ink, borderColor: J.ink }, chipText: { fontSize: 14, fontWeight: '600', color: '#3B4670' }, chipTextOn: { color: '#FFFFFF' },
  empty: { color: J.muted, fontSize: 14, padding: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#FFFFFF', borderRadius: 22, padding: 14, minHeight: 68, marginBottom: 8 },
  ic: { width: 42, height: 42, borderRadius: 21, backgroundColor: J.chip, alignItems: 'center', justifyContent: 'center' }, icText: { fontWeight: '800', fontSize: 13, color: J.ink },
  rowName: { fontSize: 15.5, fontWeight: '700', color: J.ink }, rowSub: { fontSize: 12.5, color: J.muted },
  amount: { alignItems: 'flex-end' }, rowTotal: { fontSize: 15.5, fontWeight: '800', color: J.ink },
  status: { marginTop: 3, borderRadius: 999, overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 2, fontSize: 11, fontWeight: '700' },
});
const d = StyleSheet.create({
  wrap: { flex: 1, flexDirection: 'row' }, flex: { flex: 1 }, off: { opacity: 0.45 }, menuContent: { flexGrow: 1 },
  panel: { width: 320, maxWidth: '88%', backgroundColor: J.ink, paddingTop: 56, paddingHorizontal: 16, paddingBottom: 28, borderTopRightRadius: 32, borderBottomRightRadius: 32 },
  scrim: { flex: 1, backgroundColor: 'rgba(15,27,61,0.5)' },
  me: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 18 },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: J.accent, alignItems: 'center', justifyContent: 'center' }, avatarText: { color: J.ink, fontWeight: '800', fontSize: 16 },
  name: { color: '#FFFFFF', fontSize: 17, fontWeight: '800' }, session: { color: J.mutedOnInk, fontSize: 13 },
  card: { backgroundColor: J.accent, borderRadius: 24, padding: 16, marginBottom: 12 },
  cardLabel: { color: J.ink, fontSize: 14, fontWeight: '600' }, cardValue: { color: J.ink, fontSize: 22, fontWeight: '800', marginBottom: 12 },
  cardBtn: { height: 48, borderRadius: 24, backgroundColor: J.ink, alignItems: 'center', justifyContent: 'center' }, cardBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  item: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 60, paddingHorizontal: 10 },
  itemLabel: { color: '#FFFFFF', fontSize: 16, fontWeight: '600', flex: 1 }, itemHint: { color: J.mutedOnInk, fontSize: 13, fontWeight: '700' },
  close: { height: 54, borderRadius: 27, borderWidth: 2, borderColor: J.danger, alignItems: 'center', justifyContent: 'center' }, closeText: { color: J.danger, fontSize: 15, fontWeight: '700' },
  footer: { color: J.mutedOnInk, fontSize: 12, textAlign: 'center', marginTop: 12 },
});
