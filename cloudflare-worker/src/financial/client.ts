import type { Env } from '../types';
import {
  CoordinatorError,
  type CoordinatorClient,
  type CoordinatorErrorCode,
  type ProjectionDrainResult,
} from './types';

interface CoordinatorResponse<T> {
  result?: T;
  error?: {
    code?: CoordinatorErrorCode;
    message?: string;
  };
}

export function createCoordinatorClient(env: Env): CoordinatorClient {
  const stub = env.FINANCIAL_COORDINATOR.get(
    env.FINANCIAL_COORDINATOR.idFromName('financial-coordinator'),
  );

  async function send<T>(operation: string, input?: unknown): Promise<T> {
    const response = await stub.fetch('https://financial-coordinator.internal/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation, input }),
    });
    let body: CoordinatorResponse<T>;
    try {
      body = (await response.json()) as CoordinatorResponse<T>;
    } catch {
      throw new CoordinatorError('INTERNAL', 'Coordinator returned an invalid response');
    }

    if (!response.ok) {
      const code = body.error?.code;
      const allowedCodes: CoordinatorErrorCode[] = [
        'AUTHORITY_NOT_READY',
        'INSUFFICIENT_FUNDS',
        'INVALID_STATE',
        'STAKE_MISMATCH',
        'NOT_FOUND',
        'DUPLICATE_ID',
        'INVALID_INPUT',
        'UNAUTHORIZED',
        'IMPORT_CONFLICT',
        'INTERNAL',
      ];
      throw new CoordinatorError(
        code && allowedCodes.includes(code) ? code : 'INTERNAL',
        body.error?.message || 'Coordinator request failed',
      );
    }

    return body.result as T;
  }

  return {
    getAccount: (playerId) => send('getAccount', { playerId }),
    getAccountByLineUserId: (lineUserId) => send('getAccountByLineUserId', { lineUserId }),
    getAccounts: (playerIds) => send('getAccounts', { playerIds }),
    getLedgerEntries: (playerId) => send('getLedgerEntries', { playerId }),
    getSnapshot: () => send('getSnapshot'),
    getOrder: (orderNumber) => send('getOrder', { orderNumber }),
    getOrdersByStatus: (statuses) => send('getOrdersByStatus', { statuses }),
    drainProjections: () => send<ProjectionDrainResult>('drainProjections'),
    createPlayer: (input) => send('createPlayer', input),
    adjustBalance: (input) => send('adjustBalance', input),
    deactivatePlayer: (input) => send('deactivatePlayer', input),
    requestWithdrawal: (input) => send('requestWithdrawal', input),
    requestDeposit: (input) => send('requestDeposit', input),
    reviewTransaction: (input) => send('reviewTransaction', input),
    openRound: (input) => send('openRound', input),
    createOrder: (input) => send('createOrder', input),
    matchOrder: (input) => send('matchOrder', input),
    autoMatchOrders: (input) => send('autoMatchOrders', input),
    cancelOrder: (input) => send('cancelOrder', input),
    releaseQuote: (input) => send('releaseQuote', input),
    closeRound: (input) => send('closeRound', input),
    voidRound: (input) => send('voidRound', input),
    resolveRound: (input) => send('resolveRound', input),
    previewImport: (input) => send('previewImport', input),
    importSnapshot: (input) => send('importSnapshot', input),
    activateAuthority: (input) => send('activateAuthority', input),
  };
}
