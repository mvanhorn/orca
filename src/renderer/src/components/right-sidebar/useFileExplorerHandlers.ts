import { useCallback } from 'react'
import type React from 'react'
import type { RefObject } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import { useAppStore } from '@/store'
import type { TreeNode } from './file-explorer-types'
import { notifyEditorExternalFileChange } from '../editor/editor-autosave'

type UseFileExplorerHandlersParams = {
  activeWorktreeId: string | null
  openFile: (params: {
    filePath: string
    relativePath: string
    worktreeId: string
    language: string
    mode: 'edit'
  }) => void
  pinFile: (filePath: string) => void
  toggleDir: (worktreeId: string, dirPath: string) => void
  setSelectedPath: (path: string) => void
  scrollRef: RefObject<HTMLDivElement | null>
}

type UseFileExplorerHandlersReturn = {
  handleClick: (node: TreeNode) => void
  handleDoubleClick: (node: TreeNode) => void
  handleWheelCapture: (e: React.WheelEvent<HTMLDivElement>) => void
}

export function useFileExplorerHandlers({
  activeWorktreeId,
  openFile,
  pinFile,
  toggleDir,
  setSelectedPath,
  scrollRef
}: UseFileExplorerHandlersParams): UseFileExplorerHandlersReturn {
  const handleClick = useCallback(
    (node: TreeNode) => {
      if (!activeWorktreeId) {
        return
      }
      setSelectedPath(node.path)
      if (node.isDirectory) {
        toggleDir(activeWorktreeId, node.path)
        return
      }

      const existingOpenFile = useAppStore
        .getState()
        .openFiles.find((file) => file.filePath === node.path)
      if (existingOpenFile && !existingOpenFile.isDirty) {
        // Why: the filesystem watcher only runs while the Explorer panel is
        // mounted. If a terminal edit happens while another sidebar tab is
        // active, re-selecting the file from Explorer should still refresh the
        // clean tab from disk instead of reusing stale cached contents.
        const worktreePath = node.path.slice(0, node.path.length - node.relativePath.length - 1)
        notifyEditorExternalFileChange({
          worktreeId: activeWorktreeId,
          worktreePath,
          relativePath: node.relativePath
        })
      }

      openFile({
        filePath: node.path,
        relativePath: node.relativePath,
        worktreeId: activeWorktreeId,
        language: detectLanguage(node.name),
        mode: 'edit'
      })
    },
    [activeWorktreeId, openFile, toggleDir, setSelectedPath]
  )

  const handleDoubleClick = useCallback(
    (node: TreeNode) => {
      if (!activeWorktreeId || node.isDirectory) {
        return
      }
      pinFile(node.path)
    },
    [activeWorktreeId, pinFile]
  )

  const handleWheelCapture = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const container = scrollRef.current
      if (!container || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) {
        return
      }
      const target = e.target
      if (!(target instanceof Element) || !target.closest('[data-explorer-draggable="true"]')) {
        return
      }
      if (container.scrollHeight <= container.clientHeight) {
        return
      }
      e.preventDefault()
      container.scrollTop += e.deltaY
    },
    [scrollRef]
  )

  return { handleClick, handleDoubleClick, handleWheelCapture }
}
