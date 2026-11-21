import {
  getAuthGeneration,
  onAuthReset,
  type ApiError,
} from "@/lib/api-client";
import type {
  BriefResponse,
  TurnResult,
  ZoomBookingConfirmResponse,
  ZoomBookingPreviewResponse,
} from "@/lib/types";

export interface AssistantZoomBookingState {
  phase: "parsing" | "preview" | "confirmed" | "error";
  preview?: ZoomBookingPreviewResponse;
  confirmed?: ZoomBookingConfirmResponse;
  errorMessage?: string | null;
}

export interface AssistantTurnEntry {
  id: string;
  clientId: string;
  userText: string;
  createdAt: number;
  status: "pending" | "done" | "error";
  waitingRetryAfter?: number | null;
  result?: TurnResult;
  brief?: BriefResponse;
  zoomBooking?: AssistantZoomBookingState;
  error?: ApiError;
  sourceKind: "turn" | "tool_call" | "zoom_booking" | "brief_card";
}

export interface ExpandedHistoryRecord {
  loading: boolean;
  result?: TurnResult;
  error?: ApiError;
  verifiedAt?: number;
}

interface AssistantMemoryState {
  generation: number;
  turns: AssistantTurnEntry[];
  expandedHistory: Record<string, ExpandedHistoryRecord>;
}

// Strictly in-memory session state (NEVER localStorage/sessionStorage).
// Purged immediately on any authGeneration bump (401 / logout / persona switch / suspension).
let memoryState: AssistantMemoryState = {
  generation: getAuthGeneration(),
  turns: [],
  expandedHistory: {},
};

const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // ignore subscriber failure
    }
  }
}

onAuthReset((_reason, nextGen) => {
  memoryState = {
    generation: nextGen,
    turns: [],
    expandedHistory: {},
  };
  notify();
});

export function getAssistantMemory(expectedGeneration: number): {
  turns: AssistantTurnEntry[];
  expandedHistory: Record<string, ExpandedHistoryRecord>;
} {
  if (memoryState.generation !== expectedGeneration) {
    memoryState = {
      generation: expectedGeneration,
      turns: [],
      expandedHistory: {},
    };
  }
  return {
    turns: memoryState.turns,
    expandedHistory: memoryState.expandedHistory,
  };
}

export function setAssistantTurns(
  expectedGeneration: number,
  updater: (prev: AssistantTurnEntry[]) => AssistantTurnEntry[],
): void {
  if (expectedGeneration !== getAuthGeneration()) return;
  if (memoryState.generation !== expectedGeneration) {
    memoryState = {
      generation: expectedGeneration,
      turns: [],
      expandedHistory: {},
    };
  }
  memoryState = {
    ...memoryState,
    turns: updater(memoryState.turns),
  };
  notify();
}

export function setAssistantExpandedHistory(
  expectedGeneration: number,
  updater: (
    prev: Record<string, ExpandedHistoryRecord>,
  ) => Record<string, ExpandedHistoryRecord>,
): void {
  if (expectedGeneration !== getAuthGeneration()) return;
  if (memoryState.generation !== expectedGeneration) {
    memoryState = {
      generation: expectedGeneration,
      turns: [],
      expandedHistory: {},
    };
  }
  memoryState = {
    ...memoryState,
    expandedHistory: updater(memoryState.expandedHistory),
  };
  notify();
}

export function clearAssistantMemory(expectedGeneration: number): void {
  memoryState = {
    generation: expectedGeneration,
    turns: [],
    expandedHistory: {},
  };
  notify();
}

export function subscribeAssistantMemory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
