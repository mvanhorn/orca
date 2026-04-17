import type { TerminalTab } from '../../../shared/types'

export function hasLivePtyForTab(
  tab: Pick<TerminalTab, 'id' | 'ptyId'>,
  ptyIdsByTabId?: Record<string, string[]>
): boolean {
  if (ptyIdsByTabId && Object.prototype.hasOwnProperty.call(ptyIdsByTabId, tab.id)) {
    return (ptyIdsByTabId[tab.id] ?? []).length > 0
  }

  return tab.ptyId != null
}
