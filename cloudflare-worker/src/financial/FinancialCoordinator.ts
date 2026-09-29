import type { Env } from '../types';
import { calculateWinPayout } from './payout';
import {
  ACCOUNT_PAGE_MAX,
  CoordinatorError,
  ORDER_STATUS_SCAN_DEFAULT,
  ORDER_STATUS_SCAN_MAX,
  TRANSACTION_PAGE_DEFAULT,
  TRANSACTION_PAGE_MAX,
  validateFinalSeconds,
  validateIdentifier,
  validatePointHundredths,
  validateStakeHundredths,
  validateText,
  type AccountKind,
  type AdjustBalanceInput,
  type AutoMatchOrdersInput,
  type CancelOrderInput,
  type CloseRoundInput,
  type CreateOrderInput,
  type CreatePlayerInput,
  type DashboardSnapshot,
  type DeactivatePlayerInput,
  type FinancialTransaction,
  type FinancialSnapshot,
  type FinancialSnapshotAccount,
  type ImportFinancialSnapshotInput,
  type ImportPreview,
  type ImportResult,
  type ActivateAuthorityInput,
  type SnapshotReconciliation,
  type LedgerAccount,
  type LedgerEntry,
  type LedgerEventType,
  type LedgerOrder,
  type LedgerOrderStatus,
  type MatchOrderInput,
  type OpenRoundInput,
  type Page,
  type ProjectionDrainResult,
  type ReleaseQuoteInput,
  type RequestDepositInput,
  type RequestWithdrawalInput,
  type ResolveRoundInput,
  type ReviewTransactionInput,
  type RocketRound,
  type RoundCloseResult,
  type RoundReleaseResult,
  type RoundSettlementResult,
  type RoundVoidResult,
  type VoidRoundInput,
} from './types';

const HOUSE_ACCOUNT_ID = '__house__';
const IMPORT_SCHEMA_VERSION = 'financial-ledger-v1';
const AUTHORITY_CONFIRMATION = 'ACTIVATE_FINANCIAL_AUTHORITY';
const DEFAULT_IMPORT_CHUNK_SIZE = 100;
const MAX_IMPORT_CHUNK_SIZE = 1_000;
const MAX_IMPORT_CHUNKS_PER_CALL = 1_000;
const FINANCIAL_MUTATIONS = new Set([
  'createPlayer',
  'adjustBalance',
  'deactivatePlayer',
  'requestWithdrawal',
  'requestDeposit',
  'reviewTransaction',
  'openRound',
  'createOrder',
  'matchOrder',
  'autoMatchOrders',
  'cancelOrder',
  'releaseQuote',
  'closeRound',
  'voidRound',
  'resolveRound',
]);

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

interface RoundRow {
  [key: string]: string | number | null;
  round_id: string;
  name: string;
  status: 'active' | 'closed' | 'void';
  quote_released: number;
  target_min: number | null;
  target_max: number | null;
  created_at: number;
  updated_at: number;
}

interface OrderRow {
  [key: string]: string | number | null;
  order_number: string;
  round_id: string;
  creator_id: string;
  matcher_id: string | null;
  stake_hundredths: number;
  status: string;
  order_json: string;
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
  type: 'deposit' | 'withdrawal';
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

interface ProjectionOutboxRow {
  [key: string]: string | number | null;
  outbox_id: string;
  event_type: string;
  payload_json: string;
  created_at: number;
  delivered_at: number | null;
  attempt_count: number;
  next_attempt_at: number;
}

interface AuthorityRow {
  [key: string]: string | number | null;
  authority_id: string;
  active: number;
  schema_version: string;
  snapshot_id: string | null;
  account_count: number;
  transaction_count: number;
  round_count: number;
  order_count: number;
  unresolved_conflicts: number;
  updated_at: number;
}

interface ImportRow {
  [key: string]: string | number | null;
  snapshot_id: string;
  schema_version: string;
  provenance: string;
  request_fingerprint: string;
  result_json: string;
  account_count: number;
  transaction_count: number;
  round_count: number;
  order_count: number;
  total_balance_hundredths: number;
  unresolved_conflicts: number;
  status: 'in_progress' | 'complete';
  account_cursor: number;
  transaction_cursor: number;
  round_cursor: number;
  order_cursor: number;
  house_account_included: number;
  imported_at: number;
}

interface NormalizedImport {
  snapshotId: string;
  schemaVersion: 'financial-ledger-v1';
  accounts: Array<LedgerAccount & { balanceHundredths: number }>;
  transactions: FinancialTransaction[];
  rounds: RocketRound[];
  orders: LedgerOrder[];
  reconciliation: SnapshotReconciliation;
}

export interface SchemaTableMetadata {
  readonly sql: string;
  readonly columns: readonly string[];
}

const REQUIRED_SCHEMA: Record<string, {
  columns: readonly string[];
  fragments: readonly string[];
}> = {
  accounts: {
    columns: [
      'player_id',
      'line_user_id',
      'display_name',
      'balance_hundredths',
      'active',
      'kind',
      'created_at',
      'updated_at',
    ],
    fragments: [
      'primary key',
      'unique',
      'check (balance_hundredths >= 0)',
      "check (active in (0, 1))",
      "check (kind in ('player', 'house'))",
    ],
  },
  ledger: {
    columns: [
      'entry_id',
      'account_id',
      'idempotency_key',
      'delta_hundredths',
      'balance_after_hundredths',
      'event_type',
      'reference_id',
      'actor_id',
      'reason',
      'created_at',
    ],
    fragments: [
      'primary key',
      'unique (account_id, idempotency_key)',
      'check (balance_after_hundredths >= 0)',
    ],
  },
  transactions: {
    columns: [
      'transaction_id',
      'player_id',
      'type',
      'requested_amount_hundredths',
      'actual_amount_hundredths',
      'status',
      'bank_name',
      'account_number',
      'account_name',
      'actor_id',
      'reason',
      'created_at',
      'updated_at',
    ],
    fragments: [
      'primary key',
      "check (type in ('deposit', 'withdrawal'))",
      "check (status in ('pending', 'approved', 'rejected'))",
      'check (requested_amount_hundredths > 0)',
      'check (actual_amount_hundredths >= 0)',
    ],
  },
  rounds: {
    columns: [
      'round_id',
      'name',
      'status',
      'quote_released',
      'target_min',
      'target_max',
      'created_at',
      'updated_at',
    ],
    fragments: [
      'primary key',
      "check (status in ('active', 'closed', 'void'))",
      'check (quote_released in (0, 1))',
    ],
  },
  orders: {
    columns: [
      'order_number',
      'round_id',
      'creator_id',
      'matcher_id',
      'stake_hundredths',
      'status',
      'order_json',
      'created_at',
      'updated_at',
    ],
    fragments: [
      'primary key',
      'check (stake_hundredths > 0)',
      "check (status in ('pending_hold', 'pending_match', 'matched', 'cancelled', 'resolved', 'settled', 'void'))",
    ],
  },
  idempotency_results: {
    columns: [
      'operation',
      'idempotency_key',
      'request_fingerprint',
      'result_json',
      'created_at',
    ],
    fragments: ['primary key (operation, idempotency_key)'],
  },
  projection_outbox: {
    columns: [
      'outbox_id',
      'event_type',
      'payload_json',
      'created_at',
      'delivered_at',
      'attempt_count',
      'next_attempt_at',
    ],
    fragments: ['primary key'],
  },
  authority_state: {
    columns: [
      'authority_id',
      'active',
      'schema_version',
      'snapshot_id',
      'account_count',
      'transaction_count',
      'round_count',
      'order_count',
      'unresolved_conflicts',
      'updated_at',
    ],
    fragments: ['primary key', 'check (active in (0, 1))'],
  },
  imported_snapshots: {
    columns: [
      'snapshot_id',
      'schema_version',
      'provenance',
      'request_fingerprint',
      'result_json',
      'account_count',
      'transaction_count',
      'round_count',
      'order_count',
      'total_balance_hundredths',
      'unresolved_conflicts',
      'status',
      'account_cursor',
      'transaction_cursor',
      'round_cursor',
      'order_cursor',
      'house_account_included',
      'imported_at',
    ],
    fragments: [
      'primary key',
      "check (status in ('in_progress', 'complete'))",
      'check (house_account_included in (0, 1))',
    ],
  },
};

export function findSchemaConflicts(
  tables: Record<string, SchemaTableMetadata | undefined>,
): string[] {
  const conflicts: string[] = [];
  for (const [tableName, requirement] of Object.entries(REQUIRED_SCHEMA)) {
    const table = tables[tableName];
    if (!table) {
      conflicts.push(`required schema table ${tableName} is missing`);
      continue;
    }
    const columns = new Set(table.columns);
    for (const column of requirement.columns) {
      if (!columns.has(column)) {
        conflicts.push(`required schema column ${tableName}.${column} is missing`);
      }
    }
    const normalizedSql = table.sql.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const fragment of requirement.fragments) {
      if (!normalizedSql.includes(fragment)) {
        conflicts.push(`required schema constraint ${tableName}.${fragment} is missing`);
      }
    }
  }
  return conflicts;
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
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function exactHundredths(value: unknown): number | null {
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > 2) return null;
  const cents = Number(`${whole}${fraction.padEnd(2, '0')}`);
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

function sourceBalanceHundredths(account: FinancialSnapshotAccount): number | null {
  if (account.balanceHundredths !== undefined && account.balance !== undefined) return null;
  if (account.balanceHundredths !== undefined) {
    return Number.isSafeInteger(account.balanceHundredths) ? account.balanceHundredths : null;
  }
  return exactHundredths(account.balance);
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
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.initializeSchema();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/rpc') {
      return this.errorResponse(new CoordinatorError('NOT_FOUND', 'Coordinator endpoint not found'));
    }

