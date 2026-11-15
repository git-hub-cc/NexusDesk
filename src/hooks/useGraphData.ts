import { useEffect, useSyncExternalStore } from "react";
import { fsApi } from "@/lib/api";
import { createGraphDataResource } from "@/lib/graphData";
import { findWorkspaceFile } from "@/lib/workspaceFile";
import { useWorkspaceStore } from "@/store/workspaceStore";

const resource = createGraphDataResource({
  root: () => useWorkspaceStore.getState().rootPath,
  categories: fsApi.getGraphCategories,
  content: path => {
    const state = useWorkspaceStore.getState();
    return findWorkspaceFile([...state.leftTabs, ...state.rightTabs], path)?.content;
  },
  read: fsApi.readTreeFile,
});
const empty = { root: null, categories: [], trees: [], counts: new Map<string, number>(), error: "" };
let consumers = 0;
let disconnect: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function refresh() {
  clearTimeout(timer);
  return resource.refresh();
}

function connect() {
  if (consumers++ === 0) {
    const receive = () => {
      resource.invalidate();
      clearTimeout(timer);
      timer = setTimeout(() => { void refresh(); }, 40);
    };
    const stop = useWorkspaceStore.subscribe((state, previous) => {
      if (state.rootPath !== previous.rootPath) {
        resource.invalidate();
        void resource.refresh();
      } else if (state.indexRevision !== previous.indexRevision) receive();
      else if (state.leftTabs !== previous.leftTabs || state.rightTabs !== previous.rightTabs) {
        const tabs = [...state.leftTabs, ...state.rightTabs];
        const oldTabs = [...previous.leftTabs, ...previous.rightTabs];
        if ([...tabs, ...oldTabs].some(tab => /\.tree$/i.test(tab.path)
          && findWorkspaceFile(tabs, tab.path)?.content !== findWorkspaceFile(oldTabs, tab.path)?.content)) receive();
      }
    });
    const events = ["nexusdesk:graph-updated", "nexusdesk:files-moved"];
    events.forEach(event => window.addEventListener(event, receive));
    disconnect = () => {
      clearTimeout(timer);
      stop();
      events.forEach(event => window.removeEventListener(event, receive));
      resource.invalidate();
    };
    resource.invalidate();
    void resource.refresh();
  }
  return () => { if (--consumers === 0) { disconnect?.(); disconnect = undefined; } };
}

export function useGraphData(enabled = true, retainWhenDisabled = false) {
  const root = useWorkspaceStore(state => state.rootPath);
  const data = useSyncExternalStore(resource.subscribe, resource.getSnapshot);
  useEffect(() => { if (enabled) return connect(); }, [enabled]);
  return { ...((enabled || retainWhenDisabled) && data.root === root ? data : empty), refresh };
}
