export type PointHundredths = number;
export type AccountKind = 'player' | 'house';
export type TransactionStatus = 'pending' | 'approved' | 'rejected';
export type LedgerEventType =
  | 'opening_balance'
  | 'admin_adjustment'
  | 'withdrawal_requested'
  | 'withdrawal_rejected'
  | 'order_hold'
  | 'order_matched'
  | 'order_cancelled'
  | 'order_settled'
  | 'house_fee';

export type CoordinatorErrorCode =
  | 'AUTHORITY_NOT_READY'
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_STATE'
  | 'STAKE_MISMATCH'
  | 'NOT_FOUND'
  | 'DUPLICATE_ID'
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'IMPORT_CONFLICT'
  | 'INTERNAL';

const errorStatuses: Record<CoordinatorErrorCode, number> = {
  AUTHORITY_NOT_READY: 503,
  INSUFFICIENT_FUNDS: 409,
  INVALID_STATE: 409,
  STAKE_MISMATCH: 409,
  NOT_FOUND: 404,
  DUPLICATE_ID: 409,
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  IMPORT_CONFLICT: 409,
  INTERNAL: 500,
};

export class CoordinatorError extends Error {
  readonly status: number;

  constructor(readonly code: CoordinatorErrorCode, message: string) {
    super(message);
    this.name = 'CoordinatorError';
    this.status = errorStatuses[code];
  }
}

export function validateIdentifier(value: unknown, label: string, maxLength = 128): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new CoordinatorError('INVALID_INPUT', `${label} is invalid`);
  }
  return value;
}

export function validateText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || !value.trim()) {
    throw new CoordinatorError('INVALID_INPUT', `${label} is invalid`);
  }
  return value.trim();
}

export function validatePointHundredths(
  value: unknown,
  label: string,
  allowZero = true,
): PointHundredths {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (!allowZero && value === 0)
  ) {
    throw new CoordinatorError('INVALID_INPUT', `${label} must be a safe nonnegative integer`);
  }
  return value;
}

export function wholePointsToHundredths(value: unknown, label = 'amount'): PointHundredths {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new CoordinatorError('INVALID_INPUT', `${label} must be a positive whole-point amount`);
  }
  const converted = value * 100;
  if (!Number.isSafeInteger(converted)) {
    throw new CoordinatorError('INVALID_INPUT', `${label} exceeds the supported range`);
  }
  return converted;
}

export function validateStakeHundredths(value: unknown): PointHundredths {
  const stake = validatePointHundredths(value, 'stakeHundredths', false);
  if (stake % 100 !== 0) {
    throw new CoordinatorError(
      'INVALID_INPUT',
      'stakeHundredths must be a positive whole-point amount',
    );
  }
  return stake;
}

