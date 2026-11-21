"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  bumpAuthGeneration,
  fetchAgentProfile,
  fetchCapabilities,
  fetchDemoPersonas,
  fetchMe,
  fetchProfile,
  getAuthGeneration,
  isApiError,
  isStaleAuthError,
  loginWithDemoPersona,
  logoutSession,
  onAuthReset,
  revokeAllObjectUrls,
  type AuthResetReason,
} from "@/lib/api-client";
import type {
  Actor,
  AgentProfile,
  Capabilities,
  DemoPersonaId,
  DemoPersonasResponse,
  Profile,
} from "@/lib/types";

export type SessionStatus = "loading" | "authenticated" | "unauthenticated";

export interface SessionContextValue {
  status: SessionStatus;
  actor: Actor | null;
  capabilities: Capabilities | null;
  profile: Profile | null;
  agentProfile: AgentProfile | null;
  demoConfig: DemoPersonasResponse | null;
  avatarVersion: number;
  agentAvatarVersion: number;
  authGeneration: number;
  accessChangedBanner: string | null;
  switchingPersona: boolean;
  // Capability convenience selectors
  canAccessAdminOps: boolean;
  canManagePeople: boolean;
  canCreateOrder: boolean;
  hasAssuranceAccess: boolean;
  // Actions
  refreshSession: () => Promise<Actor | null>;
  refreshCapabilities: () => Promise<Capabilities | null>;
  refreshProfiles: () => Promise<void>;
  updateProfileState: (next: Profile) => void;
  updateAgentProfileState: (next: AgentProfile) => void;
  bumpAvatarVersion: () => void;
  bumpAgentAvatarVersion: () => void;
  loginAsDemo: (persona: DemoPersonaId) => Promise<Actor | null>;
  switchDemoPersona: (persona: DemoPersonaId) => Promise<Actor | null>;
  logout: () => Promise<void>;
  handleAccessChanged: () => Promise<void>;
  dismissAccessChangedBanner: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [actor, setActor] = useState<Actor | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [agentProfile, setAgentProfile] = useState<AgentProfile | null>(null);
  const [demoConfig, setDemoConfig] = useState<DemoPersonasResponse | null>(
    null,
  );
  const [avatarVersion, setAvatarVersion] = useState(1);
  const [agentAvatarVersion, setAgentAvatarVersion] = useState(1);
  const [generation, setGeneration] = useState(() => getAuthGeneration());
  const [accessChangedBanner, setAccessChangedBanner] = useState<string | null>(
    null,
  );
  const [switchingPersona, setSwitchingPersona] = useState(false);

  const isSwitchingRef = useRef(false);

  const clearInMemoryIdentity = useCallback(() => {
    setActor(null);
    setCapabilities(null);
    setProfile(null);
    setAgentProfile(null);
    setAccessChangedBanner(null);
    revokeAllObjectUrls();
  }, []);

  const loadAuthenticatedBundle = useCallback(
    async (suppressAuthReset = true): Promise<Actor | null> => {
      const startGen = getAuthGeneration();
      try {
        const me = await fetchMe({ suppressAuthReset });
        if (startGen !== getAuthGeneration()) return null;

        const [capsRes, profRes, agentProfRes] = await Promise.allSettled([
          fetchCapabilities({ suppressAuthReset }),
          fetchProfile({ suppressAuthReset }),
          fetchAgentProfile({ suppressAuthReset }),
        ]);

        if (startGen !== getAuthGeneration()) return null;

        setActor(me);
        if (capsRes.status === "fulfilled") setCapabilities(capsRes.value);
        if (profRes.status === "fulfilled") setProfile(profRes.value);
        if (agentProfRes.status === "fulfilled") {
          setAgentProfile(agentProfRes.value);
        }
        setAvatarVersion((v) => v + 1);
        setAgentAvatarVersion((v) => v + 1);
        setStatus("authenticated");
        return me;
      } catch (error) {
        if (isStaleAuthError(error) || startGen !== getAuthGeneration()) {
          return null;
        }
        if (
          isApiError(error) &&
          (error.status === 401 || error.code === "SUSPENDED")
        ) {
          clearInMemoryIdentity();
          setStatus("unauthenticated");
          return null;
        }
        clearInMemoryIdentity();
        setStatus("unauthenticated");
        return null;
      }
    },
    [clearInMemoryIdentity],
  );

  useEffect(() => {
    const unsub = onAuthReset((reason: AuthResetReason, nextGen: number) => {
      setGeneration(nextGen);
      clearInMemoryIdentity();
      if (reason !== "persona_switch" && !isSwitchingRef.current) {
        setStatus("unauthenticated");
      }
    });
    return unsub;
  }, [clearInMemoryIdentity]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await fetchDemoPersonas();
        if (!cancelled) setDemoConfig(cfg);
      } catch {
        // Non-fatal: login page falls back gracefully
      }
      if (!cancelled) {
        await loadAuthenticatedBundle(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAuthenticatedBundle]);

  const refreshSession = useCallback(async () => {
    return loadAuthenticatedBundle(false);
  }, [loadAuthenticatedBundle]);

