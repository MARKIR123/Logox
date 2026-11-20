import {log} from '../logger.mjs';

export function chargeInvoice(invoiceId, cents) {
  if (cents <= 0) {
    log('error', 'Invalid invoice amount for ' + invoiceId);
    return {ok: false};
  }
  log('info', 'Charged invoice ' + invoiceId);
  return {ok: true, cents};
}
