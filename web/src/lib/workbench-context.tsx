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
import { onAuthReset } from "@/lib/api-client";
import type { DrawerObjectSelection, DrawerTab } from "@/lib/types";

export type CustomDrawerRenderer = (args: {
  selectedObject: DrawerObjectSelection | null;
  activeTab: DrawerTab;
  closeDrawer: () => void;
}) => React.ReactNode;

export interface WorkbenchContextValue {
  drawerOpen: boolean;
  activeTab: DrawerTab;
  selectedObject: DrawerObjectSelection | null;
  assignedCount: number;
  unreadNoticesCount: number;
  customDrawerContent: React.ReactNode | null;
  // Drawer controls
  openDrawer: (
    selection?: DrawerObjectSelection | null,
    options?: { tab?: DrawerTab; trigger?: HTMLElement | null },
  ) => void;
  closeDrawer: (options?: { restoreFocus?: boolean }) => void;
  toggleDrawer: (trigger?: HTMLElement | null) => void;
  setActiveTab: (tab: DrawerTab) => void;
  selectObject: (selection: DrawerObjectSelection | null) => void;
  clearSelectedObject: () => void;
  setCustomDrawerContent: (node: React.ReactNode | null) => void;
  // In-memory chat draft preservation (purged automatically on auth reset)
  getDraft: (key: string) => string;
  setDraft: (key: string, value: string) => void;
  clearDraft: (key: string) => void;
  // Badge counters
  setAssignedCount: (count: number) => void;
  setUnreadNoticesCount: (count: number) => void;
  // Focus restoration hook
  rememberFocusTrigger: (el: HTMLElement | null) => void;
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

export function WorkbenchProvider({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<DrawerTab>("current");
  const [selectedObject, setSelectedObject] =
    useState<DrawerObjectSelection | null>(null);
  const [assignedCount, setAssignedCount] = useState(0);
  const [unreadNoticesCount, setUnreadNoticesCount] = useState(0);
  const [customDrawerContent, setCustomDrawerContent] =
    useState<React.ReactNode | null>(null);

  // Stored strictly in memory; cleared on 401 / logout / persona switch
  const draftsRef = useRef<Map<string, string>>(new Map());
  const lastTriggerRef = useRef<HTMLElement | null>(null);

  const rememberFocusTrigger = useCallback((el: HTMLElement | null) => {
    if (el) {
      lastTriggerRef.current = el;
    }
  }, []);

  const restoreFocusToTrigger = useCallback(() => {
    requestAnimationFrame(() => {
      const target = lastTriggerRef.current;
      if (target && document.contains(target)) {
        target.focus({ preventScroll: true });
        return;
      }
      const composer = document.querySelector<HTMLElement>(
        "[data-composer-input]",
      );
      if (composer) {
        composer.focus({ preventScroll: true });
      }
    });
  }, []);

  const openDrawer = useCallback(
    (
      selection?: DrawerObjectSelection | null,
      options?: { tab?: DrawerTab; trigger?: HTMLElement | null },
    ) => {
      if (options?.trigger) {
        lastTriggerRef.current = options.trigger;
      } else if (
        typeof document !== "undefined" &&
        document.activeElement instanceof HTMLElement
      ) {
        lastTriggerRef.current = document.activeElement;
      }
      if (selection !== undefined) {
        setSelectedObject(selection);
      }
      if (options?.tab) {
        setActiveTab(options.tab);
      } else if (selection) {
        setActiveTab("current");
      }
      setDrawerOpen(true);
    },
    [],
  );

  const closeDrawer = useCallback(
    (options?: { restoreFocus?: boolean }) => {
      setDrawerOpen(false);
      if (options?.restoreFocus !== false) {
        restoreFocusToTrigger();
      }
    },
    [restoreFocusToTrigger],
  );

  const toggleDrawer = useCallback(
    (trigger?: HTMLElement | null) => {
      setDrawerOpen((prev) => {
        if (!prev) {
          if (trigger) {
            lastTriggerRef.current = trigger;
          } else if (
            typeof document !== "undefined" &&
            document.activeElement instanceof HTMLElement
          ) {
            lastTriggerRef.current = document.activeElement;
          }
          return true;
        }
        restoreFocusToTrigger();
        return false;
      });
    },
    [restoreFocusToTrigger],
  );

  const clearSelectedObject = useCallback(() => {
    setSelectedObject(null);
  }, []);

  const getDraft = useCallback((key: string): string => {
    return draftsRef.current.get(key) ?? "";
  }, []);

  const setDraft = useCallback((key: string, value: string) => {
    if (!value) {
      draftsRef.current.delete(key);
    } else {
      draftsRef.current.set(key, value);
    }
  }, []);

  const clearDraft = useCallback((key: string) => {
    draftsRef.current.delete(key);
  }, []);

  // Purge ALL transient workbench state on 401, logout, or persona switch
  useEffect(() => {
    return onAuthReset(() => {
      draftsRef.current.clear();
      lastTriggerRef.current = null;
      setDrawerOpen(false);
      setSelectedObject(null);
      setCustomDrawerContent(null);
      setAssignedCount(0);
      setUnreadNoticesCount(0);
      setActiveTab("current");
    });
  }, []);

  // Keyboard shortcuts: Mod+. toggles right drawer; Escape closes drawer when no modal/dialog is open
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ".") {
        event.preventDefault();
        toggleDrawer();
        return;
      }
      if (event.key === "Escape" && drawerOpen) {
        // Yield Escape to any open Radix Dialog / AlertDialog / Popover / Menu
        const hasOpenOverlay = document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]',
        );
        if (!hasOpenOverlay) {
          event.preventDefault();
          closeDrawer({ restoreFocus: true });
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen, toggleDrawer, closeDrawer]);

  const value = useMemo<WorkbenchContextValue>(
    () => ({
      drawerOpen,
      activeTab,
      selectedObject,
      assignedCount,
      unreadNoticesCount,
      customDrawerContent,
      openDrawer,
      closeDrawer,
      toggleDrawer,
      setActiveTab,
      selectObject: setSelectedObject,
      clearSelectedObject,
      setCustomDrawerContent,
      getDraft,
      setDraft,
      clearDraft,
      setAssignedCount,
      setUnreadNoticesCount,
      rememberFocusTrigger,
    }),
    [
      drawerOpen,
      activeTab,
      selectedObject,
      assignedCount,
      unreadNoticesCount,
      customDrawerContent,
      openDrawer,
      closeDrawer,
      toggleDrawer,
      clearSelectedObject,
      getDraft,
      setDraft,
      clearDraft,
      rememberFocusTrigger,
    ],
  );

  return (
    <WorkbenchContext.Provider value={value}>
      {children}
    </WorkbenchContext.Provider>
  );
}

export function useWorkbench(): WorkbenchContextValue {
  const ctx = useContext(WorkbenchContext);
  if (!ctx) {
    throw new Error("useWorkbench must be used within a WorkbenchProvider");
  }
  return ctx;
}
