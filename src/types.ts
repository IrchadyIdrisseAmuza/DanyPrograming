export type UserRole = 'USER' | 'ADMIN' | 'SUPER_ADMIN';
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'PENDING_VERIFICATION';

export interface User {
  id: string;
  public_code: string;
  full_name: string;
  username: string;
  phone: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  email_verified?: boolean;
  created_at: string;
}

export interface Wallet {
  user_id: string;
  available_balance: number;
  locked_balance: number;
  pending_balance: number;
  reserved_balance: number;
  total_balance: number;
  exchange_rate: number;
  updated_at: string;
}

export interface LedgerEntry {
  id: string;
  reference: string;
  user_id: string;
  type: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  description: string;
  created_at: string;
  public_code?: string;
  email?: string;
}

export type DepositStatus =
  | 'CREATED'
  | 'PAYMENT_PENDING'
  | 'PAID'
  | 'CREDITED'
  | 'FAILED'
  | 'EXPIRED'
  | 'UNKNOWN'
  | 'RECONCILIATION_REQUIRED'
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED';

export type WithdrawalStatus =
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'DISBURSEMENT_PENDING'
  | 'PAID'
  | 'REJECTED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'RECONCILIATION_REQUIRED'
  | 'PENDING'
  | 'CANCELLED';

export interface DepositRequest {
  id: string;
  reference: string;
  user_id: string;
  method: string;
  provider?: string;
  msisdn?: string | null;
  msisdn_masked?: string | null;
  provider_reference?: string | null;
  mpesa_transaction_id?: string | null;
  mpesa_conversation_id?: string | null;
  mpesa_response_code?: string | null;
  mpesa_response_desc?: string | null;
  amount_usd: number;
  amount_mt: number;
  exchange_rate_used: number;
  status: DepositStatus;
  notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  confirmed_at?: string | null;
  credited_at?: string | null;
  created_at: string;
  full_name?: string;
  email?: string;
  public_code?: string;
}

export interface WithdrawalRequest {
  id: string;
  reference: string;
  user_id: string;
  destination_type: string;
  destination_account: string;
  provider?: string;
  msisdn?: string | null;
  msisdn_masked?: string | null;
  mpesa_transaction_id?: string | null;
  mpesa_conversation_id?: string | null;
  mpesa_response_code?: string | null;
  mpesa_response_desc?: string | null;
  amount_usd: number;
  amount_mt: number;
  exchange_rate_used: number;
  status: WithdrawalStatus;
  disbursement_status?: string | null;
  risk_score?: number;
  risk_flags?: string[];
  notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  paid_at?: string | null;
  created_at: string;
  full_name?: string;
  email?: string;
  public_code?: string;
}

