import { defineStore } from 'pinia'
import { ref } from 'vue'

export type JobsScope = 'all' | 'client' | 'server'

export const useJobsStore = defineStore('jobs-ui', () => {
  const scope = ref<JobsScope>('all')
  const openFor = (value: Exclude<JobsScope, 'all'>) => { scope.value = value }
  return { scope, openFor }
})
