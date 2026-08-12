import { panelFetch } from '@/lib/public-path'
import type { PanelUpdateStatus } from '@gravit-panel/shared'
import { useQuery } from '@tanstack/vue-query'

const getStatus = async () => {
  const response = await panelFetch('/api/self-update')
  if (!response.ok) throw new Error(`Update check failed with status ${response.status}`)
  return response.json() as Promise<PanelUpdateStatus>
}

export const usePanelSelfUpdate = () => useQuery({
  queryKey: ['panel-self-update'],
  queryFn: getStatus,
  staleTime: 5 * 60_000,
  refetchInterval: 10 * 60_000,
})
