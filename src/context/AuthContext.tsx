import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { auth, googleAuthProvider } from '../lib/firebase.ts';

export interface AppUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  isDemo?: boolean;
}

interface StoredDemoSession {
  token: string;
  expiresAt: string;
  user: AppUser;
}

const DEMO_STORAGE_KEY = 'driftguard_demo_session_v1';

function readStoredDemoSession(): StoredDemoSession | null {
  try {
    const raw = sessionStorage.getItem(DEMO_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDemoSession;
    if (
      !parsed?.token ||
      !parsed?.expiresAt ||
      new Date(parsed.expiresAt).getTime() <= Date.now()
    ) {
      sessionStorage.removeItem(DEMO_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

interface AuthContextValue {
  user: AppUser | null;
  loading: boolean;
  demoLoading: boolean;
  authError: string | null;
  signInWithGoogle: () => Promise<void>;
  signInAsDemo: () => Promise<void>;
  signOut: () => Promise<void>;
  getIdToken: () => Promise<string>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [demoSession, setDemoSession] = useState<StoredDemoSession | null>(() =>
    typeof window !== 'undefined' ? readStoredDemoSession() : null
  );
  const [loading, setLoading] = useState(true);
  const [demoLoading, setDemoLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (fbUser) => {
      setFirebaseUser(fbUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setAuthError(null);
    try {
      sessionStorage.removeItem(DEMO_STORAGE_KEY);
      setDemoSession(null);
      await signInWithPopup(auth, googleAuthProvider);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to complete Google sign-in.';
      setAuthError(message);
    }
  }, []);

  const signInAsDemo = useCallback(async () => {
    setAuthError(null);
    setDemoLoading(true);
    try {
      const res = await fetch('/api/auth/demo-session', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token || !data.user) {
        throw new Error(
          typeof data.error === 'string'
            ? data.error
            : 'Unable to start demo workspace.'
        );
      }
      const nextSession: StoredDemoSession = {
        token: data.token,
        expiresAt: data.expiresAt,
        user: {
          uid: data.user.uid,
          email: data.user.email,
          displayName: data.user.displayName,
          isDemo: true,
        },
      };
      sessionStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(nextSession));
      setDemoSession(nextSession);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to start demo workspace.';
      setAuthError(message);
    } finally {
      setDemoLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setAuthError(null);
    sessionStorage.removeItem(DEMO_STORAGE_KEY);
    setDemoSession(null);
    if (auth.currentUser) {
      await firebaseSignOut(auth);
    }
  }, []);

  const getIdToken = useCallback(async () => {
    if (auth.currentUser) {
      return auth.currentUser.getIdToken();
    }
    const stored = demoSession ?? readStoredDemoSession();
    if (stored) {
      return stored.token;
    }
    throw new Error('Authentication session expired. Please sign in again.');
  }, [demoSession]);

  const user: AppUser | null = firebaseUser
    ? {
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        displayName: firebaseUser.displayName,
        isDemo: false,
      }
    : demoSession?.user ?? null;

  return (
    <AuthContext.Provider
      value={{
        user,
        loading: loading && !demoSession,
        demoLoading,
        authError,
        signInWithGoogle,
        signInAsDemo,
        signOut,
        getIdToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
