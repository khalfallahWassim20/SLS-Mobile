/** Sélection à la compilation exclusivement pour le banc de données fictives.
 * Jamais un mécanisme d'activation du protocole sur les téléphones réels. */
export const ISOLATED_DAY_INVOICE_TEST=process.env.EXPO_PUBLIC_SLS_V6_TEST_ONLY==='DONNEES_FICTIVES_ISOLEES';
export const DAY_INVOICE_TEST_ACK='DONNEES_FICTIVES_ISOLEES';