  const refreshCapabilities = useCallback(async () => {
    const startGen = getAuthGeneration();
    try {
      const [me, caps] = await Promise.all([fetchMe(), fetchCapabilities()]);
      if (startGen !== getAuthGeneration()) return null;
      setActor(me);
      setCapabilities(caps);
      return caps;
    } catch (error) {
      if (isStaleAuthError(error)) return null;
      throw error;
    }
  }, []);

  const refreshProfiles = useCallback(async () => {
    const startGen = getAuthGeneration();
    try {
      const [prof, agentProf] = await Promise.all([
        fetchProfile(),
        fetchAgentProfile(),
      ]);
      if (startGen !== getAuthGeneration()) return;
      setProfile(prof);
      setAgentProfile(agentProf);
      setAvatarVersion((v) => v + 1);
      setAgentAvatarVersion((v) => v + 1);
    } catch (error) {
      if (isStaleAuthError(error)) return;
      throw error;
    }
  }, []);

  const updateProfileState = useCallback((next: Profile) => {
    setProfile(next);
    setAvatarVersion((v) => v + 1);
  }, []);

  const updateAgentProfileState = useCallback((next: AgentProfile) => {
    setAgentProfile(next);
    setAgentAvatarVersion((v) => v + 1);
  }, []);

  const bumpAvatarVersion = useCallback(() => {
    setAvatarVersion((v) => v + 1);
  }, []);

  const bumpAgentAvatarVersion = useCallback(() => {
    setAgentAvatarVersion((v) => v + 1);
  }, []);

  const loginAsDemo = useCallback(
    async (persona: DemoPersonaId): Promise<Actor | null> => {
      isSwitchingRef.current = true;
      setSwitchingPersona(true);
      try {
        bumpAuthGeneration("persona_switch");
        await loginWithDemoPersona(persona);
        const me = await loadAuthenticatedBundle(true);
        return me;
      } finally {
        isSwitchingRef.current = false;
        setSwitchingPersona(false);
      }
    },
    [loadAuthenticatedBundle],
  );

  const switchDemoPersona = useCallback(
    async (persona: DemoPersonaId): Promise<Actor | null> => {
      isSwitchingRef.current = true;
      setSwitchingPersona(true);
      try {
        // Best-effort end prior session, then hard purge all in-memory state
        try {
          await logoutSession();
        } catch {
          bumpAuthGeneration("persona_switch");
        }
        bumpAuthGeneration("persona_switch");
        await loginWithDemoPersona(persona);
        const me = await loadAuthenticatedBundle(true);
        return me;
      } finally {
        isSwitchingRef.current = false;
        setSwitchingPersona(false);
      }
    },
    [loadAuthenticatedBundle],
  );

  const logout = useCallback(async () => {
    await logoutSession();
    setStatus("unauthenticated");
  }, []);

  const handleAccessChanged = useCallback(async () => {
    setAccessChangedBanner("访问权限已变更，界面能力已同步刷新。");
    await refreshCapabilities().catch(() => null);
  }, [refreshCapabilities]);

  const dismissAccessChangedBanner = useCallback(() => {
    setAccessChangedBanner(null);
  }, []);

  const canAccessAdminOps = useMemo(() => {
    if (!actor) return false;
    return (
      (actor.role === "manager" || actor.role === "admin") &&
      actor.grants.includes("operations.manage")
    );
  }, [actor]);

  const canManagePeople = useMemo(() => {
    if (!actor) return false;
    return (
      actor.role === "admin" && actor.grants.includes("workbench.access.manage")
    );
  }, [actor]);

  const canCreateOrder = useMemo(() => {
    if (!capabilities) return false;
    return capabilities.tools.some(
      (t) =>
        t.id === "order.draft.prepare" &&
        t.available &&
        t.warehouses.length > 0,
    );
  }, [capabilities]);

  const hasAssuranceAccess = useMemo(() => {
    if (!actor) return false;
    return (
      actor.grants.includes("assurance.purchase") ||
      actor.grants.includes("assurance.incoming") ||
      actor.grants.includes("assurance.contract")
    );
  }, [actor]);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      actor,
      capabilities,
      profile,
      agentProfile,
      demoConfig,
      avatarVersion,
      agentAvatarVersion,
      authGeneration: generation,
      accessChangedBanner,
      switchingPersona,
      canAccessAdminOps,
      canManagePeople,
      canCreateOrder,
      hasAssuranceAccess,
      refreshSession,
      refreshCapabilities,
      refreshProfiles,
      updateProfileState,
      updateAgentProfileState,
      bumpAvatarVersion,
      bumpAgentAvatarVersion,
      loginAsDemo,
      switchDemoPersona,
      logout,
      handleAccessChanged,
      dismissAccessChangedBanner,
    }),
    [
      status,
      actor,
      capabilities,
      profile,
      agentProfile,
      demoConfig,
      avatarVersion,
      agentAvatarVersion,
      generation,
      accessChangedBanner,
      switchingPersona,
      canAccessAdminOps,
      canManagePeople,
      canCreateOrder,
      hasAssuranceAccess,
      refreshSession,
      refreshCapabilities,
      refreshProfiles,
      updateProfileState,
      updateAgentProfileState,
      bumpAvatarVersion,
      bumpAgentAvatarVersion,
      loginAsDemo,
      switchDemoPersona,
      logout,
      handleAccessChanged,
      dismissAccessChangedBanner,
    ],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return ctx;
}