    try {
      const body = asRecord((await request.json()) as RpcRequest);
      const operation = validateIdentifier(body.operation, 'operation', 64);
      const result = operation === 'drainProjections'
        ? await this.drainProjectionOutbox()
        : this.dispatch(operation, body.input);
      if (operation !== 'drainProjections') await this.scheduleProjectionAlarm();
      return Response.json({ result });
    } catch (error) {
      if (error instanceof CoordinatorError) return this.errorResponse(error);
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        return this.errorResponse(new CoordinatorError('DUPLICATE_ID', 'Identifier already exists'));
      }
      return this.errorResponse(new CoordinatorError('INTERNAL', 'Coordinator operation failed'));
    }
  }

  async alarm(): Promise<void> {
    await this.drainProjectionOutbox();
  }

  private errorResponse(error: CoordinatorError): Response {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }

  private dispatch(operation: string, rawInput: unknown): unknown {
    if (FINANCIAL_MUTATIONS.has(operation)) this.ensureAuthorityReady();
    switch (operation) {
      case 'getAccount': {
        const input = asRecord(rawInput);
        return this.getAccount(validateIdentifier(input.playerId, 'playerId'));
      }
      case 'getAccountByLineUserId': {
        const input = asRecord(rawInput);
        const lineUserId = validateIdentifier(input.lineUserId, 'lineUserId');
        const row = this.state.storage.sql
          .exec<AccountRow>('SELECT * FROM accounts WHERE line_user_id = ?', lineUserId)
          .toArray()[0];
        return row ? mapAccount(row) : null;
      }
      case 'getAccounts': {
        const input = asRecord(rawInput);
        if (!Array.isArray(input.playerIds) || input.playerIds.length === 0 || input.playerIds.length > 500) {
          throw new CoordinatorError('INVALID_INPUT', 'playerIds must contain between 1 and 500 IDs');
        }
        const playerIds = input.playerIds.map((playerId) => validateIdentifier(playerId, 'playerId'));
        const placeholders = playerIds.map(() => '?').join(', ');
        return this.state.storage.sql
          .exec<AccountRow>(`SELECT * FROM accounts WHERE player_id IN (${placeholders})`, ...playerIds)
          .toArray()
          .map(mapAccount);
      }
      case 'getLedgerEntries': {
        const input = asRecord(rawInput);
        return this.getLedgerEntries(validateIdentifier(input.playerId, 'playerId'));
      }
      case 'getSnapshot':
        return this.getSnapshot();
      case 'listAccounts': {
        const input = asRecord(rawInput);
        return this.listAccounts(input.limit, input.cursor);
      }
      case 'listTransactions': {
        const input = asRecord(rawInput);
        return this.listTransactions(input.limit, input.cursor);
      }
      case 'previewImport':
        return this.previewImport(rawInput as FinancialSnapshot);
      case 'importSnapshot':
        return this.importSnapshot(asRecord(rawInput) as unknown as ImportFinancialSnapshotInput);
      case 'activateAuthority':
        return this.activateAuthority(asRecord(rawInput) as unknown as ActivateAuthorityInput);
      case 'getOrder': {
        const input = asRecord(rawInput);
        const row = this.orderRow(validateIdentifier(input.orderNumber, 'orderNumber'));
        return row ? this.mapOrder(row) : null;
      }
      case 'getOrdersByStatus': {
        const input = asRecord(rawInput);
        if (!Array.isArray(input.statuses) || input.statuses.length === 0) {
          throw new CoordinatorError('INVALID_INPUT', 'statuses must be a non-empty array');
        }
        const validStatuses: LedgerOrderStatus[] = [
          'pending_hold',
          'pending_match',
          'matched',
          'cancelled',
          'resolved',
          'settled',
          'void',
        ];
        const statuses = input.statuses.map((status) => {
          if (typeof status !== 'string' || !validStatuses.includes(status as LedgerOrderStatus)) {
            throw new CoordinatorError('INVALID_INPUT', 'Order status is invalid');
          }
          return status;
        });
        let scanLimit = ORDER_STATUS_SCAN_DEFAULT;
        if (input.limit !== undefined) {
          if (!Number.isSafeInteger(input.limit) ||
              (input.limit as number) < 1 ||
              (input.limit as number) > ORDER_STATUS_SCAN_MAX) {
            throw new CoordinatorError(
              'INVALID_INPUT',
              `Order status scan limit must be between 1 and ${ORDER_STATUS_SCAN_MAX}`,
            );
          }
          scanLimit = input.limit as number;
        }
        const placeholders = statuses.map(() => '?').join(', ');
        return this.state.storage.sql
          .exec<OrderRow>(
            `SELECT * FROM orders WHERE status IN (${placeholders}) ORDER BY created_at DESC, order_number DESC LIMIT ?`,
            ...statuses,
            scanLimit,
          )
          .toArray()
          .map((row) => this.mapOrder(row));
      }
      case 'createPlayer':
        return this.createPlayer(asRecord(rawInput) as unknown as CreatePlayerInput);
      case 'adjustBalance':
        return this.adjustBalance(asRecord(rawInput) as unknown as AdjustBalanceInput);
      case 'deactivatePlayer':
        return this.deactivatePlayer(asRecord(rawInput) as unknown as DeactivatePlayerInput);
      case 'requestWithdrawal':
        return this.requestWithdrawal(asRecord(rawInput) as unknown as RequestWithdrawalInput);
      case 'requestDeposit':
        return this.requestDeposit(asRecord(rawInput) as unknown as RequestDepositInput);
      case 'reviewTransaction':
        return this.reviewTransaction(asRecord(rawInput) as unknown as ReviewTransactionInput);
      case 'openRound':
        return this.openRound(asRecord(rawInput) as unknown as OpenRoundInput);
      case 'createOrder':
        return this.createOrder(asRecord(rawInput) as unknown as CreateOrderInput);
      case 'matchOrder':
        return this.matchOrder(asRecord(rawInput) as unknown as MatchOrderInput);
      case 'autoMatchOrders':
        return this.autoMatchOrders(asRecord(rawInput) as unknown as AutoMatchOrdersInput);
      case 'cancelOrder':
        return this.cancelOrder(asRecord(rawInput) as unknown as CancelOrderInput);
      case 'releaseQuote':
        return this.releaseQuote(asRecord(rawInput) as unknown as ReleaseQuoteInput);
      case 'closeRound':
        return this.closeRound(asRecord(rawInput) as unknown as CloseRoundInput);
      case 'voidRound':
        return this.voidRound(asRecord(rawInput) as unknown as VoidRoundInput);
      case 'resolveRound':
        return this.resolveRound(asRecord(rawInput) as unknown as ResolveRoundInput);
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
        type TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal')),
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
    const transactionSchema = sql
      .exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'")
      .toArray()[0]?.sql ?? '';
    if (transactionSchema.includes("type IN ('withdrawal')")) {
      sql.exec(`
        CREATE TABLE transactions_replacement (
          transaction_id TEXT PRIMARY KEY,
          player_id TEXT NOT NULL REFERENCES accounts(player_id),
          type TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal')),
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
        INSERT INTO transactions_replacement
        SELECT transaction_id, player_id, type, requested_amount_hundredths,
               actual_amount_hundredths, status, bank_name, account_number,
               account_name, actor_id, reason, created_at, updated_at
        FROM transactions
      `);
      sql.exec('DROP TABLE transactions');
      sql.exec('ALTER TABLE transactions_replacement RENAME TO transactions');
    }
    sql.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        order_number TEXT PRIMARY KEY,
        round_id TEXT NOT NULL REFERENCES rounds(round_id),
        creator_id TEXT NOT NULL REFERENCES accounts(player_id),
        matcher_id TEXT REFERENCES accounts(player_id),
        stake_hundredths INTEGER NOT NULL CHECK (stake_hundredths > 0),
        status TEXT NOT NULL CHECK (status IN ('pending_hold', 'pending_match', 'matched', 'cancelled', 'resolved', 'settled', 'void')),
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
        delivered_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS authority_state (
        authority_id TEXT PRIMARY KEY,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        schema_version TEXT NOT NULL,
        snapshot_id TEXT,
        account_count INTEGER NOT NULL DEFAULT 0,
        transaction_count INTEGER NOT NULL DEFAULT 0,
        round_count INTEGER NOT NULL DEFAULT 0,
        order_count INTEGER NOT NULL DEFAULT 0,
        unresolved_conflicts INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS imported_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        provenance TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        account_count INTEGER NOT NULL,
        transaction_count INTEGER NOT NULL,
        round_count INTEGER NOT NULL,
        order_count INTEGER NOT NULL,
        total_balance_hundredths INTEGER NOT NULL,
        unresolved_conflicts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('in_progress', 'complete')),
        account_cursor INTEGER NOT NULL DEFAULT 0,
        transaction_cursor INTEGER NOT NULL DEFAULT 0,
        round_cursor INTEGER NOT NULL DEFAULT 0,
        order_cursor INTEGER NOT NULL DEFAULT 0,
        house_account_included INTEGER NOT NULL DEFAULT 0 CHECK (house_account_included IN (0, 1)),
        imported_at INTEGER NOT NULL
      )
    `);
    const projectionColumns = sql
      .exec<{ name: string }>('PRAGMA table_info(projection_outbox)')
      .toArray()
      .map((column) => column.name);
    if (!projectionColumns.includes('attempt_count')) {
      sql.exec('ALTER TABLE projection_outbox ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0');
    }
    if (!projectionColumns.includes('next_attempt_at')) {
      sql.exec('ALTER TABLE projection_outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0');
    }
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
    if (this.schemaConflicts().length === 0) {
      sql.exec(
        `INSERT OR IGNORE INTO authority_state
          (authority_id, active, schema_version, snapshot_id, updated_at)
         VALUES ('financial', 0, ?, NULL, ?)`,
        IMPORT_SCHEMA_VERSION,
        now,
      );
    }
  }

  private schemaMetadata(): Record<string, SchemaTableMetadata | undefined> {
    const metadata: Record<string, SchemaTableMetadata | undefined> = {};
    for (const tableName of Object.keys(REQUIRED_SCHEMA)) {
      const definition = this.state.storage.sql
        .exec<{ sql: string | null }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
          tableName,
        )
        .toArray()[0]?.sql;
      if (!definition) {
        metadata[tableName] = undefined;
        continue;
      }
      const columns = this.state.storage.sql
        .exec<{ name: string }>(`PRAGMA table_info(${tableName})`)
        .toArray()
        .map((column) => column.name);
      metadata[tableName] = { sql: definition, columns };
    }
    return metadata;
  }

  private schemaConflicts(): string[] {
    return findSchemaConflicts(this.schemaMetadata());
  }

  private ensureSchemaReady(): void {
    const conflicts = this.schemaConflicts();
    if (conflicts.length > 0) {
      throw new CoordinatorError(
        'IMPORT_CONFLICT',
        `Required financial schema is not ready: ${conflicts.join('; ')}`,
      );
    }
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

  private roundRow(roundId: string): RoundRow | undefined {
    return this.state.storage.sql
      .exec<RoundRow>('SELECT * FROM rounds WHERE round_id = ?', roundId)
      .toArray()[0];
  }

  private orderRow(orderNumber: string): OrderRow | undefined {
    return this.state.storage.sql
      .exec<OrderRow>('SELECT * FROM orders WHERE order_number = ?', orderNumber)
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
    const rounds = this.state.storage.sql
      .exec<RoundRow>('SELECT * FROM rounds ORDER BY created_at, round_id')
      .toArray()
      .map((row) => this.mapRound(row));
    const orders = this.state.storage.sql
      .exec<OrderRow>('SELECT * FROM orders ORDER BY created_at, order_number')
      .toArray()
      .map((row) => this.mapOrder(row));
    const totalBalanceHundredths = accounts.reduce(
      (total, account) => total + account.balanceHundredths,
      0,
    );
    if (!Number.isSafeInteger(totalBalanceHundredths)) {
      throw new CoordinatorError('INTERNAL', 'Account total exceeds the supported range');
    }
    return { accounts, transactions, rounds, orders, totalBalanceHundredths };
  }

  private clampPageLimit(value: unknown, defaultLimit: number, maxLimit: number): number {
    if (value === undefined || value === null) return defaultLimit;
    const numeric = typeof value === 'number' ? Math.floor(value) : Number.NaN;
    if (!Number.isSafeInteger(numeric) || numeric < 1) return defaultLimit;
    return Math.min(numeric, maxLimit);
  }

  private listAccounts(rawLimit: unknown, rawCursor: unknown): Page<LedgerAccount> {
    const limit = this.clampPageLimit(rawLimit, ACCOUNT_PAGE_MAX, ACCOUNT_PAGE_MAX);
    const cursor = rawCursor === undefined || rawCursor === null
      ? null
      : validateIdentifier(rawCursor, 'cursor');
    const rows = (cursor === null
      ? this.state.storage.sql.exec<AccountRow>(
        'SELECT * FROM accounts ORDER BY player_id, kind LIMIT ?',
        limit + 1,
      )
      : this.state.storage.sql.exec<AccountRow>(
        'SELECT * FROM accounts WHERE player_id > ? ORDER BY player_id, kind LIMIT ?',
        cursor,
        limit + 1,
      )
    ).toArray();
    const items = rows.slice(0, limit).map(mapAccount);
    return {
      items,
      nextCursor: rows.length > limit && items.length > 0 ? items[items.length - 1].playerId : null,
    };
  }

  private listTransactions(rawLimit: unknown, rawCursor: unknown): Page<FinancialTransaction> {
    const limit = this.clampPageLimit(rawLimit, TRANSACTION_PAGE_DEFAULT, TRANSACTION_PAGE_MAX);
    let cursor: { createdAt: number; transactionId: string } | null = null;
    if (rawCursor !== undefined && rawCursor !== null) {
      try {
        const parsed = JSON.parse(String(rawCursor)) as unknown;
        if (!Array.isArray(parsed) || parsed.length !== 2 ||
            !Number.isSafeInteger(parsed[0]) || typeof parsed[1] !== 'string' || !parsed[1]) {
          throw new Error('bad cursor');
        }
        cursor = { createdAt: parsed[0] as number, transactionId: validateIdentifier(parsed[1], 'cursor') };
      } catch (error) {
        if (error instanceof CoordinatorError) throw error;
        throw new CoordinatorError('INVALID_INPUT', 'Transaction cursor is invalid');
      }
    }
    const rows = (cursor === null
      ? this.state.storage.sql.exec<TransactionRow>(
        'SELECT * FROM transactions ORDER BY created_at DESC, transaction_id DESC LIMIT ?',
        limit + 1,
      )
      : this.state.storage.sql.exec<TransactionRow>(
        `SELECT * FROM transactions
         WHERE created_at < ? OR (created_at = ? AND transaction_id < ?)
         ORDER BY created_at DESC, transaction_id DESC LIMIT ?`,
        cursor.createdAt,
        cursor.createdAt,
        cursor.transactionId,
        limit + 1,
      )
    ).toArray();
    const items = rows.slice(0, limit).map(mapTransaction);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > limit && last
        ? JSON.stringify([last.createdAt, last.transactionId])
        : null,
    };
  }

  private validateImportSnapshot(raw: unknown): {
    normalized: NormalizedImport | null;
    conflicts: string[];
  } {
    const conflicts: string[] = [];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { normalized: null, conflicts: ['snapshot must be an object'] };
    }
    const input = raw as Record<string, unknown>;
    const snapshotId = typeof input.snapshotId === 'string' ? input.snapshotId : '';
    if (!snapshotId.trim() || snapshotId.trim() !== snapshotId) {
      conflicts.push('snapshot ID is invalid');
    }
    if (input.schemaVersion !== IMPORT_SCHEMA_VERSION) {
      conflicts.push(`schema version must be ${IMPORT_SCHEMA_VERSION}`);
    }

    const accountInputs = Array.isArray(input.accounts) ? input.accounts : [];
    const transactionInputs = Array.isArray(input.transactions) ? input.transactions : [];
    const roundInputs = Array.isArray(input.rounds) ? input.rounds : [];
    const orderInputs = Array.isArray(input.orders) ? input.orders : [];
    if (!Array.isArray(input.accounts)) conflicts.push('accounts must be an array');
    if (!Array.isArray(input.transactions)) conflicts.push('transactions must be an array');
    if (!Array.isArray(input.rounds)) conflicts.push('rounds must be an array');
    if (!Array.isArray(input.orders)) conflicts.push('orders must be an array');

    const accounts: Array<LedgerAccount & { balanceHundredths: number }> = [];
    const accountIds = new Set<string>();
    const lineUserIds = new Set<string>();
    let houseAccountCount = 0;
    let totalBalanceHundredths = 0;
    for (const rawAccount of accountInputs) {
      if (rawAccount === null || typeof rawAccount !== 'object' || Array.isArray(rawAccount)) {
        conflicts.push('account record is invalid');
        continue;
      }
      const source = rawAccount as FinancialSnapshotAccount;
      const playerId = typeof source.playerId === 'string' ? source.playerId : '';
      if (!playerId || accountIds.has(playerId)) {
        conflicts.push(`duplicate account ID ${playerId || '<missing>'}`);
      }
      accountIds.add(playerId);
      const lineUserId = source.lineUserId;
      if (lineUserId !== null && typeof lineUserId !== 'string') {
        conflicts.push(`account ${playerId || '<missing>'} has an invalid LINE user ID`);
      }
      if (typeof lineUserId === 'string' && lineUserId && lineUserIds.has(lineUserId)) {
        conflicts.push(`duplicate line user ID ${lineUserId}`);
      }
      if (typeof lineUserId === 'string' && lineUserId) lineUserIds.add(lineUserId);
      const balanceHundredths = sourceBalanceHundredths(source);
      if (balanceHundredths === null) {
        conflicts.push(
          `account ${playerId || '<missing>'} balance is not exactly representable in hundredths`,
        );
        continue;
      }
      if (balanceHundredths < 0) {
        conflicts.push(`account ${playerId || '<missing>'} has a negative or unsafe balance`);
      }
      if (!Number.isSafeInteger(balanceHundredths)) {
        conflicts.push(`account ${playerId || '<missing>'} has a negative or unsafe balance`);
      }
      totalBalanceHundredths += balanceHundredths;
      if (!Number.isSafeInteger(totalBalanceHundredths)) {
        conflicts.push('total balance exceeds the supported range');
      }
      if (typeof source.active !== 'boolean' || !['player', 'house'].includes(source.kind)) {
        conflicts.push(`account ${playerId || '<missing>'} has invalid account metadata`);
      }
      if (source.kind === 'house') {
        houseAccountCount += 1;
        if (playerId !== HOUSE_ACCOUNT_ID) {
          conflicts.push(`house account must use ID ${HOUSE_ACCOUNT_ID}`);
        }
      } else if (playerId === HOUSE_ACCOUNT_ID) {
        conflicts.push(`account ${HOUSE_ACCOUNT_ID} must have kind house`);
      }
      if (typeof source.displayName !== 'string' || !source.displayName.trim()) {
        conflicts.push(`account ${playerId || '<missing>'} has an invalid display name`);
      }
      accounts.push({
        playerId,
        lineUserId: lineUserId ?? null,
        displayName: typeof source.displayName === 'string' ? source.displayName : '',
        balanceHundredths,
        active: source.active === true,
        kind: source.kind === 'house' ? 'house' : 'player',
        createdAt: typeof source.createdAt === 'number' ? source.createdAt : 0,
        updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : 0,
      });
    }
    if (houseAccountCount > 1) conflicts.push('snapshot contains multiple house accounts');

    const transactions: FinancialTransaction[] = [];
    const transactionIds = new Set<string>();
    for (const rawTransaction of transactionInputs) {
      if (rawTransaction === null || typeof rawTransaction !== 'object' || Array.isArray(rawTransaction)) {
        conflicts.push('transaction record is invalid');
        continue;
      }
      const transaction = rawTransaction as FinancialTransaction;
      if (!transaction.transactionId || transactionIds.has(transaction.transactionId)) {
        conflicts.push(`duplicate transaction ID ${transaction.transactionId || '<missing>'}`);
      }
      transactionIds.add(transaction.transactionId);
      if (!accountIds.has(transaction.playerId)) {
        conflicts.push(`transaction ${transaction.transactionId || '<missing>'} has missing account reference`);
      }
      if (!['deposit', 'withdrawal'].includes(transaction.type)) {
        conflicts.push(`transaction ${transaction.transactionId || '<missing>'} has unrecognized type`);
      }
      if (!['pending', 'approved', 'rejected'].includes(transaction.status)) {
        conflicts.push(`transaction ${transaction.transactionId || '<missing>'} has unrecognized status`);
      }
      if (
        !Number.isSafeInteger(transaction.requestedAmountHundredths) ||
        transaction.requestedAmountHundredths <= 0 ||
        (transaction.actualAmountHundredths !== null &&
          (!Number.isSafeInteger(transaction.actualAmountHundredths) ||
            transaction.actualAmountHundredths < 0))
      ) {
        conflicts.push(`transaction ${transaction.transactionId || '<missing>'} has an unsafe amount`);
      }
      transactions.push(transaction);
    }

    const rounds: RocketRound[] = [];
    const roundIds = new Set<string>();
    for (const rawRound of roundInputs) {
      if (rawRound === null || typeof rawRound !== 'object' || Array.isArray(rawRound)) {
        conflicts.push('round record is invalid');
        continue;
      }
      const round = rawRound as RocketRound;
      if (!round.roundId || roundIds.has(round.roundId)) {
        conflicts.push(`duplicate round ID ${round.roundId || '<missing>'}`);
      }
      roundIds.add(round.roundId);
      if (!['active', 'closed', 'void'].includes(round.status)) {
        conflicts.push(`round ${round.roundId || '<missing>'} has unrecognized status`);
      }
      if (typeof round.quoteReleased !== 'boolean') {
        conflicts.push(`round ${round.roundId || '<missing>'} has invalid quote state`);
      }
      rounds.push(round);
    }

    const orders: LedgerOrder[] = [];
    const orderIds = new Set<string>();
    const validOrderStatuses = [
      'pending_hold',
      'pending_match',
      'matched',
      'cancelled',
      'resolved',
      'settled',
      'void',
    ];
    for (const rawOrder of orderInputs) {
      if (rawOrder === null || typeof rawOrder !== 'object' || Array.isArray(rawOrder)) {
        conflicts.push('order record is invalid');
        continue;
      }
      const order = rawOrder as LedgerOrder;
      if (!order.orderNumber || orderIds.has(order.orderNumber)) {
        conflicts.push(`duplicate order ID ${order.orderNumber || '<missing>'}`);
      }
      orderIds.add(order.orderNumber);
      if (!validOrderStatuses.includes(order.status)) {
        conflicts.push(`order ${order.orderNumber || '<missing>'} has unrecognized order status`);
      }
      if (!roundIds.has(order.roundId) || !accountIds.has(order.creatorId) ||
          (order.matcherId !== null && !accountIds.has(order.matcherId))) {
        conflicts.push(`order ${order.orderNumber || '<missing>'} has missing account reference`);
      }
      // A matched/resolved/settled order represents stakes held from BOTH sides;
      // without a valid, distinct matcher any settlement would create a credit
      // with no opposing stake.
      if (['matched', 'resolved', 'settled'].includes(order.status) &&
          (!order.matcherId || order.matcherId === order.creatorId || !accountIds.has(order.matcherId))) {
        conflicts.push(
          `order ${order.orderNumber || '<missing>'} is ${order.status} without a valid distinct matcher`,
        );
      }
      if (!Number.isSafeInteger(order.stakeHundredths) || order.stakeHundredths <= 0) {
        conflicts.push(`order ${order.orderNumber || '<missing>'} has an unsafe stake`);
      }
      orders.push(order);
    }

    const reconciliation = input.reconciliation;
    if (reconciliation === null || typeof reconciliation !== 'object' || Array.isArray(reconciliation)) {
      conflicts.push('reconciliation is required');
    }
    const expected = (reconciliation ?? {}) as Partial<SnapshotReconciliation>;
    const expectedCounts = {
      accountCount: expected.accountCount,
      transactionCount: expected.transactionCount,
      roundCount: expected.roundCount,
      orderCount: expected.orderCount,
    };
    const actualCounts = {
      accountCount: accounts.length,
      transactionCount: transactions.length,
      roundCount: rounds.length,
      orderCount: orders.length,
    };
    for (const [name, actual] of Object.entries(actualCounts)) {
      if (expectedCounts[name as keyof typeof expectedCounts] !== actual) {
        conflicts.push(`${name.replace(/Count$/, '')} count mismatch`);
      }
    }
    const expectedTotal = expected.totalBalanceHundredths;
    if (typeof expectedTotal !== 'number' || !Number.isSafeInteger(expectedTotal) || expectedTotal < 0) {
      conflicts.push('total balance is negative or unsafe');
    } else if (expectedTotal !== totalBalanceHundredths) {
      conflicts.push('total balance mismatch');
    }

    if (conflicts.length > 0) return { normalized: null, conflicts };
    return {
      normalized: {
        snapshotId,
        schemaVersion: IMPORT_SCHEMA_VERSION,
        accounts,
        transactions,
        rounds,
        orders,
        reconciliation: {
          accountCount: accounts.length,
          transactionCount: transactions.length,
          roundCount: rounds.length,
          orderCount: orders.length,
          totalBalanceHundredths,
        },
      },
      conflicts,
    };
  }

  private previewImport(rawInput: unknown): ImportPreview {
    const { normalized, conflicts } = this.validateImportSnapshot(rawInput);
    conflicts.push(...this.schemaConflicts());
    const snapshotId = normalized?.snapshotId ??
      (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) &&
        typeof (rawInput as Record<string, unknown>).snapshotId === 'string'
        ? (rawInput as Record<string, unknown>).snapshotId as string
        : null);
    const counts = normalized?.reconciliation ?? {
      accountCount: Array.isArray((rawInput as Record<string, unknown> | null)?.accounts)
        ? ((rawInput as Record<string, unknown>).accounts as unknown[]).length : 0,
      transactionCount: Array.isArray((rawInput as Record<string, unknown> | null)?.transactions)
        ? ((rawInput as Record<string, unknown>).transactions as unknown[]).length : 0,
      roundCount: Array.isArray((rawInput as Record<string, unknown> | null)?.rounds)
        ? ((rawInput as Record<string, unknown>).rounds as unknown[]).length : 0,
      orderCount: Array.isArray((rawInput as Record<string, unknown> | null)?.orders)
        ? ((rawInput as Record<string, unknown>).orders as unknown[]).length : 0,
      totalBalanceHundredths: 0,
    };
    if (normalized) {
      const imported = this.state.storage.sql
        .exec<ImportRow>('SELECT * FROM imported_snapshots WHERE snapshot_id = ?', normalized.snapshotId)
        .toArray()[0];
      if (!imported) {
        for (const account of normalized.accounts) {
          if (account.kind !== 'house' && this.accountRow(account.playerId)) {
            conflicts.push(`duplicate account ID ${account.playerId}`);
          }
          if (account.lineUserId) {
            const existingLineUser = this.state.storage.sql
              .exec<AccountRow>(
                'SELECT * FROM accounts WHERE line_user_id = ?',
                account.lineUserId,
              )
              .toArray()[0];
            if (existingLineUser && existingLineUser.player_id !== account.playerId) {
              conflicts.push(`duplicate line user ID ${account.lineUserId}`);
            }
          }
        }
        for (const transaction of normalized.transactions) {
          if (this.transactionRow(transaction.transactionId)) {
            conflicts.push(`duplicate transaction ID ${transaction.transactionId}`);
          }
        }
        for (const round of normalized.rounds) {
          if (this.roundRow(round.roundId)) conflicts.push(`duplicate round ID ${round.roundId}`);
        }
        for (const order of normalized.orders) {
          if (this.orderRow(order.orderNumber)) conflicts.push(`duplicate order ID ${order.orderNumber}`);
        }
      }
    }
    return {
      canImport: conflicts.length === 0 && normalized !== null,
      conflicts: Array.from(new Set(conflicts)),
      snapshotId,
      accountCount: counts.accountCount,
      transactionCount: counts.transactionCount,
      roundCount: counts.roundCount,
      orderCount: counts.orderCount,
      totalBalanceHundredths: counts.totalBalanceHundredths,
    };
  }

  private importSnapshot(rawInput: ImportFinancialSnapshotInput): ImportResult {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.provenance = validateText(input.provenance, 'provenance', 240);
    this.ensureSchemaReady();
    const chunkSize = input.chunkSize ?? DEFAULT_IMPORT_CHUNK_SIZE;
    const maxChunksPerCall = input.maxChunksPerCall ?? MAX_IMPORT_CHUNKS_PER_CALL;
    if (
      !Number.isSafeInteger(chunkSize) ||
      chunkSize < 1 ||
      chunkSize > MAX_IMPORT_CHUNK_SIZE
    ) {
      throw new CoordinatorError('INVALID_INPUT', `chunkSize must be between 1 and ${MAX_IMPORT_CHUNK_SIZE}`);
    }
    if (
      !Number.isSafeInteger(maxChunksPerCall) ||
      maxChunksPerCall < 1 ||
      maxChunksPerCall > MAX_IMPORT_CHUNKS_PER_CALL
    ) {
      throw new CoordinatorError(
        'INVALID_INPUT',
        `maxChunksPerCall must be between 1 and ${MAX_IMPORT_CHUNKS_PER_CALL}`,
      );
    }
    const { normalized, conflicts } = this.validateImportSnapshot(input.snapshot);
    if (!normalized || conflicts.length > 0) {
      throw new CoordinatorError('IMPORT_CONFLICT', conflicts.join('; ') || 'Snapshot cannot be imported');
    }
    const preview = this.previewImport(input.snapshot);
    if (!preview.canImport) {
      throw new CoordinatorError('IMPORT_CONFLICT', preview.conflicts.join('; '));
    }
    const fingerprint = stableJson({ snapshot: normalized, provenance: input.provenance });
    const existing = this.importRow(normalized.snapshotId);
    if (existing && existing.request_fingerprint !== fingerprint) {
      throw new CoordinatorError('IMPORT_CONFLICT', 'Snapshot ID was imported with different content');
    }
    if (!existing) {
      const now = Date.now();
      this.state.storage.sql.exec(
        `INSERT INTO imported_snapshots
          (snapshot_id, schema_version, provenance, request_fingerprint, result_json,
           account_count, transaction_count, round_count, order_count,
           total_balance_hundredths, unresolved_conflicts, status,
           account_cursor, transaction_cursor, round_cursor, order_cursor,
           house_account_included, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        normalized.snapshotId,
        normalized.schemaVersion,
        input.provenance,
        fingerprint,
        JSON.stringify({
          complete: false,
          importedAccountCount: 0,
          importedTransactionCount: 0,
          importedRoundCount: 0,
          importedOrderCount: 0,
        } satisfies ImportResult),
        normalized.reconciliation.accountCount,
        normalized.reconciliation.transactionCount,
        normalized.reconciliation.roundCount,
        normalized.reconciliation.orderCount,
        normalized.reconciliation.totalBalanceHundredths,
        0,
        'in_progress',
        0,
        0,
        0,
        0,
        normalized.accounts.some((account) => account.kind === 'house') ? 1 : 0,
        now,
      );
    }

    let chunks = 0;
    while (chunks < maxChunksPerCall) {
      const progress = this.importRow(normalized.snapshotId);
      if (!progress) {
        throw new CoordinatorError('INTERNAL', 'Import progress record was not created');
      }
      if (progress.status === 'complete') return JSON.parse(progress.result_json) as ImportResult;

      const committed = this.state.storage.transactionSync(() => {
        const current = this.importRow(normalized.snapshotId);
        if (!current) throw new CoordinatorError('INTERNAL', 'Import progress record disappeared');
        if (current.status === 'complete') return false;
        const now = Date.now();
        if (current.account_cursor < normalized.accounts.length) {
          const end = Math.min(current.account_cursor + chunkSize, normalized.accounts.length);
          for (const account of normalized.accounts.slice(current.account_cursor, end)) {
            if (account.kind === 'house') {
              const house = this.accountRow(HOUSE_ACCOUNT_ID);
              if (!house) {
                throw new CoordinatorError('IMPORT_CONFLICT', 'Required house account is missing');
              }
              this.state.storage.sql.exec(
                `UPDATE accounts
                 SET line_user_id = ?, display_name = ?, balance_hundredths = ?,
                     active = ?, kind = ?, created_at = ?, updated_at = ?
                 WHERE player_id = ?`,
                account.lineUserId,
                account.displayName,
                account.balanceHundredths,
                account.active ? 1 : 0,
                account.kind,
                account.createdAt || now,
                account.updatedAt || now,
                HOUSE_ACCOUNT_ID,
              );
              if (account.balanceHundredths > 0) {
                this.addLedgerEntry({
                  accountId: HOUSE_ACCOUNT_ID,
                  idempotencyKey: `import:${normalized.snapshotId}:account:${HOUSE_ACCOUNT_ID}`,
                  deltaHundredths: account.balanceHundredths,
                  balanceAfterHundredths: account.balanceHundredths,
                  eventType: 'opening_balance',
                  referenceId: normalized.snapshotId,
                  reason: `Imported opening balance (${input.provenance})`,
                });
              }
              continue;
            }
            this.state.storage.sql.exec(
              `INSERT INTO accounts
                (player_id, line_user_id, display_name, balance_hundredths, active, kind, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              account.playerId,
              account.lineUserId,
              account.displayName,
              account.balanceHundredths,
              account.active ? 1 : 0,
              account.kind,
              account.createdAt || now,
              account.updatedAt || now,
            );
            if (account.balanceHundredths > 0) {
              this.addLedgerEntry({
                accountId: account.playerId,
                idempotencyKey: `import:${normalized.snapshotId}:account:${account.playerId}`,
                deltaHundredths: account.balanceHundredths,
                balanceAfterHundredths: account.balanceHundredths,
                eventType: 'opening_balance',
                referenceId: normalized.snapshotId,
                reason: `Imported opening balance (${input.provenance})`,
              });
            }
          }
          this.updateImportCursor(normalized.snapshotId, 'account_cursor', end);
          return true;
        }
        if (current.transaction_cursor < normalized.transactions.length) {
          const end = Math.min(
            current.transaction_cursor + chunkSize,
            normalized.transactions.length,
          );
          for (const transaction of normalized.transactions.slice(current.transaction_cursor, end)) {
            this.state.storage.sql.exec(
              `INSERT INTO transactions
                (transaction_id, player_id, type, requested_amount_hundredths,
                 actual_amount_hundredths, status, bank_name, account_number,
                 account_name, actor_id, reason, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              transaction.transactionId,
              transaction.playerId,
              transaction.type,
              transaction.requestedAmountHundredths,
              transaction.actualAmountHundredths,
              transaction.status,
              transaction.bankName,
              transaction.accountNumber,
              transaction.accountName,
              transaction.actorId,
              transaction.reason,
              transaction.createdAt || now,
              transaction.updatedAt || now,
            );
          }
          this.updateImportCursor(normalized.snapshotId, 'transaction_cursor', end);
          return true;
        }
        if (current.round_cursor < normalized.rounds.length) {
          const end = Math.min(current.round_cursor + chunkSize, normalized.rounds.length);
          for (const round of normalized.rounds.slice(current.round_cursor, end)) {
            this.state.storage.sql.exec(
              `INSERT INTO rounds
                (round_id, name, status, quote_released, target_min, target_max, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              round.roundId,
              round.name,
              round.status,
              round.quoteReleased ? 1 : 0,
              round.targetMin,
              round.targetMax,
              round.createdAt || now,
              round.updatedAt || now,
            );
          }
          this.updateImportCursor(normalized.snapshotId, 'round_cursor', end);
          return true;
        }
        if (current.order_cursor < normalized.orders.length) {
          const end = Math.min(current.order_cursor + chunkSize, normalized.orders.length);
          for (const order of normalized.orders.slice(current.order_cursor, end)) {
            this.state.storage.sql.exec(
              `INSERT INTO orders
                (order_number, round_id, creator_id, matcher_id, stake_hundredths,
                 status, order_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              order.orderNumber,
              order.roundId,
              order.creatorId,
              order.matcherId,
              order.stakeHundredths,
              order.status,
              JSON.stringify(order),
              order.createdAt || now,
              order.settledAt || order.createdAt || now,
            );
          }
          this.updateImportCursor(normalized.snapshotId, 'order_cursor', end);
          return true;
        }

        const completed: ImportResult = {
          complete: true,
          importedAccountCount: normalized.accounts.length,
          importedTransactionCount: normalized.transactions.length,
          importedRoundCount: normalized.rounds.length,
          importedOrderCount: normalized.orders.length,
        };
        this.state.storage.sql.exec(
          `UPDATE imported_snapshots
           SET status = 'complete', result_json = ?, imported_at = ?
           WHERE snapshot_id = ?`,
          JSON.stringify(completed),
          now,
          normalized.snapshotId,
        );
        return false;
      });
      if (!committed) {
        const completed = this.importRow(normalized.snapshotId);
        if (!completed) throw new CoordinatorError('INTERNAL', 'Import completion record disappeared');
        return JSON.parse(completed.result_json) as ImportResult;
      }
      chunks += 1;
    }

    const partial = this.importRow(normalized.snapshotId);
    if (!partial) throw new CoordinatorError('INTERNAL', 'Import progress record disappeared');
    return this.importResultFromProgress(partial);
  }

  private importRow(snapshotId: string): ImportRow | undefined {
    return this.state.storage.sql
      .exec<ImportRow>('SELECT * FROM imported_snapshots WHERE snapshot_id = ?', snapshotId)
      .toArray()[0];
  }

  private updateImportCursor(
    snapshotId: string,
    cursor: 'account_cursor' | 'transaction_cursor' | 'round_cursor' | 'order_cursor',
    value: number,
  ): void {
    this.state.storage.sql.exec(
      `UPDATE imported_snapshots SET ${cursor} = ? WHERE snapshot_id = ?`,
      value,
      snapshotId,
    );
  }

  private importResultFromProgress(progress: ImportRow): ImportResult {
    return {
      complete: progress.status === 'complete',
      importedAccountCount: progress.account_cursor,
      importedTransactionCount: progress.transaction_cursor,
      importedRoundCount: progress.round_cursor,
      importedOrderCount: progress.order_cursor,
    };
  }

  private activateAuthority(rawInput: ActivateAuthorityInput): void {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.operatorId = validateIdentifier(input.operatorId, 'operatorId');
    input.snapshotId = validateIdentifier(input.snapshotId, 'snapshotId');
    if (input.confirmation !== AUTHORITY_CONFIRMATION) {
      throw new CoordinatorError('IMPORT_CONFLICT', 'Explicit authority activation confirmation is required');
    }
    this.ensureSchemaReady();
    const result = this.replayOrBegin('activateAuthority', input.idempotencyKey, input, () => {
      const authority = this.state.storage.sql
        .exec<AuthorityRow>('SELECT * FROM authority_state WHERE authority_id = ?', 'financial')
        .toArray()[0];
      if (!authority || authority.schema_version !== IMPORT_SCHEMA_VERSION) {
        throw new CoordinatorError('IMPORT_CONFLICT', 'Required authority schema is not ready');
      }
      if (authority.active === 1) {
        if (authority.snapshot_id !== input.snapshotId) {
          throw new CoordinatorError('IMPORT_CONFLICT', 'A different snapshot is already active');
        }
      }
      const imported = this.state.storage.sql
        .exec<ImportRow>('SELECT * FROM imported_snapshots WHERE snapshot_id = ?', input.snapshotId)
        .toArray()[0];
      if (
        !imported ||
        imported.unresolved_conflicts !== 0 ||
        imported.status !== 'complete'
      ) {
        throw new CoordinatorError('IMPORT_CONFLICT', 'Snapshot import has not been verified and completed');
      }
      if (
        input.accountCount !== imported.account_count ||
        input.transactionCount !== imported.transaction_count ||
        input.roundCount !== imported.round_count ||
        input.orderCount !== imported.order_count
      ) {
        throw new CoordinatorError('IMPORT_CONFLICT', 'Activation totals do not match the imported snapshot');
      }
      const actualAccountCount = this.state.storage.sql
        .exec<{ count: number }>(
          imported.house_account_included === 1
            ? 'SELECT COUNT(*) AS count FROM accounts'
            : "SELECT COUNT(*) AS count FROM accounts WHERE kind = 'player'",
        )
        .toArray()[0]?.count ?? 0;
      const actualTransactionCount = this.state.storage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM transactions')
        .toArray()[0]?.count ?? 0;
      const actualRoundCount = this.state.storage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM rounds')
        .toArray()[0]?.count ?? 0;
      const actualOrderCount = this.state.storage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM orders')
        .toArray()[0]?.count ?? 0;
      if (
        input.accountCount !== actualAccountCount ||
        input.transactionCount !== actualTransactionCount ||
        input.roundCount !== actualRoundCount ||
        input.orderCount !== actualOrderCount
      ) {
        throw new CoordinatorError('IMPORT_CONFLICT', 'Activation totals do not match coordinator state');
      }
      const actualBalance = this.state.storage.sql
        .exec<{ total: number | null }>(
          'SELECT COALESCE(SUM(balance_hundredths), 0) AS total FROM accounts',
        )
        .toArray()[0]?.total ?? 0;
      const importedBalance = imported.total_balance_hundredths;
      const ledgerBalance = this.state.storage.sql
        .exec<{ total: number | null }>(
          'SELECT COALESCE(SUM(delta_hundredths), 0) AS total FROM ledger',
        )
        .toArray()[0]?.total ?? 0;
      if (actualBalance !== importedBalance || ledgerBalance !== actualBalance) {
        throw new CoordinatorError(
          'IMPORT_CONFLICT',
          'Imported account and ledger totals do not reconcile',
        );
      }
      if (authority.active === 1) return { activated: true };
      this.state.storage.sql.exec(
        `UPDATE authority_state
         SET active = 1, snapshot_id = ?, account_count = ?, transaction_count = ?,
             round_count = ?, order_count = ?, unresolved_conflicts = 0, updated_at = ?
         WHERE authority_id = 'financial'`,
        input.snapshotId,
        input.accountCount,
        input.transactionCount,
        input.roundCount,
        input.orderCount,
        Date.now(),
      );
      return { activated: true };
    });
    void result;
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
    const entryId = crypto.randomUUID();
    const createdAt = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO ledger
        (entry_id, account_id, idempotency_key, delta_hundredths, balance_after_hundredths,
         event_type, reference_id, actor_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entryId,
      input.accountId,
      input.idempotencyKey,
      input.deltaHundredths,
      input.balanceAfterHundredths,
      input.eventType,
      input.referenceId ?? null,
      input.actorId ?? null,
      input.reason ?? null,
      createdAt,
    );
    this.state.storage.sql.exec(
      `INSERT INTO projection_outbox
        (outbox_id, event_type, payload_json, created_at, delivered_at)
       VALUES (?, ?, ?, ?, NULL)`,
      entryId,
      'ledger.entry',
      JSON.stringify({
        entryId,
        accountId: input.accountId,
        idempotencyKey: input.idempotencyKey,
        deltaHundredths: input.deltaHundredths,
        balanceAfterHundredths: input.balanceAfterHundredths,
        eventType: input.eventType,
        referenceId: input.referenceId ?? null,
        actorId: input.actorId ?? null,
        reason: input.reason ?? null,
        createdAt,
      }),
      createdAt,
    );
  }

  private async scheduleProjectionAlarm(): Promise<void> {
    const pending = this.state.storage.sql
      .exec<{ next_attempt_at: number }>(
        `SELECT next_attempt_at FROM projection_outbox
         WHERE delivered_at IS NULL ORDER BY next_attempt_at, created_at LIMIT 1`,
      )
      .toArray()[0];
    if (!pending) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(Math.max(Date.now() + 1000, pending.next_attempt_at));
  }

  private async drainProjectionOutbox(): Promise<ProjectionDrainResult> {
    const now = Date.now();
    const pending = this.state.storage.sql
      .exec<ProjectionOutboxRow>(
        `SELECT outbox_id, event_type, payload_json, created_at, delivered_at,
                attempt_count, next_attempt_at
         FROM projection_outbox
         WHERE delivered_at IS NULL AND next_attempt_at <= ?
         ORDER BY created_at, outbox_id LIMIT 50`,
        now,
      )
      .toArray();
    let delivered = 0;
    let failed = 0;
    const projectionUrl = this.env.GAS_PROJECTION_URL;
    const projectionKey = this.env.PROJECTION_API_KEY;

    for (const row of pending) {
      try {
        if (!projectionUrl || !projectionKey) {
          throw new Error('GAS projection delivery is not configured');
        }
        const response = await fetch(projectionUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'projection',
            projectionKey,
            event: {
              eventId: row.outbox_id,
              ledgerEntry: JSON.parse(row.payload_json),
              snapshot: this.getSnapshot(),
            },
          }),
        });
        const acknowledgement = (await response.json()) as { success?: boolean; eventId?: string };
        if (!response.ok || acknowledgement.success !== true || acknowledgement.eventId !== row.outbox_id) {
          throw new Error('GAS projection delivery was not acknowledged');
        }
        this.state.storage.sql.exec(
          'UPDATE projection_outbox SET delivered_at = ? WHERE outbox_id = ? AND delivered_at IS NULL',
          Date.now(),
          row.outbox_id,
        );
        delivered += 1;
      } catch (error) {
        const attempts = row.attempt_count + 1;
        const retryDelay = Math.min(1000 * (2 ** Math.min(attempts - 1, 12)), 3_600_000);
        this.state.storage.sql.exec(
          `UPDATE projection_outbox
           SET attempt_count = ?, next_attempt_at = ?
           WHERE outbox_id = ? AND delivered_at IS NULL`,
          attempts,
          Date.now() + retryDelay,
          row.outbox_id,
        );
        failed += 1;
        console.warn('[FinancialCoordinator] Projection delivery failed:', error);
      }
    }

    const remaining = this.state.storage.sql
      .exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM projection_outbox WHERE delivered_at IS NULL',
      )
      .toArray()[0]?.count ?? 0;
    await this.scheduleProjectionAlarm();
    return { delivered, failed, pending: remaining };
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

  private ensureAuthorityReady(): void {
    if (this.schemaConflicts().length > 0) {
      throw new CoordinatorError(
        'AUTHORITY_NOT_READY',
        'Financial schema verification failed; authority remains closed',
      );
    }
    const authority = this.state.storage.sql
      .exec<AuthorityRow>(
        'SELECT active FROM authority_state WHERE authority_id = ?',
        'financial',
      )
      .toArray()[0];
    if (!authority || authority.active !== 1) {
      throw new CoordinatorError(
        'AUTHORITY_NOT_READY',
        'Financial authority is not activated after a verified snapshot import',
      );
    }
  }

  private validateIdempotentInput<T extends { idempotencyKey: string }>(
    input: T,
  ): T & { idempotencyKey: string } {
    input.idempotencyKey = validateIdentifier(input.idempotencyKey, 'idempotencyKey');
    return input;
  }

  private mapRound(row: RoundRow): RocketRound {
    return {
      roundId: row.round_id,
      name: row.name,
      status: row.status,
      quoteReleased: row.quote_released === 1,
      targetMin: row.target_min,
      targetMax: row.target_max,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapOrder(row: OrderRow): LedgerOrder {
    const payload = JSON.parse(row.order_json) as Record<string, unknown>;
    return {
      orderNumber: row.order_number,
      roundId: row.round_id,
      creatorId: row.creator_id,
      creatorName: String(payload.creatorName ?? ''),
      matcherId: typeof row.matcher_id === 'string' ? row.matcher_id : null,
      matcherName: typeof payload.matcherName === 'string' ? payload.matcherName : null,
      side: (payload.side as 'low' | 'high') ?? 'low',
      stakeHundredths: Number(row.stake_hundredths),
      betType: (payload.betType as 'range' | 'custom_range' | 'pre_quote') ?? 'range',
      rangeMin: Number(payload.rangeMin ?? 0),
      rangeMax: Number(payload.rangeMax ?? 0),
      rangeOffset: Number(payload.rangeOffset ?? 0),
      status: row.status as LedgerOrder['status'],
      groupId: String(payload.groupId ?? ''),
      createdAt: Number(row.created_at),
      matchedAt: typeof payload.matchedAt === 'number' ? payload.matchedAt : null,
      winnerSide: typeof payload.winnerSide === 'string' ? (payload.winnerSide as 'low' | 'high' | 'draw') : null,
      finalSeconds: typeof payload.finalSeconds === 'number' ? payload.finalSeconds : null,
      settledAt: typeof payload.settledAt === 'number' ? payload.settledAt : null,
    };
  }

  private ensureRoundOpen(roundId: string): RoundRow {
    const row = this.roundRow(roundId);
    if (!row) throw new CoordinatorError('NOT_FOUND', 'Round not found');
    if (row.status !== 'active') throw new CoordinatorError('INVALID_STATE', 'Round is not active');
    return row;
  }

  private generateOrderNumber(): string {
    let candidate = '';
    while (!candidate || this.orderRow(candidate)) {
      candidate = String(Math.floor(1000 + Math.random() * 9000));
    }
    return candidate;
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
             AND status IN ('pending_hold', 'pending_match', 'matched')`,
          input.playerId,
          input.playerId,
        )
        .toArray()[0]?.count ?? 0;
      if (unsettled > 0) {
        throw new CoordinatorError('INVALID_STATE', 'Player has unsettled orders');
      }
      const pendingTransactions = this.state.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM transactions
           WHERE player_id = ? AND status = 'pending'`,
          input.playerId,
        )
        .toArray()[0]?.count ?? 0;
      if (pendingTransactions > 0) {
        throw new CoordinatorError('INVALID_STATE', 'Player has pending financial transactions');
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

  private requestDeposit(rawInput: RequestDepositInput): FinancialTransaction {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.transactionId = validateIdentifier(input.transactionId, 'transactionId');
    input.playerId = validateIdentifier(input.playerId, 'playerId');
    input.amountHundredths = validatePointHundredths(input.amountHundredths, 'amountHundredths', false);

    return this.replayOrBegin('requestDeposit', input.idempotencyKey, input, () => {
      if (this.transactionRow(input.transactionId)) {
        throw new CoordinatorError('DUPLICATE_ID', 'Transaction ID already exists');
      }
      this.requireActivePlayer(input.playerId);
      const now = Date.now();
      this.state.storage.sql.exec(
        `INSERT INTO transactions
          (transaction_id, player_id, type, requested_amount_hundredths,
           actual_amount_hundredths, status, bank_name, account_number,
           account_name, actor_id, reason, created_at, updated_at)
         VALUES (?, ?, 'deposit', ?, NULL, 'pending', '', '', '', NULL, NULL, ?, ?)`,
        input.transactionId,
        input.playerId,
        input.amountHundredths,
        now,
        now,
      );
      const transaction = this.transactionRow(input.transactionId);
      if (!transaction) throw new CoordinatorError('INTERNAL', 'Created deposit request could not be loaded');
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
      if (input.decision === 'approve' && input.actualAmountHundredths !== transaction.requested_amount_hundredths) {
        throw new CoordinatorError('INVALID_INPUT', 'Approved amount must match the requested amount');
      }

      const now = Date.now();
      if (input.decision === 'approve' && transaction.type === 'deposit') {
        const account = this.accountRow(transaction.player_id);
        if (!account) throw new CoordinatorError('NOT_FOUND', 'Player account not found');
        if (account.active !== 1) throw new CoordinatorError('INVALID_STATE', 'Player account is not active');
        const nextBalance = account.balance_hundredths + transaction.requested_amount_hundredths;
        if (!Number.isSafeInteger(nextBalance)) {
          throw new CoordinatorError('INTERNAL', 'Deposit credit exceeds the supported balance range');
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
          eventType: 'deposit_approved',
          referenceId: input.transactionId,
          actorId: input.actorId,
          reason: input.reason,
        });
      } else if (input.decision === 'reject' && transaction.type === 'withdrawal') {
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

  private openRound(rawInput: OpenRoundInput): RocketRound {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.roundId = validateIdentifier(input.roundId, 'roundId');
    input.name = validateText(input.name, 'name', 120);

    return this.replayOrBegin('openRound', input.idempotencyKey, input, () => {
      const existing = this.roundRow(input.roundId);
      if (existing) {
        if (existing.status === 'active') return this.mapRound(existing);
        throw new CoordinatorError('DUPLICATE_ID', 'Round ID already exists');
      }
      const now = Date.now();
      const matchedOrder = this.state.storage.sql
        .exec<OrderRow>(`SELECT * FROM orders WHERE status = 'matched' LIMIT 1`)
        .toArray()[0];
      if (matchedOrder) {
        throw new CoordinatorError(
          'INVALID_STATE',
          `Cannot open a replacement round while matched orders remain unsettled (order ${matchedOrder.order_number})`,
        );
      }
      const activeRounds = this.state.storage.sql
        .exec<RoundRow>(`SELECT * FROM rounds WHERE status = 'active' ORDER BY created_at`)
        .toArray();
      for (const activeRound of activeRounds) {
        const pendingOrders = this.state.storage.sql
          .exec<OrderRow>(
            `SELECT * FROM orders
             WHERE round_id = ? AND status IN ('pending_hold', 'pending_match')
             ORDER BY created_at`,
            activeRound.round_id,
          )
          .toArray();
        for (const orderRow of pendingOrders) {
          const order = this.mapOrder(orderRow);
          const account = this.accountRow(order.creatorId);
          if (!account) throw new CoordinatorError('NOT_FOUND', 'Order creator account not found');
          const nextBalance = account.balance_hundredths + order.stakeHundredths;
          if (!Number.isSafeInteger(nextBalance)) {
            throw new CoordinatorError('INTERNAL', 'Round replacement refund exceeds the supported balance range');
          }
          this.state.storage.sql.exec(
            'UPDATE accounts SET balance_hundredths = ?, updated_at = ? WHERE player_id = ?',
            nextBalance,
            now,
            order.creatorId,
          );
          this.addLedgerEntry({
            accountId: order.creatorId,
            idempotencyKey: `openRound:${input.idempotencyKey}:${activeRound.round_id}:${order.orderNumber}`,
            deltaHundredths: order.stakeHundredths,
            balanceAfterHundredths: nextBalance,
            eventType: 'order_cancelled',
            referenceId: order.orderNumber,
            actorId: order.creatorId,
            reason: 'Replaced by a new round',
          });
          const payload = JSON.parse(orderRow.order_json) as Record<string, unknown>;
          payload.winnerSide = null;
          payload.finalSeconds = null;
          payload.settledAt = null;
          this.state.storage.sql.exec(
            `UPDATE orders SET status = 'cancelled', order_json = ?, updated_at = ? WHERE order_number = ?`,
            JSON.stringify(payload),
            now,
            order.orderNumber,
          );
        }
        this.state.storage.sql.exec(
          `UPDATE rounds SET status = 'closed', updated_at = ? WHERE round_id = ?`,
          now,
          activeRound.round_id,
        );
      }
      this.state.storage.sql.exec(
        `INSERT INTO rounds (round_id, name, status, quote_released, target_min, target_max, created_at, updated_at)
         VALUES (?, ?, 'active', 0, NULL, NULL, ?, ?)`,
        input.roundId,
        input.name,
        now,
        now,
      );
      const row = this.roundRow(input.roundId);
      if (!row) throw new CoordinatorError('INTERNAL', 'Round could not be loaded');
      return this.mapRound(row);
    });
  }

  private createOrder(rawInput: CreateOrderInput): LedgerOrder {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.roundId = validateIdentifier(input.roundId, 'roundId');
    input.creatorId = validateIdentifier(input.creatorId, 'creatorId');
    if (input.side !== 'low' && input.side !== 'high') {
      throw new CoordinatorError('INVALID_INPUT', 'side must be low or high');
    }
    input.stakeHundredths = validateStakeHundredths(input.stakeHundredths);
    if (!['range', 'custom_range', 'pre_quote'].includes(input.betType)) {
      throw new CoordinatorError('INVALID_INPUT', 'betType is invalid');
    }
    input.rangeMin = Number(input.rangeMin);
    input.rangeMax = Number(input.rangeMax);
    input.rangeOffset = input.rangeOffset === undefined ? 0 : Number(input.rangeOffset);
    if (!Number.isFinite(input.rangeMin) || !Number.isFinite(input.rangeMax)) {
      throw new CoordinatorError('INVALID_INPUT', 'rangeMin and rangeMax must be finite numbers');
    }
    if (input.rangeMin > input.rangeMax) {
      throw new CoordinatorError('INVALID_INPUT', 'rangeMin cannot exceed rangeMax');
    }
    if (![0, 5, -5, 10, -10].includes(input.rangeOffset)) {
      throw new CoordinatorError('INVALID_INPUT', 'rangeOffset must be 0, +/-5, or +/-10');
    }
    if (input.betType !== 'pre_quote' && input.rangeMin >= input.rangeMax) {
      throw new CoordinatorError('INVALID_INPUT', 'rangeMin must be less than rangeMax');
    }
    if (input.betType === 'custom_range' && input.rangeMax - input.rangeMin > 50) {
      throw new CoordinatorError('INVALID_INPUT', 'Custom order range cannot exceed 50 seconds');
    }
    input.creatorName = validateText(input.creatorName, 'creatorName', 120);
    input.groupId = validateIdentifier(input.groupId, 'groupId');

    return this.replayOrBegin('createOrder', input.idempotencyKey, input, () => {
      const round = this.ensureRoundOpen(input.roundId);
      const creator = this.requireActivePlayer(input.creatorId);
      const nextBalance = creator.account.balanceHundredths - input.stakeHundredths;
      if (nextBalance < 0) {
        throw new CoordinatorError('INSUFFICIENT_FUNDS', 'Insufficient balance for order stake');
      }

      const orderNumber = this.generateOrderNumber();
      const resolvedBetType = input.betType === 'pre_quote' && round.quote_released ? 'range' : input.betType;
      const resolvedRangeMin = resolvedBetType === 'range' && input.betType === 'pre_quote' && round.quote_released
        ? (round.target_min ?? input.rangeMin)
        : input.rangeMin;
      const resolvedRangeMax = resolvedBetType === 'range' && input.betType === 'pre_quote' && round.quote_released
        ? (round.target_max ?? input.rangeMax)
        : input.rangeMax;
      const orderStatus: LedgerOrder['status'] = resolvedBetType === 'custom_range' || round.quote_released
        ? 'pending_match'
        : 'pending_hold';
      const payload = {
        creatorId: input.creatorId,
        creatorName: input.creatorName,
        matcherId: null,
        matcherName: null,
        side: input.side,
        stakeHundredths: input.stakeHundredths,
        betType: resolvedBetType,
        rangeMin: resolvedRangeMin,
        rangeMax: resolvedRangeMax,
        rangeOffset: input.rangeOffset,
        groupId: input.groupId,
        matchedAt: null,
        winnerSide: null,
        finalSeconds: null,
        settledAt: null,
      };
      const now = Date.now();
      this.state.storage.sql.exec(
        `INSERT INTO orders
          (order_number, round_id, creator_id, matcher_id, stake_hundredths, status, order_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        orderNumber,
        input.roundId,
        input.creatorId,
        null,
        input.stakeHundredths,
        orderStatus,
        JSON.stringify(payload),
        now,
        now,
      );
      this.state.storage.sql.exec(
        'UPDATE accounts SET balance_hundredths = ?, updated_at = ? WHERE player_id = ?',
        nextBalance,
        now,
        input.creatorId,
      );
      this.addLedgerEntry({
        accountId: input.creatorId,
        idempotencyKey: `createOrder:${input.idempotencyKey}`,
        deltaHundredths: -input.stakeHundredths,
        balanceAfterHundredths: nextBalance,
        eventType: 'order_hold',
        referenceId: orderNumber,
        actorId: input.creatorId,
        reason: 'Order stake reserved',
      });
      const row = this.orderRow(orderNumber);
      if (!row) throw new CoordinatorError('INTERNAL', 'Created order could not be loaded');
      return this.mapOrder(row);
    });
  }

  private matchOrder(rawInput: MatchOrderInput): LedgerOrder {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.orderNumber = validateIdentifier(input.orderNumber, 'orderNumber');
    input.matcherId = validateIdentifier(input.matcherId, 'matcherId');
    input.stakeHundredths = validateStakeHundredths(input.stakeHundredths);
    input.matcherName = validateText(input.matcherName, 'matcherName', 120);

    return this.replayOrBegin('matchOrder', input.idempotencyKey, input, () => {
      const row = this.orderRow(input.orderNumber);
      if (!row) throw new CoordinatorError('NOT_FOUND', 'Order not found');
      const order = this.mapOrder(row);
      if (order.status !== 'pending_match') {
        throw new CoordinatorError('INVALID_STATE', 'Order is not currently open for matching');
      }
      if (order.creatorId === input.matcherId) {
        throw new CoordinatorError('INVALID_STATE', 'The creator cannot match their own order');
      }
      if (order.matcherId !== null) {
        throw new CoordinatorError('INVALID_STATE', 'Order has already been matched');
      }
      if (input.stakeHundredths !== order.stakeHundredths) {
        throw new CoordinatorError('STAKE_MISMATCH', 'Matcher stake does not match the order stake');
      }

      const matcher = this.requireActivePlayer(input.matcherId);
      const nextBalance = matcher.account.balanceHundredths - input.stakeHundredths;
      if (nextBalance < 0) {
        throw new CoordinatorError('INSUFFICIENT_FUNDS', 'Matcher does not have enough balance');
      }
      const now = Date.now();
      this.state.storage.sql.exec(
        'UPDATE accounts SET balance_hundredths = ?, updated_at = ? WHERE player_id = ?',
        nextBalance,
        now,
        input.matcherId,
      );
      this.addLedgerEntry({
        accountId: input.matcherId,
        idempotencyKey: `matchOrder:${input.idempotencyKey}`,
        deltaHundredths: -input.stakeHundredths,
        balanceAfterHundredths: nextBalance,
        eventType: 'order_matched',
        referenceId: input.orderNumber,
        actorId: input.matcherId,
        reason: 'Order matched',
      });

      const payload = JSON.parse(row.order_json) as Record<string, unknown>;
      payload.matcherId = input.matcherId;
      payload.matcherName = input.matcherName;
      payload.matchedAt = now;
      this.state.storage.sql.exec(
        `UPDATE orders
         SET matcher_id = ?, status = 'matched', order_json = ?, updated_at = ?
         WHERE order_number = ?`,
        input.matcherId,
        JSON.stringify(payload),
        now,
        input.orderNumber,
      );
      const updated = this.orderRow(input.orderNumber);
      if (!updated) throw new CoordinatorError('INTERNAL', 'Matched order could not be loaded');
      return this.mapOrder(updated);
    });
  }

  private autoMatchOrders(rawInput: AutoMatchOrdersInput): LedgerOrder {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.orderNumber = validateIdentifier(input.orderNumber, 'orderNumber');
    input.counterpartOrderNumber = validateIdentifier(input.counterpartOrderNumber, 'counterpartOrderNumber');
    if (input.orderNumber === input.counterpartOrderNumber) {
      throw new CoordinatorError('INVALID_INPUT', 'An order cannot be paired with itself');
    }

    return this.replayOrBegin('autoMatchOrders', input.idempotencyKey, input, () => {
      const primaryRow = this.orderRow(input.orderNumber);
      const counterpartRow = this.orderRow(input.counterpartOrderNumber);
      if (!primaryRow || !counterpartRow) throw new CoordinatorError('NOT_FOUND', 'Order pair not found');
      const primary = this.mapOrder(primaryRow);
      const counterpart = this.mapOrder(counterpartRow);
      if (primary.status !== 'pending_match' || counterpart.status !== 'pending_match') {
        throw new CoordinatorError('INVALID_STATE', 'Both orders must be open for matching');
      }
      if (primary.roundId !== counterpart.roundId) {
        throw new CoordinatorError('INVALID_STATE', 'Orders from different rounds cannot be paired');
      }
      if (primary.side === counterpart.side) {
        throw new CoordinatorError('INVALID_STATE', 'Orders must have opposite sides');
      }
      if (primary.stakeHundredths !== counterpart.stakeHundredths) {
        throw new CoordinatorError('STAKE_MISMATCH', 'Order stakes must be equal');
      }
      if (primary.creatorId === counterpart.creatorId) {
        throw new CoordinatorError('INVALID_STATE', 'The same player cannot be paired with themselves');
      }
      const round = this.roundRow(primary.roundId);
      if (!round || round.status !== 'active') {
        throw new CoordinatorError('INVALID_STATE', 'Order round is not active');
      }
      const matcher = this.requireActivePlayer(counterpart.creatorId).account;
      const now = Date.now();
      const primaryPayload = JSON.parse(primaryRow.order_json) as Record<string, unknown>;
      primaryPayload.matcherId = counterpart.creatorId;
      primaryPayload.matcherName = counterpart.creatorName;
      primaryPayload.matchedAt = now;
      this.state.storage.sql.exec(
        `UPDATE orders
         SET matcher_id = ?, status = 'matched', order_json = ?, updated_at = ?
         WHERE order_number = ?`,
        counterpart.creatorId,
        JSON.stringify(primaryPayload),
        now,
        primary.orderNumber,
      );

      const counterpartPayload = JSON.parse(counterpartRow.order_json) as Record<string, unknown>;
      counterpartPayload.matchedIntoOrder = primary.orderNumber;
      this.state.storage.sql.exec(
        `UPDATE orders SET status = 'cancelled', order_json = ?, updated_at = ? WHERE order_number = ?`,
        JSON.stringify(counterpartPayload),
        now,
        counterpart.orderNumber,
      );
      this.addLedgerEntry({
        accountId: counterpart.creatorId,
        idempotencyKey: `autoMatchOrders:${input.idempotencyKey}`,
        deltaHundredths: 0,
        balanceAfterHundredths: matcher.balanceHundredths,
        eventType: 'order_matched',
        referenceId: primary.orderNumber,
        actorId: counterpart.creatorId,
        reason: 'Existing held stake assigned to paired order',
      });
      const updated = this.orderRow(primary.orderNumber);
      if (!updated) throw new CoordinatorError('INTERNAL', 'Auto-matched order could not be loaded');
      return this.mapOrder(updated);
    });
  }

  private cancelOrder(rawInput: CancelOrderInput): LedgerOrder {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.orderNumber = validateIdentifier(input.orderNumber, 'orderNumber');
    input.actorId = validateIdentifier(input.actorId, 'actorId');

    return this.replayOrBegin('cancelOrder', input.idempotencyKey, input, () => {
      const row = this.orderRow(input.orderNumber);
      if (!row) throw new CoordinatorError('NOT_FOUND', 'Order not found');
      const order = this.mapOrder(row);
      if (order.status !== 'pending_hold' && order.status !== 'pending_match') {
        throw new CoordinatorError('INVALID_STATE', 'Only pending orders can be cancelled');
      }
      if (input.actorId !== 'admin' && order.creatorId !== input.actorId && order.matcherId !== input.actorId) {
        throw new CoordinatorError('UNAUTHORIZED', 'Only the order creator or matcher can cancel');
      }
      const creator = this.accountRow(order.creatorId);
      if (!creator) throw new CoordinatorError('NOT_FOUND', 'Order creator account not found');
      const nextBalance = creator.balance_hundredths + order.stakeHundredths;
      const now = Date.now();
      this.state.storage.sql.exec(
        'UPDATE accounts SET balance_hundredths = ?, updated_at = ? WHERE player_id = ?',
        nextBalance,
        now,
        order.creatorId,
      );
      this.addLedgerEntry({
        accountId: order.creatorId,
        idempotencyKey: `cancelOrder:${input.idempotencyKey}`,
        deltaHundredths: order.stakeHundredths,
        balanceAfterHundredths: nextBalance,
        eventType: 'order_cancelled',
        referenceId: input.orderNumber,
        actorId: input.actorId,
        reason: 'Order cancelled',
      });

      const payload = JSON.parse(row.order_json) as Record<string, unknown>;
      payload.winnerSide = null;
      payload.finalSeconds = null;
      payload.settledAt = null;
      this.state.storage.sql.exec(
        `UPDATE orders SET status = 'cancelled', order_json = ?, updated_at = ? WHERE order_number = ?`,
        JSON.stringify(payload),
        now,
        input.orderNumber,
      );
      const updated = this.orderRow(input.orderNumber);
      if (!updated) throw new CoordinatorError('INTERNAL', 'Cancelled order could not be loaded');
      return this.mapOrder(updated);
    });
  }

  private releaseQuote(rawInput: ReleaseQuoteInput): RoundReleaseResult {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.roundId = validateIdentifier(input.roundId, 'roundId');
    if (
      !Number.isSafeInteger(input.targetMin) ||
      !Number.isSafeInteger(input.targetMax) ||
      input.targetMin < 0 ||
      input.targetMin >= input.targetMax
    ) {
      throw new CoordinatorError('INVALID_INPUT', 'Quote bounds must be increasing nonnegative whole seconds');
    }

    return this.replayOrBegin('releaseQuote', input.idempotencyKey, input, () => {
      const round = this.roundRow(input.roundId);
      if (!round) throw new CoordinatorError('NOT_FOUND', 'Round not found');
      if (round.status !== 'active') throw new CoordinatorError('INVALID_STATE', 'Round is not active');
      if (round.quote_released === 1) throw new CoordinatorError('INVALID_STATE', 'Quote has already been released');

      const now = Date.now();
      this.state.storage.sql.exec(
        `UPDATE rounds SET quote_released = 1, target_min = ?, target_max = ?, updated_at = ? WHERE round_id = ?`,
        input.targetMin,
        input.targetMax,
        now,
        input.roundId,
      );

      const releasedOrderNumbers: string[] = [];
      const rows = this.state.storage.sql
        .exec<OrderRow>(`SELECT * FROM orders WHERE round_id = ? AND status = 'pending_hold'`, input.roundId)
        .toArray();
      for (const row of rows) {
        const payload = JSON.parse(row.order_json) as Record<string, unknown>;
        if (payload.betType !== 'pre_quote') continue;
        const order = this.mapOrder(row);
        payload.betType = 'range';
        payload.rangeMin = input.targetMin + order.rangeOffset;
        payload.rangeMax = input.targetMax + order.rangeOffset;
        this.state.storage.sql.exec(
          `UPDATE orders SET status = 'pending_match', order_json = ?, updated_at = ? WHERE order_number = ?`,
          JSON.stringify(payload),
          now,
          row.order_number,
        );
        releasedOrderNumbers.push(row.order_number);
      }

      const updatedRound = this.roundRow(input.roundId);
      if (!updatedRound) throw new CoordinatorError('INTERNAL', 'Updated round could not be loaded');
      return { round: this.mapRound(updatedRound), releasedOrderNumbers };
    });
  }

  private closeRound(rawInput: CloseRoundInput): RoundCloseResult {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.roundId = validateIdentifier(input.roundId, 'roundId');

    return this.replayOrBegin('closeRound', input.idempotencyKey, input, () => {
      const round = this.roundRow(input.roundId);
      if (!round) throw new CoordinatorError('NOT_FOUND', 'Round not found');
      if (round.status !== 'active') throw new CoordinatorError('INVALID_STATE', 'Round is not active');

      const now = Date.now();
      const cancelled: string[] = [];
      const rows = this.state.storage.sql
        .exec<OrderRow>('SELECT * FROM orders WHERE round_id = ? ORDER BY created_at', input.roundId)
        .toArray();

      for (const row of rows) {
        const order = this.mapOrder(row);
        if (order.status === 'matched' && order.betType === 'custom_range') continue;
        if (order.status !== 'pending_hold' && order.status !== 'pending_match') continue;

        const creator = this.accountRow(order.creatorId);
        if (!creator) continue;
        const nextBalance = creator.balance_hundredths + order.stakeHundredths;
        this.state.storage.sql.exec(
          'UPDATE accounts SET balance_hundredths = ?, updated_at = ? WHERE player_id = ?',
          nextBalance,
          now,
          order.creatorId,
        );
        this.addLedgerEntry({
          accountId: order.creatorId,
          idempotencyKey: `closeRound:${input.idempotencyKey}:${order.orderNumber}`,
          deltaHundredths: order.stakeHundredths,
          balanceAfterHundredths: nextBalance,
          eventType: 'order_cancelled',
          referenceId: order.orderNumber,
          actorId: order.creatorId,
          reason: 'Round closed',
        });

        const payload = JSON.parse(row.order_json) as Record<string, unknown>;
        payload.winnerSide = null;
        payload.finalSeconds = null;
        payload.settledAt = null;
        this.state.storage.sql.exec(
          `UPDATE orders SET status = 'cancelled', order_json = ?, updated_at = ? WHERE order_number = ?`,
          JSON.stringify(payload),
          now,
          order.orderNumber,
        );
        cancelled.push(order.orderNumber);
      }

      this.state.storage.sql.exec(
        `UPDATE rounds SET status = 'closed', updated_at = ? WHERE round_id = ?`,
        now,
        input.roundId,
      );
      const updatedRound = this.roundRow(input.roundId);
      if (!updatedRound) throw new CoordinatorError('INTERNAL', 'Updated round could not be loaded');
      return { round: this.mapRound(updatedRound), cancelledOrderNumbers: cancelled };
    });
  }

  private voidRound(rawInput: VoidRoundInput): RoundVoidResult {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.roundId = validateIdentifier(input.roundId, 'roundId');

    return this.replayOrBegin('voidRound', input.idempotencyKey, input, () => {
      const round = this.roundRow(input.roundId);
      if (!round) throw new CoordinatorError('NOT_FOUND', 'Round not found');
      if (round.status === 'void') {
        throw new CoordinatorError('INVALID_STATE', 'Round cannot be voided');
      }
      const settledOrders = this.state.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM orders WHERE round_id = ? AND status = 'settled'`,
          input.roundId,
        )
        .toArray()[0]?.count ?? 0;
      if (settledOrders > 0) {
        throw new CoordinatorError('INVALID_STATE', 'A settled round cannot be voided');
      }

      const now = Date.now();
      const refunded: string[] = [];
      const rows = this.state.storage.sql
        .exec<OrderRow>('SELECT * FROM orders WHERE round_id = ? ORDER BY created_at', input.roundId)
        .toArray();
      for (const row of rows) {
        const order = this.mapOrder(row);
        if (order.status !== 'pending_hold' && order.status !== 'pending_match' && order.status !== 'matched') continue;

        const payload = JSON.parse(row.order_json) as Record<string, unknown>;
        payload.winnerSide = null;
        payload.finalSeconds = null;
        payload.settledAt = null;

        let refundTargets = [order.creatorId];
        if (order.status === 'matched') {
          if (!order.matcherId) {
            throw new CoordinatorError('INVALID_STATE', 'Matched order is missing its matcher');
          }
          refundTargets = [order.creatorId, order.matcherId];
        }

        for (const accountId of refundTargets) {
          const account = this.accountRow(accountId);
          if (!account) throw new CoordinatorError('NOT_FOUND', 'Voided order participant account not found');
          const nextBalance = account.balance_hundredths + order.stakeHundredths;
          if (!Number.isSafeInteger(nextBalance)) {
            throw new CoordinatorError('INTERNAL', 'Void refund exceeds the supported balance range');
          }
          this.state.storage.sql.exec(
            'UPDATE accounts SET balance_hundredths = ?, updated_at = ? WHERE player_id = ?',
            nextBalance,
            now,
            accountId,
          );
          this.addLedgerEntry({
            accountId,
            idempotencyKey: `voidRound:${input.idempotencyKey}:${order.orderNumber}:${accountId}`,
            deltaHundredths: order.stakeHundredths,
            balanceAfterHundredths: nextBalance,
            eventType: 'order_cancelled',
            referenceId: order.orderNumber,
            actorId: accountId,
            reason: 'Round voided',
          });
        }

        this.state.storage.sql.exec(
          `UPDATE orders SET status = 'cancelled', order_json = ?, updated_at = ? WHERE order_number = ?`,
          JSON.stringify(payload),
          now,
          order.orderNumber,
        );
        refunded.push(order.orderNumber);
      }

      this.state.storage.sql.exec(
        `UPDATE rounds SET status = 'void', updated_at = ? WHERE round_id = ?`,
        now,
        input.roundId,
      );
      const updatedRound = this.roundRow(input.roundId);
      if (!updatedRound) throw new CoordinatorError('INTERNAL', 'Updated round could not be loaded');
      return { round: this.mapRound(updatedRound), refundedOrderNumbers: refunded };
    });
  }

  private resolveRound(rawInput: ResolveRoundInput): RoundSettlementResult {
    const input = this.validateIdempotentInput({ ...rawInput });
    input.roundId = validateIdentifier(input.roundId, 'roundId');
    input.finalSeconds = validateFinalSeconds(input.finalSeconds);

    return this.replayOrBegin('resolveRound', input.idempotencyKey, input, () => {
      const round = this.roundRow(input.roundId);
      if (!round) throw new CoordinatorError('NOT_FOUND', 'Round not found');
      if (round.status !== 'active' && round.status !== 'closed') {
        throw new CoordinatorError('INVALID_STATE', 'Round is not settleable');
      }

      const rows = this.state.storage.sql
        .exec<OrderRow>(`SELECT * FROM orders WHERE round_id = ? AND status = 'matched'`, input.roundId)
        .toArray();
      const results: RoundSettlementResult['orders'] = [];
      const now = Date.now();

      for (const row of rows) {
        const order = this.mapOrder(row);
        const decisiveValue = input.finalSeconds < order.rangeMin
          ? 'low'
          : input.finalSeconds > order.rangeMax
            ? 'high'
            : 'draw';
        const payout = decisiveValue === 'draw'
          ? { winnerCreditHundredths: 0, houseFeeHundredths: 0 }
          : calculateWinPayout(order.stakeHundredths);
        const winnerSide = decisiveValue === 'draw' ? 'draw' : order.side === decisiveValue ? 'creator' : 'matcher';

        const payload = JSON.parse(row.order_json) as Record<string, unknown>;
        payload.winnerSide = decisiveValue;
        payload.finalSeconds = input.finalSeconds;
        payload.settledAt = now;

        if (decisiveValue === 'draw') {
          const refundTargets = [order.creatorId, order.matcherId].filter((value): value is string => !!value);
          for (const accountId of refundTargets) {
            const account = this.accountRow(accountId);
            if (!account) throw new CoordinatorError('NOT_FOUND', 'Settled order participant account not found');
            const nextBalance = account.balance_hundredths + order.stakeHundredths;
            this.state.storage.sql.exec(
              'UPDATE accounts SET balance_hundredths = ?, updated_at = ? WHERE player_id = ?',
              nextBalance,
              now,
              accountId,
            );
            this.addLedgerEntry({
              accountId,
              idempotencyKey: `resolveRound:draw:${input.idempotencyKey}:${order.orderNumber}:${accountId}`,
              deltaHundredths: order.stakeHundredths,
              balanceAfterHundredths: nextBalance,
              eventType: 'order_settled',
              referenceId: order.orderNumber,
              actorId: accountId,
              reason: 'Draw refund',
            });
          }
        } else {
          const winnerAccountId = winnerSide === 'creator' ? order.creatorId : order.matcherId;
          if (!winnerAccountId) throw new CoordinatorError('INVALID_STATE', 'Matched order missing a winner account');
          const winnerAccount = this.accountRow(winnerAccountId);
          if (!winnerAccount) throw new CoordinatorError('NOT_FOUND', 'Matched order winner account not found');
          const nextWinnerBalance = winnerAccount.balance_hundredths + payout.winnerCreditHundredths;
          this.state.storage.sql.exec(
            'UPDATE accounts SET balance_hundredths = ?, updated_at = ? WHERE player_id = ?',
            nextWinnerBalance,
            now,
            winnerAccountId,
          );
          this.addLedgerEntry({
            accountId: winnerAccountId,
            idempotencyKey: `resolveRound:${input.idempotencyKey}:${order.orderNumber}:${winnerAccountId}`,
            deltaHundredths: payout.winnerCreditHundredths,
            balanceAfterHundredths: nextWinnerBalance,
            eventType: 'order_settled',
            referenceId: order.orderNumber,
            actorId: winnerAccountId,
            reason: 'Order settled',
          });
          if (payout.houseFeeHundredths > 0) {
            const house = this.accountRow(HOUSE_ACCOUNT_ID);
            if (!house) throw new CoordinatorError('NOT_FOUND', 'House account not found');
            const nextHouseBalance = house.balance_hundredths + payout.houseFeeHundredths;
            this.state.storage.sql.exec(
              'UPDATE accounts SET balance_hundredths = ?, updated_at = ? WHERE player_id = ?',
              nextHouseBalance,
              now,
              HOUSE_ACCOUNT_ID,
            );
            this.addLedgerEntry({
              accountId: HOUSE_ACCOUNT_ID,
              idempotencyKey: `resolveRound:house:${input.idempotencyKey}:${order.orderNumber}`,
              deltaHundredths: payout.houseFeeHundredths,
              balanceAfterHundredths: nextHouseBalance,
              eventType: 'house_fee',
              referenceId: order.orderNumber,
              actorId: HOUSE_ACCOUNT_ID,
              reason: 'House fee',
            });
          }
        }

        this.state.storage.sql.exec(
          `UPDATE orders SET status = 'settled', order_json = ?, updated_at = ? WHERE order_number = ?`,
          JSON.stringify(payload),
          now,
          order.orderNumber,
        );

        const balances: Record<string, number> = {};
        const creatorAfter = this.accountRow(order.creatorId);
        if (creatorAfter) balances[order.creatorId] = creatorAfter.balance_hundredths;
        if (order.matcherId) {
          const matcherAfter = this.accountRow(order.matcherId);
          if (matcherAfter) balances[order.matcherId] = matcherAfter.balance_hundredths;
        }
        const houseAfter = this.accountRow(HOUSE_ACCOUNT_ID);
        if (houseAfter) balances[HOUSE_ACCOUNT_ID] = houseAfter.balance_hundredths;

        results.push({
          orderNumber: order.orderNumber,
          status: 'settled',
          winnerSide: decisiveValue,
          winnerCreditHundredths: decisiveValue === 'draw' ? 0 : payout.winnerCreditHundredths,
          houseFeeHundredths: decisiveValue === 'draw' ? 0 : payout.houseFeeHundredths,
          balances,
        });
      }

      this.state.storage.sql.exec(
        `UPDATE rounds SET status = 'closed', updated_at = ? WHERE round_id = ?`,
        now,
        input.roundId,
      );
      const updatedRound = this.roundRow(input.roundId);
      if (!updatedRound) throw new CoordinatorError('INTERNAL', 'Round could not be loaded after settlement');
      return { round: this.mapRound(updatedRound), orders: results };
    });
  }
}
