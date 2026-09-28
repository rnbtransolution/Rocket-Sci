// ── Environment Bindings & KV ──
export interface Env {
  KV_CACHE: KVNamespace;
  KV_ORDERS: KVNamespace;
  LINE_EVENTS_QUEUE?: Queue<QueueMessage>;
  FINANCIAL_COORDINATOR: DurableObjectNamespace;
  
  // Secrets
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_SESSION_SECRET?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  PROJECTION_API_KEY?: string;

  // Configuration vars
  ENVIRONMENT?: string;
  SPREADSHEET_ID?: string;
  GAS_FALLBACK_URL?: string;
  GAS_PROJECTION_URL?: string;
  SLIP_API_KEY?: string;
  SLIP_API_URL?: string;
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
  /** Stable LINE webhook event identifier when supplied by the platform */
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
  side: 'low' | 'high'; // 'low' = ล/ถ/ต่ำ, 'high' = ชล/สูง
  amount: number;
  betType: 'range' | 'custom_range' | 'pre_quote';
  rangeMin: number;
  rangeMax: number;
  status: 'pending_match' | 'pending_hold' | 'matched' | 'cancelled' | 'resolved' | 'settled' | 'void';
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
  roundId: string;
  name: string;
  targetMin: number;
  targetMax: number;
  status: 'ACTIVE' | 'CLOSED' | 'VOID';
  isChotoy: boolean;
  quoteReleased: boolean;
  updatedAt: number;
}
