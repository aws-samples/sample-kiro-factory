/*
 * Cost formatting, one source for the credit to dollar rate.
 *
 * The server sends raw kiro-cli credits; the dollar figure is worked out here.
 * Copied from kiro-flock's web/costFormat.js.
 */

/** Overage rate in $ per credit. */
export const OVERAGE_RATE = 0.04;

/** Convert raw credits to USD at the overage rate. */
export function creditsToUsd(credits: number): number {
  return credits * OVERAGE_RATE;
}

/** "12.34 cr, $0.49". */
export function fmtCredits(credits: number): string {
  return `${credits.toFixed(2)} cr, $${creditsToUsd(credits).toFixed(2)}`;
}

/** "$0.0042" below a cent, "$1.23" otherwise. */
export function fmtUsd(usd: number): string {
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}
