import {logger} from '../logger.mjs';

export function chargeInvoice(invoiceId, cents) {
  if (cents <= 0) {
    logger.error('Invalid invoice amount for ' + invoiceId);
    return {ok: false};
  }
  logger.info('Charged invoice ' + invoiceId);
  return {ok: true, cents};
}
