import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserSessionPersistence,
  getAuth,
  GoogleAuthProvider,
  inMemoryPersistence,
  setPersistence,
  signInWithPopup,
  signOut,
  type User as FirebaseUser,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import type { User, Wallet } from './types';

const app = initializeApp(firebaseConfig);
const configuredDatabaseId = firebaseConfig.firestoreDatabaseId?.trim();
export const db =
  configuredDatabaseId && configuredDatabaseId !== '(default)'
    ? getFirestore(app, configuredDatabaseId)
    : getFirestore(app);
export const auth = getAuth(app);

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({
  prompt: 'select_account',
});

let persistencePromise: Promise<void> | null = null;

function ensureAuthPersistence(): Promise<void> {
  if (!persistencePromise) {
    persistencePromise = (async () => {
      for (const persistence of [
        browserLocalPersistence,
        browserSessionPersistence,
        inMemoryPersistence,
      ]) {
        try {
          await setPersistence(auth, persistence);
          return;
        } catch {
          // Try next persistence fallback (e.g. restricted iframe/private mode)
        }
      }
    })();
  }
  return persistencePromise;
}

void ensureAuthPersistence();

export function formatFirebaseAuthError(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : '';
  const message = error instanceof Error ? error.message : String(error || '');

  if (code === 'auth/unauthorized-domain' || message.includes('auth/unauthorized-domain')) {
    const currentHost = typeof window !== 'undefined' ? window.location.hostname : 'domínio atual';
    return `O domínio "${currentHost}" ainda não está autorizado no projeto Firebase (${firebaseConfig.projectId}). Adicione "${currentHost}" em Authentication → Settings → Authorized domains na Firebase Console.`;
  }
  if (code === 'auth/popup-blocked' || message.includes('auth/popup-blocked')) {
    return 'A janela de autenticação Google foi bloqueada pelo navegador. Permita popups para este site e tente novamente.';
  }
  if (
    code === 'auth/popup-closed-by-user' ||
    code === 'auth/cancelled-popup-request' ||
    message.includes('auth/popup-closed-by-user')
  ) {
    return 'A janela de autenticação Google foi fechada antes de concluir o acesso.';
  }
  if (code === 'auth/operation-not-allowed' || message.includes('auth/operation-not-allowed')) {
    return `O provedor Google não está ativado no projeto Firebase (${firebaseConfig.projectId}). Ative-o em Authentication → Sign-in method.`;
  }
  if (code === 'auth/network-request-failed' || message.includes('auth/network-request-failed')) {
    return 'Falha de ligação durante a autenticação Google. Verifique a sua internet e tente novamente.';
  }
  if (code === 'auth/user-disabled' || message.includes('auth/user-disabled')) {
    return 'Esta conta Google encontra-se desativada na Firebase Authentication.';
  }
  return error instanceof Error && error.message
    ? error.message
    : 'Erro ao autenticar com o Google.';
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

testConnection();

export async function signInWithGooglePopup(): Promise<{
  firebaseUser: FirebaseUser;
  idToken: string;
}> {
  await ensureAuthPersistence();
  const credential = await signInWithPopup(auth, googleProvider);
  const idToken = await credential.user.getIdToken();
  return { firebaseUser: credential.user, idToken };
}

export async function signOutFirebase(): Promise<void> {
  if (auth.currentUser) {
    await signOut(auth);
  }
}

/**
 * Synchronizes the authenticated Google/Firebase account metadata with Firestore
 * using strict blueprint validation (single source of truth for balances stays on backend SQLite).
 */
export async function syncUserAccountToFirestore(
  fbUser: FirebaseUser,
  appUser: User,
  _wallet: Wallet | null
): Promise<void> {
  if (!fbUser.emailVerified || !fbUser.email) return;
  const uid = fbUser.uid;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(uid)) return;

  const publicCode = /^MIL-[0-9]{6}$/.test(appUser.public_code)
    ? appUser.public_code
    : 'MIL-000000';
  const rawName = (appUser.full_name || fbUser.displayName || 'Utilizador MILION').trim();
  const displayName = rawName.length >= 3 ? rawName.slice(0, 120) : 'Utilizador MILION';
  const email = fbUser.email.trim().toLowerCase().slice(0, 120);
  const rawPhone = (appUser.phone || 'Conta Google').trim();
  const phone = rawPhone.length >= 7 ? rawPhone.slice(0, 32) : 'Conta Google';

  const desiredRole =
    appUser.role === 'SUPER_ADMIN' || appUser.role === 'ADMIN' ? appUser.role : 'USER';

  const userPath = `users/${uid}`;
  try {
    const userRef = doc(db, 'users', uid);
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      await setDoc(userRef, {
        uid,
        publicCode,
        displayName,
        role: desiredRole,
        status: appUser.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE',
        emailVerified: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      const existingData = snap.data();
      const needsNameUpdate = existingData?.displayName !== displayName;
      const needsRoleUpgrade =
        desiredRole !== 'USER' && existingData?.role !== desiredRole;
      if ((needsNameUpdate || needsRoleUpgrade) && typeof existingData?.emailVerified === 'boolean') {
        await setDoc(
          userRef,
          {
            displayName,
            ...(needsRoleUpgrade ? { role: desiredRole } : {}),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }

  if (
    (desiredRole === 'ADMIN' || desiredRole === 'SUPER_ADMIN') &&
    /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)
  ) {
    const adminPath = `admins/${uid}`;
    try {
      const adminRef = doc(db, 'admins', uid);
      const adminSnap = await getDoc(adminRef);
      if (!adminSnap.exists()) {
        await setDoc(adminRef, {
          uid,
          email,
          role: desiredRole,
          createdAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, adminPath);
    }
  }

  if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) {
    const privatePath = `users/${uid}/private/profile`;
    try {
      const privRef = doc(db, 'users', uid, 'private', 'profile');
      const privSnap = await getDoc(privRef);
      if (!privSnap.exists()) {
        await setDoc(privRef, {
          uid,
          email,
          phone,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, privatePath);
    }
  }

  const walletPath = `wallets/${uid}`;
  try {
    const walletRef = doc(db, 'wallets', uid);
    const walletSnap = await getDoc(walletRef);
    if (!walletSnap.exists()) {
      await setDoc(walletRef, {
        uid,
        availableBalance: 0,
        lockedBalance: 0,
        pendingBalance: 0,
        reservedBalance: 0,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, walletPath);
  }
}
