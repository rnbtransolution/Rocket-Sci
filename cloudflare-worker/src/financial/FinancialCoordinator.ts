import type { Env } from '../types';
import {
  CoordinatorError,
  validateIdentifier,
  validatePointHundredths,
  validateText,
  type AccountKind,
  type CreatePlayerInput,
  type DashboardSnapshot,
  type DeactivatePlayerInput,
  type AdjustBalanceInput,
  type FinancialTransaction,
  type LedgerAccount,
  type LedgerEntry,
  type LedgerEventType,
  type RequestWithdrawalInput,
  type ReviewTransactionInput,
} from './types';

const HOUSE_ACCOUNT_ID = '__house__';

interface RpcRequest {
  operation?: string;
  input?: unknown;
}

interface AccountRow {
  [key: string]: string | number | null;
  player_id: string;
  line_user_id: string | null;
  display_name: string;
  balance_hundredths: number;
  active: number;
  kind: AccountKind;
  created_at: number;
  updated_at: number;
}

interface LedgerRow {
  [key: string]: string | number | null;
  entry_id: string;
  account_id: string;
  idempotency_key: string;
  delta_hundredths: number;
  balance_after_hundredths: number;
  event_type: LedgerEventType;
  reference_id: string | null;
  actor_id: string | null;
  reason: string | null;
  created_at: number;
}

