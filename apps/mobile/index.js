import { registerRootComponent } from 'expo';
import App from './App';
import {DayInvoiceIsolatedApp} from './day-invoice-isolated-app';
import {ISOLATED_DAY_INVOICE_TEST} from './day-invoice-isolated-mode';
registerRootComponent(ISOLATED_DAY_INVOICE_TEST ? DayInvoiceIsolatedApp : App);
