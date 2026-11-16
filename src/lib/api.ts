import { invokePathCommand as invoke, isRemotePath } from "./remote";
import { canReadAsText } from "./assets";
import { isSnapshot } from "./snapshot";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { invalidateTreeFiles, readCachedTreeFile } from "./treeFileCache";
import { resolveGDStudioPlayUrl, searchGDStudio } from "./gdMusic";
import { getMusicChorus, type MusicChorus } from "./musicChorus";

export interface SearchResult {
    path: string;
    title: string;
    relativePath: string;
    snippet: string;
    score: number;
    matchStart?: number | null;
    matchEnd?: number | null;
}

export interface SearchOptions { extensions: string; caseSensitive: boolean; regex: boolean; wholeWord: boolean; includeIgnored: boolean }
export const searchApi = {
    search: (root: string, query: string, requestId: string, options: SearchOptions, paths?: string[]): Promise<SearchResult[]> =>
        invoke("search_everywhere", { root, query, requestId, options, paths }),
    cancel: (requestId: string): Promise<void> => invoke("cancel_search", { requestId }),
};

export interface LocalHistoryEntry { id: number; created_at: number }
export interface TextSnapshot { content: string; version?: string }
export interface TextSaveResult { logicalChanged: boolean; version: string }
const musicCovers = new Map<string, Promise<string | null>>();
export interface MusicTrack { id: string; title: string; artist: string; album: string; duration: number; path: string | null; coverPath: string | null }
export type MusicPlaylistTrack = Pick<MusicTrack, "title" | "artist" | "album" | "duration">;
export interface MusicPlaylist { id: string; name: string; trackIds: string[]; trackMetadata?: Record<string, MusicPlaylistTrack> }
export const musicApi = {
    chorus: (id: string): Promise<MusicChorus | null> =>
        getMusicChorus(id, songId => invoke("music_chorus", { id: songId })),
    coverUrl: (id: string): Promise<string | null> => {
        const cached = musicCovers.get(id);
        if (cached) return cached;
        if (musicCovers.size >= 128) musicCovers.clear();
        const request = invoke<string | null>("music_cover_url", { id }).catch(reason => {
            musicCovers.delete(id);
            throw reason;
        });
        musicCovers.set(id, request);
        return request;
    },
    search: searchGDStudio,
    playUrl: resolveGDStudioPlayUrl,
    download: async (track: Pick<MusicTrack, "id" | "title" | "artist">): Promise<MusicTrack> =>
        invoke("download_music", { ...track, url: await resolveGDStudioPlayUrl(track.id) }),
    local: (): Promise<MusicTrack[]> => invoke("list_local_music"),
    playlists: (): Promise<MusicPlaylist[]> => invoke("list_music_playlists"),
    savePlaylists: (playlists: MusicPlaylist[]): Promise<void> => invoke("save_music_playlists", { playlists }),
    deleteLocal: (id: string): Promise<void> => invoke("delete_local_music", { id }),
};
export interface VideoToolStatus { ytDlpAvailable: boolean; path: string | null; ffmpegAvailable: boolean }
export interface ManagedSoftware { id: string; name: string }
export const softwareApi = {
    list: (): Promise<ManagedSoftware[]> => invoke("managed_software_list"),
    status: (id: string): Promise<boolean> => invoke("managed_software_status", { id }),
    install: (id: string): Promise<void> => invoke("managed_software_install", { id }),
    uninstall: (id: string): Promise<void> => invoke("managed_software_uninstall", { id }),
};
export interface LocalVideo { path: string; name: string; size: number; modified: number }
export const videoApi = {
    status: (): Promise<VideoToolStatus> => invoke("video_tool_status"),
    local: (): Promise<LocalVideo[]> => invoke("list_local_videos"),
    delete: (path: string): Promise<void> => invoke("delete_local_video", { path }),
    download: (url: string, destination: string, requestId: string): Promise<string> => invoke("download_video", { url, destination, requestId }),
    cancelDownload: (requestId: string): Promise<void> => invoke("cancel_video_download", { requestId }),
    convertMkvToMp4: (path: string): Promise<string> => invoke("convert_mkv_to_mp4", { path }),
    cancelMkvToMp4: (path: string): Promise<void> => invoke("cancel_mkv_to_mp4", { path }),
};
export interface GraphCategory { name: string; files: string[]; missingFiles: string[]; color?: string | null }
export interface LogicalSyncData { workspace: string; folders: string[]; entries: { path: string; category: string; kind: string }[]; deletedFolders?: string[] }
export interface GraphSyncData { workspace: string; categories: { name: string; color: string | null }[]; files: { category: string; path: string }[] }
function notifyGraphChanged() {
    window.dispatchEvent(new Event("nexusdesk-graph-data-changed"));
    window.dispatchEvent(new Event("nexusdesk:graph-updated"));
}
export const fsApi = {
    editGraphCategory: async (name: string, newName: string | null): Promise<void> => { await invoke("edit_graph_category", { name, newName }); notifyGraphChanged(); },
    removeGraphFile: async (category: string, path: string): Promise<void> => { await invoke("remove_graph_file", { category, path }); notifyGraphChanged(); },
    setGraphCategoryColor: async (category: string, color: string | null): Promise<void> => { await invoke("set_graph_category_color", { category, color }); notifyGraphChanged(); },
    getGraphCategories: (): Promise<GraphCategory[]> => invoke("get_graph_categories"),
    createGraphCategory: async (name: string): Promise<void> => { await invoke("create_graph_category", { name }); notifyGraphChanged(); },
    linkGraphFiles: async (category: string, paths: string[]): Promise<void> => { await invoke("link_graph_files", { category, paths }); notifyGraphChanged(); },
    getGraphSyncData: (root: string): Promise<GraphSyncData> => invoke("get_graph_sync_data", { root }),
    applyGraphSyncData: async (root: string, data: GraphSyncData): Promise<void> => { await invoke("apply_graph_sync_data", { root, data }); notifyGraphChanged(); },
    readBinaryFile: (path: string): Promise<number[]> => invoke("read_binary_file", { path }),
    writeBinaryFile: (path: string, bytes: number[]): Promise<void> => invoke("write_binary_file", { path, bytes }),
    importAsset: (notePath: string, asset: { sourcePath?: string; name?: string; bytes?: number[] }): Promise<string> => invoke("import_asset", { notePath, ...asset }),
    importFile: (targetDir: string, name: string, bytes: number[]): Promise<string> => invoke("import_asset", { notePath: "", targetDir, name, bytes }),
    localHistory: (path: string): Promise<LocalHistoryEntry[]> => invoke("list_local_history", { path }),
    historyContent: (path: string, id: number): Promise<string> => invoke("local_history_content", { path, id }),
    writeFileClipboard: (paths: string[], cut: boolean): Promise<void> => invoke("write_file_clipboard", { paths, cut }),
    updateFileClipboard: (paths: string[], cut: boolean, sequence: number): Promise<void> => invoke("write_file_clipboard", { paths, cut, expectedSequence: sequence }),
    readFileClipboard: (): Promise<{ sequence: number; paths: string[]; cut: boolean }> => invoke("read_file_clipboard"),
    renameEntry: (sourcePath: string, name: string): Promise<string> => invoke("rename_entry", { sourcePath, name }),
    deleteEntry: (path: string): Promise<void> => invoke("delete_entry", { path }),
    touchFile: (path: string): Promise<void> => isSnapshot ? Promise.resolve() : invoke("touch_file", { path }),
    recentFiles: (): Promise<string[]> => invoke("recent_files"),
    compareText: (left: string, right: string): Promise<string> => invoke("compare_text", { left, right }),
    isDirectory: (path: string): Promise<boolean> => invoke("is_directory", { path }),
    projectDirectoryExists: (path: string): Promise<boolean> => invoke("project_directory_exists", { path }),
    initProjectDb: (path: string): Promise<void> => invoke("init_project_db", { path }),

    readFile: (path: string): Promise<string> => !isRemotePath(path) && !canReadAsText(path) ? Promise.resolve("") : invoke("read_file", { path }),
    readFileSnapshot: async (path: string, allowMissing = false): Promise<TextSnapshot> =>
        isRemotePath(path) || !canReadAsText(path) ? { content: await fsApi.readFile(path) }
            : invoke("read_file_snapshot", { path, allowMissing }),
    inspectFileSnapshot: async (path: string, knownVersion?: string): Promise<{ content?: string; version?: string }> =>
        isRemotePath(path) || !canReadAsText(path) ? fsApi.readFileSnapshot(path)
            : invoke("read_file_snapshot", { path, knownVersion }),
    textVersion: (content: string): Promise<string> => invoke("text_version", { content }),
    writeFileSnapshot: async (path: string, content: string, expectedVersion: string): Promise<TextSaveResult> => {
        const result = await invoke<TextSaveResult>("write_file_snapshot", { path, content, expectedVersion });
        invalidateTreeFiles([path]);
        return result;
    },

    readTreeFile: (path: string): Promise<string> => readCachedTreeFile(path, fsApi.readFile),
    invalidateTreeFiles,
    writeFile: async (path: string, content: string): Promise<boolean> => {
        const changed = await invoke<boolean | null>("write_file", { path, content });
        invalidateTreeFiles([path]);
        return changed === true;
    },
    getFileLinks: (path: string, reverse: boolean): Promise<[string, string][]> => invoke("get_file_links", { path, reverse }),

    syncProjectIndex: (path: string, paths?: string[]): Promise<void> => invoke("sync_project_index", { path, paths }),

    readDirectory: (path: string): Promise<any[]> => invoke("read_directory", { path }),

    desktopDirectory: async (): Promise<string> => join(await homeDir(), "Desktop"),
    openFolderDialog: async (defaultPath?: string): Promise<string | null> => {
        const selected = await open({ directory: true, multiple: false, defaultPath });
        return selected as string | null;
    },

    getLogicalTree: (): Promise<any[]> => invoke("get_logical_tree"),
    getLogicalSyncData: (root: string): Promise<LogicalSyncData> => invoke("get_logical_sync_data", { root }),
    applyLogicalSyncData: (root: string, data: LogicalSyncData): Promise<void> => invoke("apply_logical_sync_data", { root, data }),
    prepareLogicalSandbox: (project: string, category: string): Promise<string> => invoke("prepare_logical_sandbox", { project, category }),
    removeLogicalFile: (path: string, category: string): Promise<void> => invoke("remove_logical_file", { path, category }),
    getHiddenLogicalFiles: (): Promise<[string, string][]> => invoke("get_hidden_logical_files"),

    editLogicalFolder: (name: string, newName: string | null, copy = false): Promise<void> => invoke("edit_logical_folder", { name, newName, copy }),

    createLogicalFolder: (name: string): Promise<void> => invoke("create_logical_folder", { name }),

    updateFileFrontmatter: (path: string, newType: string): Promise<void> =>
        invoke("update_file_frontmatter", { path, newType }),

    copyFileToDir: (sourcePath: string, targetDir: string): Promise<void> =>
        invoke("copy_file_to_dir", { sourcePath, targetDir }),

    moveEntry: (sourcePath: string, targetDir: string): Promise<string> => invoke("move_entry", { sourcePath, targetDir }),

    createPhysicalFile: (path: string): Promise<void> => invoke("create_physical_file", { path }),

    createPhysicalDir: (path: string): Promise<void> => invoke("create_physical_dir", { path }),
};

