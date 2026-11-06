import { create } from "zustand";
import { persist } from "zustand/middleware";
import { globalJsonStorage } from "@/lib/globalSettings";
import { invoke } from "@tauri-apps/api/core";
import { isRemotePath, remotePath } from "@/lib/remote";

export interface TerminalProfile {
  id: string;
  name: string;
  command: string;
}

export interface SessionInfo {
  remoteId?: string;
  id: string;
  name: string;
  command: string;
  cwd: string | null;
  isPinned?: boolean;
}

interface TerminalState {
  profiles: TerminalProfile[];
  defaultProfileId: string;
  saveProfiles: (profiles: TerminalProfile[], defaultProfileId: string) => void;
  sessions: SessionInfo[];
  activeSessionId: string;
  launchError: string;
  clearLaunchError: () => void;
  createSession: (profile: TerminalProfile, cwd: string | null) => Promise<boolean>;
  removeSession: (id: string) => void;
  setActiveSessionId: (id: string) => void;
  reorderSessions: (oldIndex: number, newIndex: number) => void;
  toggleSessionPin: (id: string) => void;
}

export const useTerminalStore = create<TerminalState>()(persist(
  (set) => ({
    profiles: [
      { id: "shell", name: "终端", command: "" },
      { id: "codex", name: "Codex", command: "codex" },
    ],
    defaultProfileId: "shell",
    saveProfiles: (profiles, defaultProfileId) => set({ profiles, defaultProfileId }),
    sessions: [],
    activeSessionId: "",
    launchError: "",
    clearLaunchError: () => set({ launchError: "" }),
    createSession: async (profile, cwd) => {
      const sessionName = profile.id === "shell" && profile.name === "Terminal" ? "终端" : profile.name;
      const remote = isRemotePath(cwd) ? remotePath(cwd) : undefined;
      try {
        if (!remote) await invoke("check_terminal_command", { command: profile.command, cwd });
      } catch (error) {
        set({ launchError: `无法启动 ${sessionName}：${String(error)}` });
        return false;
      }
      const session = { id: crypto.randomUUID(), name: remote ? `SSH · ${sessionName}` : sessionName, command: profile.command, cwd, remoteId: remote?.id };
      set(state => ({
        launchError: "",
        sessions: [...state.sessions, session],
        activeSessionId: session.id
      }));
      return true;
    },
    removeSession: (id) => {
      set(state => {
        const remaining = state.sessions.filter(s => s.id !== id);
        let nextActiveId = state.activeSessionId;
        if (state.activeSessionId === id) {
          nextActiveId = remaining[remaining.length - 1]?.id ?? "";
        }
        return { sessions: remaining, activeSessionId: nextActiveId };
      });
    },
    setActiveSessionId: (id) => set({ activeSessionId: id }),
    reorderSessions: (oldIndex, newIndex) => set(state => {
      if (oldIndex < 0 || newIndex < 0 || oldIndex >= state.sessions.length || newIndex >= state.sessions.length || oldIndex === newIndex) return state;
      const sessions = [...state.sessions];
      const [session] = sessions.splice(oldIndex, 1);
      sessions.splice(newIndex, 0, session);
      return { sessions: [...sessions.filter(item => item.isPinned), ...sessions.filter(item => !item.isPinned)] };
    }),
    toggleSessionPin: (id) => set(state => {
      const sessions = state.sessions.map(session => session.id === id ? { ...session, isPinned: !session.isPinned } : session);
      return { sessions: [...sessions.filter(item => item.isPinned), ...sessions.filter(item => !item.isPinned)] };
    }),
  }),
  {
    name: "nexusdesk-terminal-profiles",
    storage: globalJsonStorage,
    version: 1,
    migrate: (persistedState) => {
      const state = persistedState as Pick<TerminalState, "profiles" | "defaultProfileId">;
      const hasCodex = state.profiles.some(profile =>
        profile.id === "codex" || /\bcodex\b/i.test(profile.command) || profile.name.toLowerCase() === "codex"
      );
      return {
        ...state,
        profiles: [
          ...state.profiles.map(profile => profile.id === "shell" && profile.name === "Terminal" ? { ...profile, name: "终端" } : profile),
          ...(hasCodex ? [] : [{ id: "codex", name: "Codex", command: "codex" }]),
        ],
      };
    },
    partialize: (state) => ({ profiles: state.profiles, defaultProfileId: state.defaultProfileId }),
  }
));