interface TransactionRow {
  [key: string]: string | number | null;
  transaction_id: string;
  player_id: string;
  type: 'withdrawal';
  requested_amount_hundredths: number;
  actual_amount_hundredths: number | null;
  status: 'pending' | 'approved' | 'rejected';
  bank_name: string;
  account_number: string;
  account_name: string;
  actor_id: string | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

interface IdempotencyRow {
  [key: string]: string | number | null;
  request_fingerprint: string;
  result_json: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoordinatorError('INVALID_INPUT', 'Command input must be an object');
  }
  return value as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function mapAccount(row: AccountRow): LedgerAccount {
  return {
    playerId: row.player_id,
    lineUserId: row.line_user_id,
    displayName: row.display_name,
    balanceHundredths: row.balance_hundredths,
    active: row.active === 1,
    kind: row.kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLedgerEntry(row: LedgerRow): LedgerEntry {
  return {
    entryId: row.entry_id,
    accountId: row.account_id,
    idempotencyKey: row.idempotency_key,
    deltaHundredths: row.delta_hundredths,
    balanceAfterHundredths: row.balance_after_hundredths,
    eventType: row.event_type,
    referenceId: row.reference_id,
    actorId: row.actor_id,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function mapTransaction(row: TransactionRow): FinancialTransaction {
  return {
    transactionId: row.transaction_id,
    playerId: row.player_id,
    type: row.type,
    requestedAmountHundredths: row.requested_amount_hundredths,
    actualAmountHundredths: row.actual_amount_hundredths,
    status: row.status,
    bankName: row.bank_name,
    accountNumber: row.account_number,
    accountName: row.account_name,
    actorId: row.actor_id,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class FinancialCoordinator {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    this.initializeSchema();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/rpc') {
      return this.errorResponse(new CoordinatorError('NOT_FOUND', 'Coordinator endpoint not found'));
    }

    try {
      const body = asRecord(await request.json() as RpcRequest);
      const operation = validateIdentifier(body.operation, 'operation', 64);
      const result = this.dispatch(operation, body.input);
      return Response.json({ result });
    } catch (error) {
      if (error instanceof CoordinatorError) return this.errorResponse(error);
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        return this.errorResponse(new CoordinatorError('DUPLICATE_ID', 'Identifier already exists'));
      }
      return this.errorResponse(new CoordinatorError('INTERNAL', 'Coordinator operation failed'));
    }
  }

  private errorResponse(error: CoordinatorError): Response {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }

  private dispatch(operation: string, rawInput: unknown): unknown {
    switch (operation) {
      case 'getAccount': {
        const input = asRecord(rawInput);
        return this.getAccount(validateIdentifier(input.playerId, 'playerId'));
      }
      case 'getLedgerEntries': {
        const input = asRecord(rawInput);
        return this.getLedgerEntries(validateIdentifier(input.playerId, 'playerId'));
      }
      case 'getSnapshot':
        return this.getSnapshot();
      case 'createPlayer':
        return this.createPlayer(asRecord(rawInput) as unknown as CreatePlayerInput);
      case 'adjustBalance':
        return this.adjustBalance(asRecord(rawInput) as unknown as AdjustBalanceInput);
      case 'deactivatePlayer':
        return this.deactivatePlayer(asRecord(rawInput) as unknown as DeactivatePlayerInput);
      case 'requestWithdrawal':
        return this.requestWithdrawal(asRecord(rawInput) as unknown as RequestWithdrawalInput);
      case 'reviewTransaction':
        return this.reviewTransaction(asRecord(rawInput) as unknown as ReviewTransactionInput);
      default:
        throw new CoordinatorError('INVALID_INPUT', `Unsupported coordinator operation: ${operation}`);
    }
  }

  private initializeSchema(): void {
    const sql = this.state.storage.sql;
    sql.exec('PRAGMA foreign_keys = ON');
    sql.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        player_id TEXT PRIMARY KEY,
        line_user_id TEXT UNIQUE,
        display_name TEXT NOT NULL,
        balance_hundredths INTEGER NOT NULL CHECK (balance_hundredths >= 0),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        kind TEXT NOT NULL CHECK (kind IN ('player', 'house')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS ledger (
        entry_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(player_id),
        idempotency_key TEXT NOT NULL,
        delta_hundredths INTEGER NOT NULL,
        balance_after_hundredths INTEGER NOT NULL CHECK (balance_after_hundredths >= 0),
        event_type TEXT NOT NULL,
        reference_id TEXT,
        actor_id TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (account_id, idempotency_key)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        transaction_id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES accounts(player_id),
        type TEXT NOT NULL CHECK (type IN ('withdrawal')),
        requested_amount_hundredths INTEGER NOT NULL CHECK (requested_amount_hundredths > 0),
        actual_amount_hundredths INTEGER CHECK (actual_amount_hundredths >= 0),
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        bank_name TEXT NOT NULL,
        account_number TEXT NOT NULL,
        account_name TEXT NOT NULL,
        actor_id TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS rounds (
        round_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'void')),
        quote_released INTEGER NOT NULL CHECK (quote_released IN (0, 1)),
        target_min REAL,
        target_max REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        order_number TEXT PRIMARY KEY,
        round_id TEXT NOT NULL REFERENCES rounds(round_id),
        creator_id TEXT NOT NULL REFERENCES accounts(player_id),
        matcher_id TEXT REFERENCES accounts(player_id),
        stake_hundredths INTEGER NOT NULL CHECK (stake_hundredths > 0),
        status TEXT NOT NULL,
        order_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_results (
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (operation, idempotency_key)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS projection_outbox (
        outbox_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      )
    `);
    sql.exec(`
      CREATE TRIGGER IF NOT EXISTS ledger_entries_no_update
      BEFORE UPDATE ON ledger BEGIN
        SELECT RAISE(ABORT, 'ledger entries are immutable');
      END
    `);
    sql.exec(`
      CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete
      BEFORE DELETE ON ledger BEGIN
        SELECT RAISE(ABORT, 'ledger entries are immutable');
      END
    `);

    const now = Date.now();
    sql.exec(
      `INSERT OR IGNORE INTO accounts
        (player_id, line_user_id, display_name, balance_hundredths, active, kind, created_at, updated_at)
       VALUES (?, NULL, 'House Commission', 0, 1, 'house', ?, ?)`,
      HOUSE_ACCOUNT_ID,
      now,
      now,
    );
  }

  private accountRow(playerId: string): AccountRow | undefined {
    return this.state.storage.sql
      .exec<AccountRow>('SELECT * FROM accounts WHERE player_id = ?', playerId)
      .toArray()[0];
  }

  private transactionRow(transactionId: string): TransactionRow | undefined {
    return this.state.storage.sql
      .exec<TransactionRow>('SELECT * FROM transactions WHERE transaction_id = ?', transactionId)
      .toArray()[0];
  }

  private getAccount(playerId: string): LedgerAccount | null {
    const row = this.accountRow(playerId);
    return row ? mapAccount(row) : null;
  }

  private getLedgerEntries(playerId: string): LedgerEntry[] {
    return this.state.storage.sql
      .exec<LedgerRow>(
        'SELECT * FROM ledger WHERE account_id = ? ORDER BY created_at, entry_id',
        playerId,
      )
      .toArray()
      .map(mapLedgerEntry);
  }

  private getSnapshot(): DashboardSnapshot {
    const accounts = this.state.storage.sql
      .exec<AccountRow>('SELECT * FROM accounts ORDER BY kind, player_id')
      .toArray()
      .map(mapAccount);
    const transactions = this.state.storage.sql
      .exec<TransactionRow>('SELECT * FROM transactions ORDER BY created_at, transaction_id')
      .toArray()
      .map(mapTransaction);
    const totalBalanceHundredths = accounts.reduce(
      (total, account) => total + account.balanceHundredths,
      0,
    );
    if (!Number.isSafeInteger(totalBalanceHundredths)) {
      throw new CoordinatorError('INTERNAL', 'Account total exceeds the supported range');
    }
    return { accounts, transactions, totalBalanceHundredths };
  }

  private replayOrBegin<T>(
    operation: string,
    idempotencyKey: string,
    input: unknown,
    action: () => T,
  ): T {
    const requestFingerprint = stableJson(input);
    return this.state.storage.transactionSync(() => {
      const prior = this.state.storage.sql
        .exec<IdempotencyRow>(
          `SELECT request_fingerprint, result_json
           FROM idempotency_results WHERE operation = ? AND idempotency_key = ?`,
          operation,
          idempotencyKey,
        )
        .toArray()[0];
      if (prior) {
        if (prior.request_fingerprint !== requestFingerprint) {
          throw new CoordinatorError('INVALID_INPUT', 'Idempotency key was reused with different input');
        }
        return JSON.parse(prior.result_json) as T;
      }

      const result = action();
      this.state.storage.sql.exec(
        `INSERT INTO idempotency_results
          (operation, idempotency_key, request_fingerprint, result_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        operation,
        idempotencyKey,
        requestFingerprint,
        JSON.stringify(result),
        Date.now(),
      );
      return result;
    });
  }

  private addLedgerEntry(input: {
    accountId: string;
    idempotencyKey: string;
    deltaHundredths: number;
    balanceAfterHundredths: number;
    eventType: LedgerEventType;
    referenceId?: string | null;
    actorId?: string | null;
    reason?: string | null;
  }): void {
    this.state.storage.sql.exec(
      `INSERT INTO ledger
        (entry_id, account_id, idempotency_key, delta_hundredths, balance_after_hundredths,
         event_type, reference_id, actor_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      input.accountId,
      input.idempotencyKey,
      input.deltaHundredths,
      input.balanceAfterHundredths,
      input.eventType,
      input.referenceId ?? null,
      input.actorId ?? null,
      input.reason ?? null,
      Date.now(),
    );
  }

  private requireActivePlayer(playerId: string): { row: AccountRow; account: LedgerAccount } {
    if (playerId === HOUSE_ACCOUNT_ID) {
      throw new CoordinatorError('INVALID_INPUT', 'The house account cannot be modified as a player');
    }
    const row = this.accountRow(playerId);
    if (!row) throw new CoordinatorError('NOT_FOUND', 'Player account not found');
    if (row.active !== 1 || row.kind !== 'player') {
      throw new CoordinatorError('INVALID_STATE', 'Player account is not active');
    }
    return { row, account: mapAccount(row) };
  }

  private validateIdempotentInput<T extends { idempotencyKey: string }>(
    input: T,
  ): T & { idempotencyKey: string } {
    input.idempotencyKey = validateIdentifier(input.idempotencyKey, 'idempotencyKey');
    return input;
  }

  private createPlayer(rawInput: CreatePlayerInput): LedgerAccount {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.playerId = validateIdentifier(input.playerId, 'playerId');
    input.lineUserId = validateIdentifier(input.lineUserId, 'lineUserId');
    input.displayName = validateText(input.displayName, 'displayName', 120);
    input.openingBalanceHundredths = validatePointHundredths(
      input.openingBalanceHundredths,
      'openingBalanceHundredths',
    );
    if (input.playerId === HOUSE_ACCOUNT_ID) {
      throw new CoordinatorError('INVALID_INPUT', 'The reserved house account ID cannot be used');
    }

    return this.replayOrBegin('createPlayer', input.idempotencyKey, input, () => {
      if (this.accountRow(input.playerId)) {
        throw new CoordinatorError('DUPLICATE_ID', 'Player ID already exists');
      }
      const now = Date.now();
      this.state.storage.sql.exec(
        `INSERT INTO accounts
          (player_id, line_user_id, display_name, balance_hundredths, active, kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 'player', ?, ?)`,
        input.playerId,
        input.lineUserId,
        input.displayName,
        input.openingBalanceHundredths,
        now,
        now,
      );
      if (input.openingBalanceHundredths > 0) {
        this.addLedgerEntry({
          accountId: input.playerId,
          idempotencyKey: `createPlayer:${input.idempotencyKey}`,
          deltaHundredths: input.openingBalanceHundredths,
          balanceAfterHundredths: input.openingBalanceHundredths,
          eventType: 'opening_balance',
          referenceId: input.playerId,
          reason: 'Opening balance',
        });
      }
      const row = this.accountRow(input.playerId);
      if (!row) throw new CoordinatorError('INTERNAL', 'Created account could not be loaded');
      return mapAccount(row);
    });
  }

  private adjustBalance(rawInput: AdjustBalanceInput): LedgerAccount {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.playerId = validateIdentifier(input.playerId, 'playerId');
    input.targetBalanceHundredths = validatePointHundredths(
      input.targetBalanceHundredths,
      'targetBalanceHundredths',
    );
    input.actorId = validateIdentifier(input.actorId, 'actorId');
    input.reason = validateText(input.reason, 'reason', 500);

    return this.replayOrBegin('adjustBalance', input.idempotencyKey, input, () => {
      const { row, account } = this.requireActivePlayer(input.playerId);
      const deltaHundredths = input.targetBalanceHundredths - account.balanceHundredths;
      if (!Number.isSafeInteger(deltaHundredths)) {
        throw new CoordinatorError('INVALID_INPUT', 'Adjustment exceeds the supported range');
      }
      const now = Date.now();
      this.state.storage.sql.exec(
        'UPDATE accounts SET balance_hundredths = ?, updated_at = ? WHERE player_id = ?',
        input.targetBalanceHundredths,
        now,
        row.player_id,
      );
      if (deltaHundredths !== 0) {
        this.addLedgerEntry({
          accountId: input.playerId,
          idempotencyKey: `adjustBalance:${input.idempotencyKey}`,
          deltaHundredths,
          balanceAfterHundredths: input.targetBalanceHundredths,
          eventType: 'admin_adjustment',
          referenceId: input.idempotencyKey,
          actorId: input.actorId,
          reason: input.reason,
        });
      }
      const updated = this.accountRow(input.playerId);
      if (!updated) throw new CoordinatorError('INTERNAL', 'Adjusted account could not be loaded');
      return mapAccount(updated);
    });
  }

  private deactivatePlayer(rawInput: DeactivatePlayerInput): LedgerAccount {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.playerId = validateIdentifier(input.playerId, 'playerId');
    input.actorId = validateIdentifier(input.actorId, 'actorId');

    return this.replayOrBegin('deactivatePlayer', input.idempotencyKey, input, () => {
      const { row } = this.requireActivePlayer(input.playerId);
      if (row.balance_hundredths !== 0) {
        throw new CoordinatorError('INVALID_STATE', 'Player must have a zero balance before deactivation');
      }
      const unsettled = this.state.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM orders
           WHERE (creator_id = ? OR matcher_id = ?)
             AND status IN ('pending_hold', 'pending_match', 'matched', 'refunding')`,
          input.playerId,
          input.playerId,
        )
        .toArray()[0]?.count ?? 0;
      if (unsettled > 0) {
        throw new CoordinatorError('INVALID_STATE', 'Player has unsettled orders');
      }
      this.state.storage.sql.exec(
        'UPDATE accounts SET active = 0, updated_at = ? WHERE player_id = ?',
        Date.now(),
        input.playerId,
      );
      const updated = this.accountRow(input.playerId);
      if (!updated) throw new CoordinatorError('INTERNAL', 'Deactivated account could not be loaded');
      return mapAccount(updated);
    });
  }

  private requestWithdrawal(rawInput: RequestWithdrawalInput): FinancialTransaction {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.transactionId = validateIdentifier(input.transactionId, 'transactionId');
    input.playerId = validateIdentifier(input.playerId, 'playerId');
    input.amountHundredths = validatePointHundredths(
      input.amountHundredths,
      'amountHundredths',
      false,
    );
    input.bankName = validateText(input.bankName, 'bankName', 120);
    input.accountNumber = validateText(input.accountNumber, 'accountNumber', 64);
    input.accountName = validateText(input.accountName, 'accountName', 120);

    return this.replayOrBegin('requestWithdrawal', input.idempotencyKey, input, () => {
      if (this.transactionRow(input.transactionId)) {
        throw new CoordinatorError('DUPLICATE_ID', 'Transaction ID already exists');
      }
      const { row, account } = this.requireActivePlayer(input.playerId);
      if (account.balanceHundredths < input.amountHundredths) {
        throw new CoordinatorError('INSUFFICIENT_FUNDS', 'Insufficient balance for withdrawal');
      }
      const now = Date.now();
      const nextBalance = account.balanceHundredths - input.amountHundredths;
      this.state.storage.sql.exec(
        'UPDATE accounts SET balance_hundredths = ?, updated_at = ? WHERE player_id = ?',
        nextBalance,
        now,
        row.player_id,
      );
      this.addLedgerEntry({
        accountId: input.playerId,
        idempotencyKey: `requestWithdrawal:${input.idempotencyKey}`,
        deltaHundredths: -input.amountHundredths,
        balanceAfterHundredths: nextBalance,
        eventType: 'withdrawal_requested',
        referenceId: input.transactionId,
        reason: 'Withdrawal reserved',
      });
      this.state.storage.sql.exec(
        `INSERT INTO transactions
          (transaction_id, player_id, type, requested_amount_hundredths,
           actual_amount_hundredths, status, bank_name, account_number,
           account_name, actor_id, reason, created_at, updated_at)
         VALUES (?, ?, 'withdrawal', ?, NULL, 'pending', ?, ?, ?, NULL, NULL, ?, ?)`,
        input.transactionId,
        input.playerId,
        input.amountHundredths,
        input.bankName,
        input.accountNumber,
        input.accountName,
        now,
        now,
      );
      const transaction = this.transactionRow(input.transactionId);
      if (!transaction) throw new CoordinatorError('INTERNAL', 'Created transaction could not be loaded');
      return mapTransaction(transaction);
    });
  }

  private reviewTransaction(rawInput: ReviewTransactionInput): FinancialTransaction {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.transactionId = validateIdentifier(input.transactionId, 'transactionId');
    if (input.decision !== 'approve' && input.decision !== 'reject') {
      throw new CoordinatorError('INVALID_INPUT', 'decision must be approve or reject');
    }
    input.actualAmountHundredths = validatePointHundredths(
      input.actualAmountHundredths,
      'actualAmountHundredths',
    );
    input.actorId = validateIdentifier(input.actorId, 'actorId');
    input.reason = validateText(input.reason, 'reason', 500);

    return this.replayOrBegin('reviewTransaction', input.idempotencyKey, input, () => {
      const transaction = this.transactionRow(input.transactionId);
      if (!transaction) throw new CoordinatorError('NOT_FOUND', 'Financial transaction not found');
      if (transaction.status !== 'pending') {
        throw new CoordinatorError('INVALID_STATE', 'Transaction has already been reviewed');
      }
      if (
        input.decision === 'approve' &&
        input.actualAmountHundredths !== transaction.requested_amount_hundredths
      ) {
        throw new CoordinatorError('INVALID_INPUT', 'Approved withdrawal amount must match its reservation');
      }

      const now = Date.now();
      if (input.decision === 'reject') {
        const account = this.accountRow(transaction.player_id);
        if (!account) throw new CoordinatorError('NOT_FOUND', 'Player account not found');
        const nextBalance = account.balance_hundredths + transaction.requested_amount_hundredths;
        if (!Number.isSafeInteger(nextBalance)) {
          throw new CoordinatorError('INTERNAL', 'Refund exceeds the supported balance range');
        }
        this.state.storage.sql.exec(
          'UPDATE accounts SET balance_hundredths = ?, updated_at = ? WHERE player_id = ?',
          nextBalance,
          now,
          transaction.player_id,
        );
        this.addLedgerEntry({
          accountId: transaction.player_id,
          idempotencyKey: `reviewTransaction:${input.idempotencyKey}`,
          deltaHundredths: transaction.requested_amount_hundredths,
          balanceAfterHundredths: nextBalance,
          eventType: 'withdrawal_rejected',
          referenceId: input.transactionId,
          actorId: input.actorId,
          reason: input.reason,
        });
      }

      this.state.storage.sql.exec(
        `UPDATE transactions
         SET actual_amount_hundredths = ?, status = ?, actor_id = ?, reason = ?, updated_at = ?
         WHERE transaction_id = ?`,
        input.decision === 'approve' ? input.actualAmountHundredths : 0,
        input.decision === 'approve' ? 'approved' : 'rejected',
        input.actorId,
        input.reason,
        now,
        input.transactionId,
      );
      const updated = this.transactionRow(input.transactionId);
      if (!updated) throw new CoordinatorError('INTERNAL', 'Reviewed transaction could not be loaded');
      return mapTransaction(updated);
    });
  }
}
