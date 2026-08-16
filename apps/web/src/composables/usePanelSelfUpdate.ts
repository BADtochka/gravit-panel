import { panelFetch } from '@/lib/public-path'
import type { PanelUpdateStatus } from '@gravit-panel/shared'
import { useQuery, useQueryClient } from '@tanstack/vue-query'

const getStatus = async (force = false) => {
  const response = await panelFetch(`/api/self-update${force ? '?force=true' : ''}`)
  if (!response.ok) throw new Error(`Update check failed with status ${response.status}`)
  return response.json() as Promise<PanelUpdateStatus>
}

export const usePanelSelfUpdate = () => {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['panel-self-update'],
    queryFn: () => getStatus(),
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  })
  const checkNow = async () => {
    const status = await getStatus(true)
    queryClient.setQueryData(['panel-self-update'], status)
    return status
  }
  return { ...query, checkNow }
}
