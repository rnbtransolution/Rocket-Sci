import { Env } from './types.js';
import { state } from './state.js';

/**
 * Where players are told to transfer their deposit money.
 *
 * These used to be hardcoded in the deposit Flex template (SCB 890-1-23456-7 /
 * Somchai Jongcharoen — placeholders). Changing a bank account therefore
 * required a code change and a redeploy, and there was no way for the operator
 * to check what players were actually being told from the Admin Console.
 *
 * Now the Admin Console owns these values. The literals below are only the
 * starting defaults for an installation that has never been configured.
 */

export interface PaymentBankDetails {
  bankName: string;
  accountNumber: string;
  accountName: string;
  /** Optional line shown under the account, e.g. a prompt or a QR note. */
  note?: string;
}

const STORAGE_KEY = 'PAYMENT_BANK_DETAILS';

/** Placeholders from the original template — used only until an admin saves. */
export const DEFAULT_PAYMENT_BANK: PaymentBankDetails = {
  bankName: 'SCB (ไทยพาณิชย์)',
  accountNumber: '890-1-23456-7',
  accountName: 'Somchai Jongcharoen',
};

function sanitise(input: any): PaymentBankDetails | null {
  const bankName = String(input?.bankName ?? '').trim();
  const accountNumber = String(input?.accountNumber ?? '').trim();
  const accountName = String(input?.accountName ?? '').trim();
  if (!bankName || !accountNumber || !accountName) return null;

  const note = String(input?.note ?? '').trim();
  return {
    bankName: bankName.slice(0, 80),
    accountNumber: accountNumber.slice(0, 40),
    accountName: accountName.slice(0, 120),
    note: note ? note.slice(0, 200) : undefined,
  };
}

/**
 * Read the configured account, falling back to the built-in defaults.
 *
 * Never throws and never returns an incomplete record: the deposit screen must
 * always be able to tell a player where to transfer, because a blank account
 * number would send their money nowhere.
 */
export async function getPaymentBank(env: Env): Promise<PaymentBankDetails> {
  try {
    const raw = await state(env).get(STORAGE_KEY);
    if (raw) {
      const parsed = sanitise(JSON.parse(raw));
      if (parsed) return parsed;
    }
  } catch (err) {
    console.warn('[PaymentBank] read failed, using defaults:', err);
  }
  return { ...DEFAULT_PAYMENT_BANK };
}

/** Persist a new account. Returns the stored value, or null if invalid. */
export async function setPaymentBank(env: Env, input: any): Promise<PaymentBankDetails | null> {
  const cleaned = sanitise(input);
  if (!cleaned) return null;
  await state(env).put(STORAGE_KEY, JSON.stringify(cleaned));
  return cleaned;
}
