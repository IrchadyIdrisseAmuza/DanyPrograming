# MILION.SPACE — Security Specification (Hardened Production Model)

## 1. Single Source of Truth & Zero Secret Leakage
1. **Authoritative Financial Ledger**: All wallet balances (`available_balance`, `locked_balance`, `pending_balance`, `reserved_balance`), M-Pesa deposits, M-Pesa withdrawals, market operations, and `wallet_ledger` entries are mutated exclusively on the Node.js backend inside ACID SQLite transactions (`milion.db`). Client-side Firestore SDK **cannot** credit, debit, approve, reject, or settle any financial record (`allow create/update/delete: if false` on `/deposits`, `/withdrawals`, `/operations`, `/ledger`, `/audit_logs`, and `allow update/delete: if false` on `/wallets`).
2. **No Plaintext Verification/Recovery Codes in Firestore**: Verification and password recovery tokens live strictly on the backend (`auth_email_tokens` in SQLite, SHA-256 hashed, single-use, rate-limited, and never exposed to Firestore).
3. **Identity Integrity**: Every document under `/users/{userId}`, `/users/{userId}/private/{docId}`, `/wallets/{userId}`, `/deposits/{depositId}`, `/withdrawals/{withdrawalId}`, `/operations/{operationId}`, `/ledger/{entryId}`, `/notifications/{notificationId}`, and `/support_tickets/{ticketId}` binds `uid` strictly to `request.auth.uid`.
4. **No Self-Assigned Roles or Verification Bypass**: On `/users/{userId}` creation, non-admins can only create `role == 'USER'` and `status == 'ACTIVE'` when `request.auth.token.email_verified == true`. Only bootstrapped or registered verified admins can modify `role`, `status`, or `/admins/{adminId}`.
5. **Immutable Phone & Email Isolation (PII)**: `email` and `phone` live exclusively in `/users/{userId}/private/{docId}` and are readable only by the document owner or verified admin. Once created, non-admins cannot alter `phone` or `email`.
6. **Master Gate on Private Subcollection**: `/users/{userId}/private/{docId}` verifies the parent `/users/{userId}` document exists via `exists()`.
7. **Zero Client Balance Mutations**: `/wallets/{userId}` allows initial creation by the owner strictly with zeroed balances (`0, 0, 0, 0`), and denies all client `update` and `delete` operations (`if false`).
8. **Secure List Queries**: `allow list` on user-owned collections strictly enforces `resource.data.uid == request.auth.uid || isBootstrappedAdmin()` with zero `get()` or `exists()` lookups.

## 2. Adversarial Security Test Matrix (The "Dirty Dozen" + Financial Lockout)
1. **DD-01 Identity Spoofing**: Create `/users/victim_uid` with `uid: 'victim_uid'` while signed in as `attacker_uid` -> `PERMISSION_DENIED`.
2. **DD-02 Email Spoofing (`email_verified == false`)**: Token `{ email: 'danysavio15@gmail.com', email_verified: false }` attempts admin/user read -> `PERMISSION_DENIED`.
3. **DD-03 Role Self-Escalation**: Create `/users/attacker_uid` with `role: 'SUPER_ADMIN'` -> `PERMISSION_DENIED`.
4. **DD-04 Shadow/Ghost Field Injection**: Create `/users/attacker_uid` with extra `isAdminBypass: true` field -> `PERMISSION_DENIED`.
5. **DD-05 Missing Required Field**: Create `/wallets/attacker_uid` omitting `reservedBalance` -> `PERMISSION_DENIED`.
6. **DD-06 Resource Poisoning (Oversized ID/String)**: Access or write `/support_tickets/${'a'.repeat(500)}` -> `PERMISSION_DENIED`.
7. **DD-07 Phone Number Mutation**: Update `/users/user_uid/private/profile` changing `phone` as owner -> `PERMISSION_DENIED`.
8. **DD-08 Client Wallet Balance Tampering**: Update `/wallets/user_uid` setting `availableBalance: 99999` -> `PERMISSION_DENIED` (`allow update: if false`).
9. **DD-09 Client Deposit Approval Forgery**: Create or update `/deposits/dep1` with `status: 'CREDITED'` -> `PERMISSION_DENIED` (`allow create, update, delete: if false`).
10. **DD-10 Cross-User PII Read**: Authenticated `userA` attempts `get` on `/users/userB/private/profile` -> `PERMISSION_DENIED`.
11. **DD-11 Unscoped List Scraping**: Authenticated `userA` runs unbounded collection query on `/operations` or `/deposits` or `/withdrawals` without `where('uid', '==', userA.uid)` -> `PERMISSION_DENIED`.
12. **DD-12 Client Timestamp Forgery**: Create `/users/attacker_uid` or `/support_tickets/t1` with backdated `createdAt` instead of `request.time` -> `PERMISSION_DENIED`.
13. **DD-13 Client Withdrawal Approval / Audit Log Forgery**: Client attempts to approve `/withdrawals/w1` or delete `/audit_logs/l1` -> `PERMISSION_DENIED`.
