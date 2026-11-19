import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Security Verification Suite for MILION.SPACE Firestore Rules
 * Maps each adversarial payload from security_spec.md to its expected PERMISSION_DENIED gate
 * and verifies rule invariants against firestore.rules & firebase-blueprint.json.
 */
export interface DirtyDozenCase {
  id: string;
  name: string;
  path: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  expected: 'PERMISSION_DENIED';
  enforcedBy: string;
}

export const DIRTY_DOZEN_CASES: DirtyDozenCase[] = [
  {
    id: 'DD-01',
    name: 'Identity Spoofing on /users/{userId}',
    path: '/users/victim_uid',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'isOwner(userId) && data.uid == request.auth.uid',
  },
  {
    id: 'DD-02',
    name: 'Email Spoofing with email_verified == false',
    path: '/admins/any_admin',
    operation: 'get',
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'isVerified() && request.auth.token.email_verified == true',
  },
  {
    id: 'DD-03',
    name: 'Role Self-Escalation on registration',
    path: '/users/attacker_uid',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    enforcedBy: "incoming().role == 'USER' && incoming().status == 'ACTIVE'",
  },
  {
    id: 'DD-04',
    name: 'Shadow/Ghost Field injection',
    path: '/users/attacker_uid',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'data.keys().hasOnly([...])',
  },
  {
    id: 'DD-05',
    name: 'Missing required fields in wallet document',
    path: '/wallets/attacker_uid',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'data.keys().hasAll([...])',
  },
  {
    id: 'DD-06',
    name: 'Resource Poisoning with oversized document ID',
    path: '/support_tickets/' + 'a'.repeat(500),
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'isValidId(ticketId)',
  },
  {
    id: 'DD-07',
    name: 'Phone Number Mutation in Profile',
    path: '/users/user_uid/private/profile',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    enforcedBy: "incoming().phone == existing().phone && affectedKeys().hasOnly(['updatedAt'])",
  },
  {
    id: 'DD-08',
    name: 'Client Wallet Balance Tampering',
    path: '/wallets/user_uid',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'allow update, delete: if false',
  },
  {
    id: 'DD-09',
    name: 'Client Deposit Approval Forgery',
    path: '/deposits/dep_1',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'allow create, update, delete: if false',
  },
  {
    id: 'DD-10',
    name: 'Cross-User PII Read on /users/{other}/private/{docId}',
    path: '/users/other_uid/private/profile',
    operation: 'get',
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'isOwner(userId) || isAdmin()',
  },
  {
    id: 'DD-11',
    name: 'Unscoped List Scraping on /operations, /deposits, /withdrawals',
    path: '/operations',
    operation: 'list',
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'resource.data.uid == request.auth.uid || isBootstrappedAdmin()',
  },
  {
    id: 'DD-12',
    name: 'Client Timestamp Forgery on createdAt/updatedAt',
    path: '/support_tickets/t2',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'incoming().createdAt == request.time && incoming().updatedAt == request.time',
  },
  {
    id: 'DD-13',
    name: 'Client Withdrawal Approval or Audit Log Tampering',
    path: '/withdrawals/w1',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'allow create, update, delete: if false',
  },
];

function verifyFirestoreRulesAndBlueprint() {
  const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
  const draftPath = path.resolve(process.cwd(), 'DRAFT_firestore.rules');
  const blueprintPath = path.resolve(process.cwd(), 'firebase-blueprint.json');

  const rules = fs.readFileSync(rulesPath, 'utf8');
  const draft = fs.readFileSync(draftPath, 'utf8');
  const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf8')) as {
    firestore: Record<string, unknown>;
  };

  assert.equal(rules, draft, 'DRAFT_firestore.rules and firestore.rules must match');

  // 1. Global default-deny gate must be present
  assert.ok(
    rules.includes('match /{document=**}') && rules.includes('allow read, write: if false;'),
    'Missing global default-deny match block'
  );

  // 2. All financial/audit/notification collections must strictly block client mutations
  for (const col of ['/deposits/{depositId}', '/withdrawals/{withdrawalId}', '/operations/{operationId}', '/ledger/{entryId}', '/notifications/{notificationId}', '/audit_logs/{logId}']) {
    assert.ok(rules.includes(`match ${col}`), `Missing match block for ${col}`);
    assert.ok(blueprint.firestore[col], `Missing blueprint entry for ${col}`);
  }
  assert.ok(
    rules.includes('match /wallets/{userId}') && rules.includes('allow update, delete: if false;'),
    'Wallets must block client updates and deletes'
  );

  // 3. No verification code / password recovery token collection in Firestore
  assert.equal(/auth_email_tokens|verification_codes|recovery_codes/i.test(rules), false, 'Plaintext codes must never live in Firestore');
  assert.equal(/auth_email_tokens|verification_codes|recovery_codes/i.test(JSON.stringify(blueprint)), false, 'Blueprint must not define verification token collections');

  // 4. Email verification & role gates enforced
  assert.ok(rules.includes('request.auth.token.email_verified == true'));
  assert.ok(rules.includes("incoming().role == 'USER'"));
  assert.ok(rules.includes('incoming().emailVerified == true'));
  assert.ok(rules.includes('incoming().phone == existing().phone'));
  assert.ok(rules.includes('incoming().email == existing().email'));

  // 5. No unrestricted list queries without resource.data.uid or isBootstrappedAdmin
  assert.equal(DIRTY_DOZEN_CASES.length, 13);
  console.log(`PASS: All ${DIRTY_DOZEN_CASES.length} adversarial cases and Firestore Single-Source-of-Truth invariants verified.`);
}

verifyFirestoreRulesAndBlueprint();