export interface ReconciliationRecord {
  id: string;
  entity_type: 'DEPOSIT' | 'WITHDRAWAL';
  entity_id: string;
  reference: string;
  reason: string;
  status: 'OPEN' | 'RESOLVED_CONFIRMED' | 'RESOLVED_FAILED';
  resolution_notes: string | null;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface MarketSession {
  id: string;
  session_number: number;
  regime: 'ABERTURA' | 'EXPANSÃO' | 'CONSOLIDAÇÃO' | 'FECHO';
  drift: number;
  volatility: number;
  seed_hash: string;
  open_price: number;
  close_price: number | null;
  started_at: string;
  ends_at: string;
  status: 'ACTIVE' | 'CLOSED';
}

export interface MarketTick {
  id: number;
  session_id: string;
  price: number;
  delta: number;
  delta_pct: number;
  timestamp: string;
}

export interface OrderBookLevel {
  price: number;
  size_usd: number;
  total_usd: number;
}

export interface MarketTapeItem {
  id: string;
  side: 'SUBIDA' | 'DESCIDA';
  price: number;
  amount_usd: number;
  timestamp: string;
}

export interface GlobalMarketSnapshot {
  index_name: string;
  methodology: string;
  current_price: number;
  previous_price: number;
  open_24h_price: number;
  high_24h: number;
  low_24h: number;
  volume_24h_usd: number;
  change_24h_pct: number;
  movement: 'SUBIDA' | 'DESCIDA' | 'NEUTRO';
  session: MarketSession;
  global_market_value: number;
  global_market_delta_pct: number;
  active_investors: number;
  total_active_operations: number;
  capital_in_operations_usd: number;
  sentiment_up_pct: number;
  sentiment_down_pct: number;
  market_paused: boolean;
  market_control_mode?: 'AUTO' | 'FORCE_UP' | 'FORCE_DOWN' | 'HOUSE_WIN';
  usd_to_mt_rate: number;
  proportional_multiplier: number;
  max_gain_pct: number;
  max_duration_days: number;
  recent_ticks: MarketTick[];
  order_book?: {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
  };
  recent_tape?: MarketTapeItem[];
}

export interface Operation {
  id: string;
  reference: string;
  user_id: string;
  idempotency_key: string;
  direction: 'SUBIDA' | 'DESCIDA';
  amount_usd: number;
  duration_seconds: number;
  entry_price: number;
  exit_price: number | null;
  result_amount_usd: number | null;
  payout_amount_usd: number | null;
  return_pct: number | null;
  status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'REJECTED';
  termination_reason?: 'ZEROED_OUT' | 'ZEROED_AT_EXPIRY' | 'EXPIRED' | 'ADMIN_CANCELLED' | null;
  opened_at: string;
  expires_at: string;
  settled_at: string | null;
  rule_snapshot: string;
  floating_pnl_usd?: number;
  floating_return_pct?: number;
  floating_value_usd?: number;
  current_price?: number;
  remaining_seconds?: number;
  full_name?: string;
  email?: string;
  public_code?: string;
}

export interface NotificationItem {
  id: string;
  user_id: string | null;
  title: string;
  message: string;
  type: string;
  is_read: number;
  created_at: string;
}

export interface SupportMessage {
  id: string;
  ticket_id: string;
  sender_id: string;
  sender_role: string;
  sender_email: string;
  body: string;
  created_at: string;
}

export interface SupportTicket {
  id: string;
  reference: string;
  user_id: string;
  subject: string;
  category: string;
  message: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
  admin_reply: string | null;
  replied_by: string | null;
  created_at: string;
  updated_at: string;
  full_name?: string;
  email?: string;
  public_code?: string;
  messages?: SupportMessage[];
}

export interface AdminPayout {
  id: string;
  reference: string;
  admin_id: string;
  admin_email: string;
  recipient_name: string | null;
  msisdn_masked: string;
  amount_usd: number;
  amount_mt: number;
  fee_pct: number;
  fee_usd: number;
  total_deducted_usd: number;
  exchange_rate_used: number;
  status: 'PROCESSING' | 'PAID' | 'FAILED' | 'RECONCILIATION_REQUIRED';
  provider: string;
  provider_payout_id: string | null;
  provider_transaction_id: string | null;
  response_code: string | null;
  response_desc: string | null;
  notes: string | null;
  created_at: string;
  paid_at: string | null;
}

export interface AppProfitSummary {
  completed_ops_count: number;
  gross_user_losses_usd: number;
  gross_user_wins_usd: number;
  net_ops_profit_usd: number;
  zeroed_profit_usd: number;
  zeroed_ops_count: number;
  winning_ops_count: number;
  total_deposited_usd: number;
  deposit_fee_pct: number;
  deposit_fees_usd: number;
  total_user_withdrawn_usd: number;
  withdrawal_fee_pct: number;
  user_withdrawal_fees_usd: number;
  admin_withdrawn_usd: number;
  admin_payout_fees_usd: number;
  pending_admin_payouts_usd: number;
  total_fees_deducted_usd: number;
  net_app_profit_usd: number;
  available_admin_payout_usd: number;
  max_withdrawable_before_fee_usd: number;
  exchange_rate_usd_mt: number;
  provider_fee_owner?: 'ZaasTec';
}

export interface AuditLog {
  id: string;
  actor_id: string | null;
  actor_email: string;
  actor_role: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details_json: string;
  created_at: string;
}

export interface PlatformSettings {
  usd_to_mt_rate: number;
  min_deposit_usd: number;
  min_withdrawal_usd: number;
  proportional_multiplier: number;
  max_gain_pct: number;
  max_duration_days: number;
  market_base_volatility: number;
  market_paused: boolean;
  session_duration_minutes: number;
  market_control_mode?: 'AUTO' | 'FORCE_UP' | 'FORCE_DOWN' | 'HOUSE_WIN';
}
