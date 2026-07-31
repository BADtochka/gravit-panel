<script setup lang="ts">
import { registerJobNotification } from '@/stores/job-notifications'
import type { JobRecord } from '@gravit-panel/shared'
import { watch } from 'vue'

const props = defineProps<{ job: JobRecord | null; title?: string }>()
const emit = defineEmits<{ finished: [job: JobRecord] }>()

watch(
  () => props.job,
  (job, _previous, onCleanup) => {
    if (!job) return
    const unregister = registerJobNotification(
      job,
      props.title ?? 'Job',
      (finishedJob) => emit('finished', finishedJob),
    )
    onCleanup(unregister)
  },
  { immediate: true },
)
</script>
