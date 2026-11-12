/** Représentation déterministe d'une valeur JSON, indépendante de l'ordre des clés PostgreSQL. */
export function canonicalJson(value: unknown): string {
 if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
 if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
 if (typeof value === 'object') {
  const record=value as Record<string,unknown>;
  return `{${Object.keys(record).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
 }
 throw new TypeError('Valeur JSON invalide.');
}

