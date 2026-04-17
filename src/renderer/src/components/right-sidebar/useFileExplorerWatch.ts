import { useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { FsChangedPayload } from '../../../../shared/types'
import type { DirCache } from './file-explorer-types'
import type { InlineInput } from './FileExplorerRow'
import { normalizeRelativePath } from '@/lib/path'
import { normalizeAbsolutePath } from './file-explorer-paths'
import { dirname } from '@/lib/path'
import { getConnectionId } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import {
  getOpenFilesForExternalFileChange,
  notifyEditorExternalFileChange
} from '../editor/editor-autosave'
import {
  purgeDirCacheSubtree,
  purgeExpandedDirsSubtree,
  clearStalePendingReveal
} from './file-explorer-watcher-reconcile'

type UseFileExplorerWatchParams = {
  worktreePath: string | null
  activeWorktreeId: string | null
  dirCache: Record<string, DirCache>
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  expanded: Set<string>
  setSelectedPath: Dispatch<SetStateAction<string | null>>
  refreshDir: (dirPath: string) => Promise<void>
  refreshTree: () => Promise<void>
  inlineInput: InlineInput | null
  dragSourcePath: string | null
}

export function getExternalFileChangeRelativePath(
  worktreePath: string,
  absolutePath: string,
  isDirectory: boolean | undefined
): string | null {
  if (isDirectory === true) {
    return null
  }

  const normalizedWorktreePath = normalizeAbsolutePath(worktreePath)
  const normalizedAbsolutePath = normalizeAbsolutePath(absolutePath)
  // Why: `normalizeAbsolutePath` preserves the trailing slash for filesystem
  // roots (`/` on POSIX, `C:/` on Windows drive roots) but strips it from all
  // other paths. Blindly appending `/` would produce `//` or `C://`, so
  // external edits under a root worktree would fail the prefix check and be
  // silently dropped. Treat those roots as already-terminated prefixes.
  const isFsRoot = normalizedWorktreePath === '/' || /^[A-Za-z]:\/$/.test(normalizedWorktreePath)
  const worktreePrefix = isFsRoot ? normalizedWorktreePath : `${normalizedWorktreePath}/`

  if (!normalizedAbsolutePath.startsWith(worktreePrefix)) {
    return null
  }

  // Why: EditorPanel only reloads open tabs after the renderer emits
  // `orca:editor-external-file-change` with a worktree-relative path. The
  // filesystem watcher reports absolute paths, so normalize them here before
  // the explorer refresh path returns; otherwise terminal edits refresh the
  // tree but leave the editor's cached file contents stale.
  return normalizeRelativePath(normalizedAbsolutePath.slice(worktreePrefix.length))
}

/**
 * Subscribes to filesystem watcher events for the active worktree and
 * reconciles File Explorer state on external changes.
 *
 * Why: the renderer must explicitly tell main which worktree to watch
 * because activeWorktreeId is renderer-local Zustand state (design §4.2).
 */
export function useFileExplorerWatch({
  worktreePath,
  activeWorktreeId,
  dirCache,
  setDirCache,
  expanded,
  setSelectedPath,
  refreshDir,
  refreshTree,
  inlineInput,
  dragSourcePath
}: UseFileExplorerWatchParams): void {
  // Keep refs for values accessed inside the event handler to avoid
  // re-subscribing the IPC listener on every render.
  const dirCacheRef = useRef(dirCache)
  dirCacheRef.current = dirCache

  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  const worktreeIdRef = useRef(activeWorktreeId)
  worktreeIdRef.current = activeWorktreeId

  const inlineInputRef = useRef(inlineInput)
  inlineInputRef.current = inlineInput

  const dragSourceRef = useRef(dragSourcePath)
  dragSourceRef.current = dragSourcePath

  // Why: refreshDir and refreshTree are stored as refs so the merged
  // subscribe+event effect does not re-subscribe the IPC listener when
  // `expanded` changes (which gives refreshTree a new identity). Without
  // refs, every expand/collapse would tear down and re-create the watcher
  // subscription and IPC listener unnecessarily (review issue §1).
  const refreshDirRef = useRef(refreshDir)
  refreshDirRef.current = refreshDir

  const refreshTreeRef = useRef(refreshTree)
  refreshTreeRef.current = refreshTree

  // Deferred events queue: events that arrive during inline input or drag
  const deferredRef = useRef<FsChangedPayload[]>([])

  // Why: the flush effect (below) lives outside the subscribe effect that
  // owns `processPayload`, but it still needs to replay deferred payloads to
  // preserve `notifyEditorExternalFileChange` semantics (design §6.2). A ref
  // bridges the two effects without tearing the subscription down on every
  // render.
  const processPayloadRef = useRef<((payload: FsChangedPayload) => void) | null>(null)

  // ── Subscribe, process events, and unsubscribe in one atomic effect ──
  // Why: merging the subscribe/unsubscribe effect and the event-processing
  // effect into a single useEffect eliminates a race where events from a
  // new watcher could be lost during rapid worktree switches. When they were
  // separate effects with the same `worktreePath` dependency, React could
  // run the event-listener cleanup before the unsubscribe cleanup, creating
  // a window where events arrive with no handler (review issue §3).
  useEffect(() => {
    if (!worktreePath) {
      return
    }

    const currentWorktreePath = worktreePath

    const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
    void window.api.fs.watchWorktree({ worktreePath, connectionId })

    function processPayload(payload: FsChangedPayload): void {
      // Why: during rapid worktree switches, in-flight batched events from
      // the old worktree can arrive after the switch. Processing them against
      // the new worktree's tree state would corrupt dirCache (design §3).
      if (
        normalizeAbsolutePath(payload.worktreePath) !== normalizeAbsolutePath(currentWorktreePath)
      ) {
        return
      }

      const wtId = worktreeIdRef.current
      if (!wtId) {
        return
      }

      const cache = dirCacheRef.current
      const exp = expandedRef.current

      // Collect directories that need refreshing
      const dirsToRefresh = new Set<string>()
      const changedFiles = new Set<string>()
      let needsFullRefresh = false

      for (const evt of payload.events) {
        const normalizedPath = normalizeAbsolutePath(evt.absolutePath)
        const externalFileChangeRelativePath = getExternalFileChangeRelativePath(
          currentWorktreePath,
          normalizedPath,
          evt.isDirectory
        )

        if (evt.kind === 'overflow') {
          needsFullRefresh = true
          break
        }

        if (evt.kind === 'delete') {
          // Why: for delete events, isDirectory is undefined from the watcher
          // (the path no longer exists). Infer from dirCache: if the deleted
          // path is a dirCache key, it was an expanded directory (design §4.4).
          const wasDirectory = normalizedPath in cache

          if (wasDirectory) {
            purgeDirCacheSubtree(setDirCache, normalizedPath)
            purgeExpandedDirsSubtree(wtId, normalizedPath)
          }

          // Clear pendingExplorerReveal if it targets the deleted path or any
          // descendant (for directory deletes). File deletes clear on exact match.
          clearStalePendingReveal(normalizedPath)

          // Clear selectedPath if it points into the deleted subtree
          setSelectedPath((prev) => {
            if (prev && normalizeAbsolutePath(prev) === normalizedPath) {
              return null
            }
            if (
              prev &&
              wasDirectory &&
              normalizeAbsolutePath(prev).startsWith(`${normalizedPath}/`)
            ) {
              return null
            }
            return prev
          })

          // Invalidate the parent directory
          const parent = normalizeAbsolutePath(dirname(normalizedPath))
          if (parent in cache) {
            dirsToRefresh.add(parent)
          }
          // Why: watcher delete events arrive with `isDirectory=undefined`
          // because the path is gone, so `getExternalFileChangeRelativePath`
          // cannot filter out directory deletes on its own. Use the dirCache-
          // inferred `wasDirectory` signal here to avoid notifying the editor
          // about directory deletions, which are not file changes.
          if (!wasDirectory && externalFileChangeRelativePath) {
            changedFiles.add(externalFileChangeRelativePath)
          }
        } else if (evt.kind === 'create') {
          // Invalidate the parent directory
          const parent = normalizeAbsolutePath(dirname(normalizedPath))
          if (parent in cache) {
            dirsToRefresh.add(parent)
          }
          if (externalFileChangeRelativePath) {
            changedFiles.add(externalFileChangeRelativePath)
          }
        } else if (evt.kind === 'update') {
          // Why: directory update events invalidate that directory. File-content
          // update events are ignored in v1 (design §6.1).
          if (evt.isDirectory === true) {
            if (normalizedPath in cache) {
              dirsToRefresh.add(normalizedPath)
            }
          } else if (externalFileChangeRelativePath) {
            changedFiles.add(externalFileChangeRelativePath)
          }
        }
        // 'rename' is deferred to v2 (design §5.3)
      }

      if (needsFullRefresh) {
        void refreshTreeRef.current()
        return
      }

      // Why: the autosave controller responds to this event by clearing
      // drafts and marking matching tabs clean. If any matching tab has
      // unsaved edits, emitting here would silently destroy the user's
      // work when an external process (terminal edit, formatter, watcher
      // replay) rewrites the file on disk. Skip the notification for any
      // path whose open tab is dirty so unsaved edits are preserved —
      // mirroring the explicit `!existingOpenFile.isDirty` guard in
      // `useFileExplorerHandlers`. Reading `openFiles` once before the
      // loop avoids N separate store reads for large batched payloads.
      const openFiles = useAppStore.getState().openFiles
      for (const relativePath of changedFiles) {
        const target = {
          worktreeId: wtId,
          worktreePath: currentWorktreePath,
          relativePath
        }
        const matchingFiles = getOpenFilesForExternalFileChange(openFiles, target)
        if (matchingFiles.some((file) => file.isDirty)) {
          continue
        }
        notifyEditorExternalFileChange(target)
      }

      // Only refresh directories that are already loaded (in cache) and are
      // either the root, expanded, or already have cached children.
      for (const dirPath of dirsToRefresh) {
        // Check the dir is the root or an expanded directory or already in cache
        if (
          dirPath === normalizeAbsolutePath(currentWorktreePath) ||
          exp.has(dirPath) ||
          dirPath in dirCacheRef.current
        ) {
          void refreshDirRef.current(dirPath)
        }
      }
    }

    // Why: expose `processPayload` to the flush effect so it can replay
    // deferred payloads without re-subscribing the IPC listener.
    processPayloadRef.current = processPayload

    const handleFsChanged = (payload: FsChangedPayload): void => {
      // Why: defer watcher-triggered refreshes while inline input or drag-drop
      // is active to avoid displacing the inline input row or shifting rows
      // under the drag cursor (design §6.2).
      if (inlineInputRef.current !== null || dragSourceRef.current !== null) {
        deferredRef.current.push(payload)
        return
      }

      processPayload(payload)
    }

    const unsubscribeListener = window.api.fs.onFsChanged(handleFsChanged)

    return () => {
      unsubscribeListener()
      void window.api.fs.unwatchWorktree({ worktreePath, connectionId })
      deferredRef.current = []
      processPayloadRef.current = null
    }
  }, [worktreePath, activeWorktreeId, setDirCache, setSelectedPath])

  // ── Flush deferred events when interaction ends ────────────────────
  useEffect(() => {
    if (inlineInput === null && dragSourcePath === null && deferredRef.current.length > 0) {
      const deferred = deferredRef.current.splice(0)
      // Why: replay every deferred payload through `processPayload` so that
      // `notifyEditorExternalFileChange` still fires for external edits that
      // landed during inline input or drag (design §6.2). Simply refreshing
      // the tree would re-read directory entries but leave open editor tabs
      // showing stale content — defeating the entire point of deferring.
      if (processPayloadRef.current) {
        for (const payload of deferred) {
          processPayloadRef.current(payload)
        }
      }
      // Why: also trigger a tree refresh as a safety net. Deferred events may
      // have been coalesced by the watcher or become stale during the defer
      // window, and a full refresh guarantees the explorer state converges on
      // disk reality even if individual event replay misses a subtree.
      if (worktreePath) {
        void refreshTreeRef.current()
      }
    }
  }, [inlineInput, dragSourcePath, worktreePath])
}