export interface GitFileStatus { path: string; worktreePath: string; staged: boolean; unstaged: boolean; conflict: boolean; status: string }
export interface GitLogEntry { id: string; parents: string[]; message: string; author: string; time: number; refs: string[]; pushed: boolean; recoveryPatch: boolean; isHead: boolean }
export interface GitRevisionChange { path: string; status: string }
export interface GitSettings { remote: string; proxy: string; token: string }
export interface CodexSettings { model: string; proxyUrl: string; apiKeyConfigured: boolean; trustMode: boolean; showTooltips: boolean; checkForUpdateOnStartup: boolean }
export type GitProvider = "github" | "gitlab" | "gitee";
export interface GitRepository { name: string; fullName: string; cloneUrl: string; private: boolean }
export interface GitCloneAuth { token: string; provider: GitProvider }
export type TreeFileStatus = "clean" | "ignored" | "modified" | "added" | "untracked" | "conflict" | "deleted";
export interface GitTreeStatus { path: string; status: TreeFileStatus }
interface GitStatusSnapshot { files: GitFileStatus[]; tree: GitTreeStatus[] }
const gitStatusRequests = new Map<string, { revision: number; request?: Promise<GitStatusSnapshot> }>();
function invalidateGitStatus(repoPath: string) {
    const entry = gitStatusRequests.get(repoPath);
    if (entry) entry.revision++;
}
function gitStatusSnapshot(repoPath: string): Promise<GitStatusSnapshot> {
    let entry = gitStatusRequests.get(repoPath);
    if (!entry) {
        entry = { revision: 0 };
        gitStatusRequests.set(repoPath, entry);
    }
    if (entry.request) return entry.request;
    const current = entry;
    current.request = (async () => {
        // 合并同一批事件中来自文件树与 Git 面板的请求。
        await new Promise(resolve => setTimeout(resolve, 40));
        while (true) {
            const revision = current.revision;
            const result = await invoke<GitStatusSnapshot>("get_git_status_snapshot", { repoPath });
            if (revision === current.revision) return result;
        }
    })().finally(() => { gitStatusRequests.delete(repoPath); });
    return current.request;
}
async function mutateGit<T>(command: string, args: Record<string, unknown>): Promise<T> {
    const repoPath = args.repoPath as string;
    invalidateGitStatus(repoPath);
    try { return await invoke<T>(command, args); }
    finally { invalidateGitStatus(repoPath); }
}

