/** Recherche locale exhaustive ; les pages ne limitent que les lignes montées
 * à l'écran, jamais les données, la recherche ou le calcul des soldes. */
export type SearchEntry<T>={item:T;key:string};
export const searchText=(text:string)=>text.trim().toLocaleLowerCase();
export function indexSearch<T>(items:readonly T[],text:(item:T)=>string):SearchEntry<T>[] {
 return items.map(item=>({item,key:searchText(text(item))}));
}
export function searchIndexed<T>(index:readonly SearchEntry<T>[],query:string):T[] {
 const needle=searchText(query);
 return index.filter(entry=>entry.key.includes(needle)).map(entry=>entry.item);
}
export function firstPage<T>(items:readonly T[],visible:number):{items:T[];total:number;hasMore:boolean} {
 if(!Number.isSafeInteger(visible)||visible<1)throw Error('Taille de page invalide.');
 return {items:items.slice(0,visible),total:items.length,hasMore:items.length>visible};
}
