import { snapshotCommit } from "@/lib/snapshot";
import React, { useEffect, useState } from "react";
import noteideIcon from "@/assets/noteide.svg";
import * as DropdownMenu from "@/lib/nativeDropdownMenu";
import * as Dialog from "@radix-ui/react-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { flushGlobalSettings, settingsStorage } from "@/lib/globalSettings";
import { Check, X, ChevronDown } from "lucide-react";
import { fsApi, gitApi, type GitCloneAuth } from "@/lib/api";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { CreateProjectDialog } from "./CreateProjectDialog";
import { CloneProjectDialog } from "./CloneProjectDialog";
import { SftpConnectDialog } from "./SftpConnectDialog";
import { confirmAction, showError } from "@/lib/dialogs";

export const TitleBar: React.FC<{ expanded?: boolean }> = ({ expanded = false } = {}) => {
  const appWindow = getCurrentWindow();
  const { setProject, closeProject, recentProjects, rootPath, remoteLabel, disconnectRemote } = useWorkspaceStore();
  const projectName = snapshotCommit ? `项目快照 @${snapshotCommit.slice(0, 8)} · 只读` : remoteLabel ? `SFTP · ${remoteLabel}` : rootPath ? rootPath.split(/[/\\]/).filter(Boolean).pop() || rootPath : "NoteIDE";
  const badgeName = remoteLabel || (rootPath ? rootPath.split(/[/\\]/).filter(Boolean).pop() : null) || "NoteIDE";
  const firstCharacter = Array.from(badgeName)[0];
  const projectInitials = /\p{Script=Han}/u.test(firstCharacter) ? firstCharacter : Array.from(badgeName).slice(0, 2).join("").toUpperCase();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [windowError, setWindowError] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [cloneProjectOpen, setCloneProjectOpen] = useState(false);
  const [sftpOpen, setSftpOpen] = useState(false);

  useEffect(() => {
    void appWindow.setTitle(projectName).catch(error => console.error("Failed to update window title:", error));
  }, [appWindow, projectName]);

  const handleOpenFolder = async () => {
    try {
      const selectedPath = await fsApi.openFolderDialog();
      if (selectedPath) {
        if (!rootPath) {
          await setProject(selectedPath);
        } else {
          setSelectedProject(selectedPath);
          setDialogOpen(true);
        }
      }
    } catch (error) {
      console.error("Failed to open folder:", error);
    }
  };

  const createProject = async (path: string) => {
    await fsApi.createPhysicalDir(path);
    if (!await setProject(path)) throw new Error("无法打开新项目目录");
  };

  const cloneProject = async (url: string, targetPath: string, auth?: GitCloneAuth) => {
    await gitApi.cloneRepository(url, targetPath, auth);
    if (!await setProject(targetPath)) throw new Error("无法打开克隆的项目目录");
  };

  const [missingProjects, setMissingProjects] = useState<Record<string, boolean>>({});

  const refreshRecentProjects = async () => {
    const entries = await Promise.all(recentProjects.filter(path => !path.startsWith("sftp://")).map(async path => {
      try { return [path, !await fsApi.projectDirectoryExists(path)] as const; }
      catch { return [path, false] as const; }
    }));
    setMissingProjects(Object.fromEntries(entries));
  };

  const checkRecentProject = async (path: string) => {
    if (path.startsWith("sftp://")) return true;
    try {
      const exists = await fsApi.projectDirectoryExists(path);
      setMissingProjects(state => ({ ...state, [path]: !exists }));
      if (exists) return true;
      if (await confirmAction(`项目目录不存在或已被移动：\n${path}\n\n是否从最近打开的项目中移除？`, {
        title: "项目不存在", confirmLabel: "移除记录", cancelLabel: "保留记录",
      })) {
        useWorkspaceStore.setState(state => ({ recentProjects: state.recentProjects.filter(item => item !== path) }));
      }
    } catch (error) { showError(`无法检查项目目录：${String(error)}`); }
    return false;
  };

  const handleRecentSelect = async (path: string) => {
    if (!await checkRecentProject(path)) return;
    if (path === rootPath) return;
    if (!rootPath) {
      setProject(path).catch(console.error);
    } else {
      setSelectedProject(path);
      setDialogOpen(true);
    }
  };

  const openInThisWindow = async () => {
    if (selectedProject) {
      if (!await checkRecentProject(selectedProject)) { setDialogOpen(false); return; }
      await setProject(selectedProject);
    }
    setDialogOpen(false);
  };

  const openInNewWindow = async () => {
    setWindowError(null);
    try {
      if (selectedProject) {
        if (!await checkRecentProject(selectedProject)) { setDialogOpen(false); return; }
        await flushGlobalSettings();
        await invoke<number>("open_project_instance", { path: selectedProject });
        setDialogOpen(false);
      }
    } catch (error) {
      console.error("Failed to create new window:", error);
      setWindowError(String(error));
    }
  };

  return (
      <div
          data-tauri-drag-region
          className={`drag-region flex h-9 items-center border-r border-ide-panel-border bg-ide-panel-bg select-none ${expanded ? "min-w-0 flex-1 px-2" : "w-11 shrink-0 justify-center"}`}
      >
        <div data-tauri-drag-region className={`drag-region flex min-w-0 w-full items-center text-sm text-gray-300 ${expanded ? "justify-start" : "justify-center"}`}>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild onBeforeOpen={refreshRecentProjects}>
              <button type="button" aria-label={`项目：${projectName}`} title={projectName} className={`no-drag-region ${expanded ? "project-name-button" : "project-badge"}`}>
                {expanded ? <>
                  <img src={noteideIcon} alt="" className="w-5 h-5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left">{projectName}</span>
                  <ChevronDown size={14} className="shrink-0" aria-hidden="true" />
                </> : projectInitials}
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="start" sideOffset={8} collisionPadding={8} className="ide-menu w-72 text-sm no-drag-region z-50">
                <DropdownMenu.Item className="ide-menu-item" onSelect={() => setNewProjectOpen(true)}>新建项目...</DropdownMenu.Item>
                <DropdownMenu.Item className="ide-menu-item" onSelect={() => void handleOpenFolder()}>打开项目...</DropdownMenu.Item>
                <DropdownMenu.Item className="ide-menu-item" onSelect={() => setSftpOpen(true)}>打开 SFTP...</DropdownMenu.Item>
                {remoteLabel && <DropdownMenu.Item className="ide-menu-item" onSelect={() => void disconnectRemote().catch(error => showError(String(error)))}>断开 SFTP 连接</DropdownMenu.Item>}
                <DropdownMenu.Item className="ide-menu-item" onSelect={() => setCloneProjectOpen(true)}>克隆 Git 项目...</DropdownMenu.Item>
                <DropdownMenu.Item className="ide-menu-item" disabled={!rootPath} onSelect={() => void closeProject().catch(error => showError(String(error)))}>关闭项目</DropdownMenu.Item>
                <DropdownMenu.Separator className="h-px my-1 bg-ide-panel-border" />
                <div className="px-2 py-1 text-xs text-gray-500">最近打开的项目</div>
                <section className="native-menu-scroll" aria-label="最近打开的项目">
                {recentProjects.length === 0 && <div className="px-2 py-1 text-xs text-gray-400">暂无记录</div>}
                {recentProjects.map(path => {
                  const isCurrent = path === rootPath;
                  return (
                      <DropdownMenu.Item
                          key={path}
                          onSelect={() => void handleRecentSelect(path)}
                          className={`ide-menu-item flex w-full min-w-0 flex-col items-start rounded-sm ${isCurrent ? 'bg-ide-selection/30' : ''} ${missingProjects[path] ? 'recent-project-missing' : ''}`}
                          title={missingProjects[path] ? `目录不存在：${path}` : path}
                      >
                        <div className="flex min-w-0 w-full items-center justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate">{path.startsWith("sftp://") ? `SFTP ${settingsStorage.getItem(`sftp-label:${new URL(path).hostname}`) || new URL(path).hostname}` : path.split(/[/\\]/).pop()}</span>
                          {missingProjects[path] && <span className="shrink-0 whitespace-nowrap px-1 text-[10px]">被删</span>}
                          {isCurrent && <Check size={14} className="text-blue-400 shrink-0" />}
                        </div>
                        <span className="block w-full min-w-0 truncate text-xs text-gray-500">{path}</span>
                      </DropdownMenu.Item>
                  );
                })}
                </section>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>

        <Dialog.Root open={dialogOpen} onOpenChange={open => { setDialogOpen(open); setWindowError(null); }}>
          <Dialog.Portal>
            <Dialog.Overlay className="search-overlay" />
            <Dialog.Content className="create-name-dialog" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
              <header className="flex items-center justify-between border-b border-ide-panel-border px-4 py-3">
                <Dialog.Title className="font-medium">打开项目</Dialog.Title>
                <Dialog.Close className="rounded p-1 hover:bg-white/10"><X size={16} /></Dialog.Close>
              </header>
              <div className="p-4 text-sm">
                <p>你想在哪个窗口打开项目？</p>
                <p className="text-xs text-gray-400 mt-1 break-all">{selectedProject}</p>
                {windowError && <p role="alert" className="mt-2 text-sm text-red-400 break-all">新窗口打开失败：{windowError}</p>}
              </div>
              <footer className="flex justify-end gap-2 border-t border-ide-panel-border px-4 py-3">
                <Dialog.Close className="rounded border border-ide-panel-border px-4 py-1.5 hover:bg-white/10 text-sm">取消</Dialog.Close>
                <button onClick={openInThisWindow} className="rounded border border-ide-panel-border px-4 py-1.5 hover:bg-white/10 text-sm">当前窗口</button>
                <button onClick={openInNewWindow} className="rounded bg-ide-accent px-4 py-1.5 text-white text-sm">新窗口</button>
              </footer>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        {sftpOpen && <SftpConnectDialog onClose={() => setSftpOpen(false)} />}
        {newProjectOpen && <CreateProjectDialog
          onCreate={createProject}
          onClose={() => setNewProjectOpen(false)}
        />}
        {cloneProjectOpen && <CloneProjectDialog
          onClone={cloneProject}
          onClose={() => setCloneProjectOpen(false)}
        />}
      </div>
  );
};