export const gitApi = {
    invalidateStatus: invalidateGitStatus,
    pathHistory: (path: string, limit = 100): Promise<{ root: string; entries: { commit: GitLogEntry; changes: GitRevisionChange[] }[] }> => invoke("get_git_path_history", { path, limit }),
    openSnapshot: (repoPath: string, commitId: string): Promise<void> => invoke("open_git_snapshot", { repoPath, commitId }),
    isInstalled: (): Promise<boolean> => invoke("is_git_installed"),
    settings: (repoPath: string): Promise<GitSettings> => invoke("get_git_settings", { repoPath }),
    saveSettings: (repoPath: string, settings: GitSettings): Promise<void> => invoke("save_git_settings", { repoPath, settings }),
    listRepositories: (provider: GitProvider, token: string): Promise<GitRepository[]> => invoke("list_git_repositories", { provider, token }),
    cloneRepository: (url: string, targetPath: string, auth?: GitCloneAuth): Promise<void> => invoke("clone_git_repository", { url, targetPath, token: auth?.token, provider: auth?.provider }),
    push: (repoPath: string): Promise<void> => mutateGit("push_git_repository", { repoPath }),
    undoCommit: (repoPath: string, commitId: string): Promise<void> => mutateGit("undo_git_commit", { repoPath, commitId }),
    undoPushedCommit: (repoPath: string, commitId: string): Promise<void> => mutateGit("undo_pushed_git_commit", { repoPath, commitId }),
    restorePushedCommit: (repoPath: string, baseId: string): Promise<void> => mutateGit("restore_pushed_git_commit", { repoPath, baseId }),
    initRepository: (repoPath: string): Promise<void> => mutateGit("init_git_repository", { repoPath }),
    isRepository: (repoPath: string): Promise<boolean> => invoke("is_git_repository", { repoPath }),
    directory: (repoPath: string): Promise<string> => invoke("get_git_directory", { repoPath }),
    treeStatus: (repoPath: string): Promise<GitTreeStatus[]> => gitStatusSnapshot(repoPath).then(snapshot => snapshot.tree),
    revert: (repoPath: string, path: string): Promise<void> => mutateGit("revert_git_file", { repoPath, path }),
    revertMany: (repoPath: string, paths: string[]): Promise<void> => mutateGit("revert_git_files", { repoPath, paths }),
    undoRevert: (repoPath: string): Promise<string[]> => mutateGit("undo_git_revert", { repoPath }),
    ignore: (repoPath: string, path: string): Promise<void> => mutateGit("ignore_git_file", { repoPath, path }),
    revisionChanges: (repoPath: string, commitId: string): Promise<GitRevisionChange[]> => invoke("get_git_revision_changes", { repoPath, commitId }),
    revisionDiff: (repoPath: string, commitId: string, path: string): Promise<string> => invoke("get_git_revision_diff", { repoPath, commitId, path }),
    revisionFiles: (repoPath: string, commitId: string): Promise<{ path: string }[]> => invoke("get_git_revision_files", { repoPath, commitId }),
    revisionContent: (repoPath: string, commitId: string, path: string): Promise<string> => invoke("get_git_revision_content", { repoPath, commitId, path }),
    status: (repoPath: string): Promise<GitFileStatus[]> => gitStatusSnapshot(repoPath).then(snapshot => snapshot.files),
    stage: (repoPath: string, path: string, staged: boolean): Promise<void> => mutateGit("stage_git_file", { repoPath, path, staged }),
    commit: (repoPath: string, message: string): Promise<string> => mutateGit("commit_git", { repoPath, message }),
    log: (repoPath: string, limit = 100): Promise<GitLogEntry[]> => invoke("get_git_log", { repoPath, limit }),
    diff: (repoPath: string, path: string, staged: boolean): Promise<string> => invoke("get_git_diff", { repoPath, path, staged }),
};

export const codexSettingsApi = {
    read: (): Promise<CodexSettings> => invoke("codex_settings_read"),
    save: (input: { model: string; proxyUrl: string; apiKey?: string; trustMode: boolean; showTooltips: boolean; checkForUpdateOnStartup: boolean }): Promise<void> => invoke("codex_settings_save", { input }),
};
export const chatApi = {
    images: (prompt: string, images: ChatImage[], overrides: ChatOverrides, size: string): Promise<ChatImage[]> => invoke("chat_images", { prompt, images, overrides, size }),
    complete: (requestId: string, messages: { role: "user" | "assistant"; content: string }[], overrides?: ChatOverrides): Promise<void> => invoke("chat_completion", { requestId, messages, overrides }),
};

export interface ChatOverrides {
    api?: string;
    key?: string;
    model?: string;
    format?: "responses" | "chat";
}

export interface ChatImage {
    name: string;
    url: string;
}
