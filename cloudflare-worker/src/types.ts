// ── Environment Bindings & KV ──
export interface Env {
  /** Strongly-consistent authoritative state store (single global instance) */
  ROCKET_STATE: DurableObjectNamespace;
  KV_CACHE: KVNamespace;   // legacy cold mirror / migration fallback
  KV_ORDERS: KVNamespace;   // immutable per-order records (KV_ORDERS is write-once, read-later)
  LINE_EVENTS_QUEUE?: Queue<QueueMessage>;
  
  // Secrets
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;

  /** Server-to-server admin secret. NEVER sent to the browser. */
  ADMIN_API_KEY: string;
  /** Limited-admin server-to-server secret (optional — Wrangler secret). */
  ADMIN1_API_KEY?: string;

  /**
   * HMAC key used to sign admin session tokens. Deliberately independent of
   * ADMIN_API_KEY so the two can be rotated separately.
   */
  SESSION_SECRET: string;

  /** Console login passwords. Distinct from the API keys above. */
  ADMIN_PASSWORD?: string;
  ADMIN_PASSWORD_1?: string;

  ADMIN_USERNAME?: string;        // Super Admin username override (optional)
  ADMIN1_USERNAME?: string;       // Limited Admin username override (optional)
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;

  // Configuration vars
  ENVIRONMENT?: string;
  SPREADSHEET_ID?: string;
  GAS_FALLBACK_URL?: string;
  SLIP_API_KEY?: string;
  SLIP_API_URL?: string;
  ADMIN_LINE_USER_IDS?: string;
}

// ── Queue Message Structure ──
export interface QueueMessage {
  id: string;
  receivedAt: number;
  event: LineEvent;
}

// ── LINE Messaging API Types ──
export interface LineWebhookPayload {
  destination?: string;
  events: LineEvent[];
}

export interface LineSource {
  type: 'user' | 'group' | 'room';
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export interface LineEvent {
  type: 'message' | 'postback' | 'unsend' | 'join' | 'leave' | 'follow' | 'unfollow' | 'messageEdited';
  mode?: 'active' | 'standby';
  timestamp: number;
  source: LineSource;
  replyToken?: string;
  /** UUID injected by the webhook for end-to-end dedup between inline + queue paths */
  webhookEventId?: string;
  message?: LineMessage;
  postback?: LinePostback;
  unsend?: {
    messageId: string;
  };
}

export interface LineMessage {
  id: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'location' | 'sticker';
  text?: string;
}

export interface LinePostback {
  data: string;
  params?: Record<string, string>;
}

// ── Application Domain Models ──
export interface Order {
  orderNumber: string;
  creatorId: string;
  creatorName: string;
  creatorLineUserId?: string;
  matcherId?: string | null;
  matcherName?: string | null;
  matcherLineUserId?: string | null;
  side: 'low' | 'high'; // 'low' = ล/ถ/ต่ำ, 'high' = ชล/สูง
  amount: number;
  betType: 'range' | 'custom_range' | 'pre_quote';
  rangeMin?: number;
  rangeMax?: number;
  status: 'pending_match' | 'pending_hold' | 'matched' | 'matched_paired' | 'cancelled' | 'resolved' | 'settled' | 'void' | 'PRE_CHARGE' | 'refunding';
  groupId?: string | null;
  userTypedCmd?: string | null;
  rocketName?: string | null;
  offset?: number;
  createdAt: number;
  matchedAt?: number | null;
  winnerSide?: 'low' | 'high' | 'draw';
  winnerName?: string | null;
  finalTime?: number | null;
  settledAt?: number;
  id?: string;
  playerLowId?: string | null;
  playerLowName?: string | null;
  playerHighId?: string | null;
  playerHighName?: string | null;
  timestamp?: string;
  /**
   * Set when this order is the unfilled remainder of a partially matched order.
   * The matched portion keeps the original number and settles on its own; this
   * is a separate, still-open order for the balance, so it must carry a
   * distinct orderNumber — ORDER_<n> is a KV key and both order lists dedupe
   * on it, so reusing the parent's number would silently drop the remainder.
   */
  parentOrderNumber?: string | null;
  /**
   * Set when the admin's quote assigns a real range to a pre-quote order that
   * was already matched. Before this the order held only `offset` and had no
   * range at all, so it could never be settled.
   */
  offsetConfirmedAt?: number;
  /** The loser's stake on a settled order — what the winner won gross. */
  grossWinAmount?: number;
  /**
   * Platform rake withheld at settlement: 10% of `grossWinAmount`.
   * Zero on a draw, where both stakes are returned in full.
   */
  commission?: number;
  /**
   * Total credited to the winner at settlement: their own stake back plus
   * `grossWinAmount` less `commission` — i.e. 1.9x for a decisive result.
   */
  payout?: number;
}

export interface PlayerProfile {
  shortId: string;
  lineUserId: string;
  displayName: string;
  balance: number;
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  registeredAt: number;
  updatedAt: number;
}

export interface Transaction {
  id: string;
  playerId: string;
  lineUserId?: string;
  playerName: string;
  requestedAmount: number;
  actualAmount: number;
  slipRef?: string;
  status: 'pending' | 'success' | 'escalated' | 'rejected';
  reviewReason?: string;
  timestamp: string;
  type: 'deposit' | 'withdraw' | 'transfer';
  createdAt: number;
}

export interface RocketRound {
  name: string;
  targetMin: number;
  targetMax: number;
  status: 'ACTIVE' | 'CLOSED' | 'RESOLVED' | 'VOID';
  isChotoy: boolean;
  quoteReleased: boolean;
  updatedAt: number;
}