export interface LedgerAccount {
  readonly playerId: string;
  readonly lineUserId: string | null;
  readonly displayName: string;
  readonly balanceHundredths: PointHundredths;
  readonly active: boolean;
  readonly kind: AccountKind;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LedgerEntry {
  readonly entryId: string;
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly deltaHundredths: number;
  readonly balanceAfterHundredths: PointHundredths;
  readonly eventType: LedgerEventType;
  readonly referenceId: string | null;
  readonly actorId: string | null;
  readonly reason: string | null;
  readonly createdAt: number;
}

export interface FinancialTransaction {
  readonly transactionId: string;
  readonly playerId: string;
  readonly type: 'withdrawal';
  readonly requestedAmountHundredths: PointHundredths;
  readonly actualAmountHundredths: PointHundredths | null;
  readonly status: TransactionStatus;
  readonly bankName: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly actorId: string | null;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RocketRound {
  readonly roundId: string;
  readonly name: string;
  readonly status: 'active' | 'closed' | 'void';
  readonly quoteReleased: boolean;
  readonly targetMin: number | null;
  readonly targetMax: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LedgerOrder {
  readonly orderNumber: string;
  readonly roundId: string;
  readonly creatorId: string;
  readonly creatorName: string;
  readonly matcherId: string | null;
  readonly matcherName: string | null;
  readonly side: 'low' | 'high';
  readonly stakeHundredths: PointHundredths;
  readonly betType: 'range' | 'custom_range' | 'pre_quote';
  readonly rangeMin: number;
  readonly rangeMax: number;
  readonly status: 'pending_hold' | 'pending_match' | 'matched' | 'cancelled' | 'resolved' | 'settled' | 'void';
  readonly groupId: string;
  readonly createdAt: number;
  readonly matchedAt: number | null;
  readonly winnerSide: 'low' | 'high' | 'draw' | null;
  readonly finalSeconds: number | null;
  readonly settledAt: number | null;
}

export interface DashboardSnapshot {
  readonly accounts: LedgerAccount[];
  readonly transactions: FinancialTransaction[];
  readonly totalBalanceHundredths: PointHundredths;
}

export interface CreatePlayerInput {
  idempotencyKey: string;
  playerId: string;
  lineUserId: string;
  displayName: string;
  openingBalanceHundredths: PointHundredths;
}

export interface AdjustBalanceInput {
  idempotencyKey: string;
  playerId: string;
  targetBalanceHundredths: PointHundredths;
  actorId: string;
  reason: string;
}

export interface DeactivatePlayerInput {
  idempotencyKey: string;
  playerId: string;
  actorId: string;
}

export interface RequestWithdrawalInput {
  idempotencyKey: string;
  transactionId: string;
  playerId: string;
  amountHundredths: PointHundredths;
  bankName: string;
  accountNumber: string;
  accountName: string;
}

export interface ReviewTransactionInput {
  idempotencyKey: string;
  transactionId: string;
  decision: 'approve' | 'reject';
  actualAmountHundredths: PointHundredths;
  actorId: string;
  reason: string;
}

export interface OpenRoundInput {
  idempotencyKey: string;
  roundId: string;
  name: string;
}

export interface CreateOrderInput {
  idempotencyKey: string;
  roundId: string;
  creatorId: string;
  side: 'low' | 'high';
  stakeHundredths: PointHundredths;
  betType: 'range' | 'custom_range' | 'pre_quote';
  rangeMin: number;
  rangeMax: number;
  creatorName: string;
  groupId: string;
}

export interface MatchOrderInput {
  idempotencyKey: string;
  orderNumber: string;
  matcherId: string;
  stakeHundredths: PointHundredths;
  matcherName: string;
}

export interface CancelOrderInput {
  idempotencyKey: string;
  orderNumber: string;
  actorId: string;
}

export interface ReleaseQuoteInput {
  idempotencyKey: string;
  roundId: string;
  targetMin: number;
  targetMax: number;
}

export interface CloseRoundInput {
  idempotencyKey: string;
  roundId: string;
}

export interface VoidRoundInput {
  idempotencyKey: string;
  roundId: string;
}

export interface ResolveRoundInput {
  idempotencyKey: string;
  roundId: string;
  finalSeconds: number;
}

export interface RoundReleaseResult {
  readonly round: RocketRound;
  readonly releasedOrderNumbers: string[];
}

export interface RoundCloseResult {
  readonly round: RocketRound;
  readonly cancelledOrderNumbers: string[];
}

export interface RoundVoidResult {
  readonly round: RocketRound;
  readonly refundedOrderNumbers: string[];
}

export interface SettledOrderResult {
  readonly orderNumber: string;
  readonly status: LedgerOrder['status'];
  readonly winnerSide: 'low' | 'high' | 'draw' | null;
  readonly winnerCreditHundredths: PointHundredths;
  readonly houseFeeHundredths: PointHundredths;
  readonly balances: Record<string, PointHundredths>;
}

export interface RoundSettlementResult {
  readonly round: RocketRound;
  readonly orders: SettledOrderResult[];
}

export interface FinancialSnapshot {
  readonly accounts: LedgerAccount[];
  readonly transactions: FinancialTransaction[];
  readonly rounds: RocketRound[];
  readonly orders: LedgerOrder[];
}

export interface ImportPreview {
  readonly canImport: boolean;
  readonly conflicts: string[];
  readonly accountCount: number;
  readonly transactionCount: number;
  readonly roundCount: number;
  readonly orderCount: number;
}

export interface ImportFinancialSnapshotInput {
  idempotencyKey: string;
  snapshot: FinancialSnapshot;
  provenance: string;
}

export interface ImportResult {
  readonly importedAccountCount: number;
  readonly importedTransactionCount: number;
  readonly importedRoundCount: number;
  readonly importedOrderCount: number;
}

export interface ActivateAuthorityInput {
  idempotencyKey: string;
  operatorId: string;
  confirmation: string;
}

export interface CoordinatorClient {
  getAccount(playerId: string): Promise<LedgerAccount | null>;
  getLedgerEntries(playerId: string): Promise<LedgerEntry[]>;
  getSnapshot(): Promise<DashboardSnapshot>;
  createPlayer(input: CreatePlayerInput): Promise<LedgerAccount>;
  adjustBalance(input: AdjustBalanceInput): Promise<LedgerAccount>;
  deactivatePlayer(input: DeactivatePlayerInput): Promise<LedgerAccount>;
  requestWithdrawal(input: RequestWithdrawalInput): Promise<FinancialTransaction>;
  reviewTransaction(input: ReviewTransactionInput): Promise<FinancialTransaction>;
  openRound(input: OpenRoundInput): Promise<RocketRound>;
  createOrder(input: CreateOrderInput): Promise<LedgerOrder>;
  matchOrder(input: MatchOrderInput): Promise<LedgerOrder>;
  cancelOrder(input: CancelOrderInput): Promise<LedgerOrder>;
  releaseQuote(input: ReleaseQuoteInput): Promise<RoundReleaseResult>;
  closeRound(input: CloseRoundInput): Promise<RoundCloseResult>;
  voidRound(input: VoidRoundInput): Promise<RoundVoidResult>;
  resolveRound(input: ResolveRoundInput): Promise<RoundSettlementResult>;
  previewImport(input: FinancialSnapshot): Promise<ImportPreview>;
  importSnapshot(input: ImportFinancialSnapshotInput): Promise<ImportResult>;
  activateAuthority(input: ActivateAuthorityInput): Promise<void>;
}
