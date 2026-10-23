<template>
  <LayoutDialog v-model:open="isOpen" max-width="md" :buttons="dialogButtons">
    <template #header>{{ report?.dryRun ? 'Sync preview' : 'Sync finished' }}</template>
    <div v-if="report" class="flex flex-col gap-4 text-body-xs">
      <p v-if="report.dryRun" class="text-foreground">
        This is what a sync with {{ connection?.name }} would do now. Nothing has been
        changed yet.
      </p>

      <p v-if="!countEntries.length" class="text-foreground">
        {{ report.dryRun ? 'Both sides are already in sync.' : 'Nothing needed changing.' }}
      </p>
      <ul v-else class="flex flex-col gap-1">
        <li v-for="[key, n] in countEntries" :key="key" class="flex justify-between gap-4">
          <span class="text-foreground">{{ bcfOperationLabel(key) }}</span>
          <span class="font-medium">{{ n }}</span>
        </li>
      </ul>

      <CommonAlert v-if="report.conflicts" color="info" size="xs" hide-icon>
        <template #description>
          {{ report.conflicts }} item(s) were changed on both sides; the newer change
          {{ report.dryRun ? 'will win' : 'won' }}.
        </template>
      </CommonAlert>
      <CommonAlert v-if="deletes > 0" color="warning" size="xs" hide-icon>
        <template #description>
          {{ deletes }} topic(s) {{ report.dryRun ? 'will be' : 'were' }} deleted because
          they were deleted on the other side.
        </template>
      </CommonAlert>

      <div v-if="report.skipped.length">
        <p class="font-medium text-foreground mb-1">Skipped</p>
        <ul class="flex flex-col gap-0.5 text-foreground-2">
          <li v-for="s in report.skipped" :key="s.guid">{{ s.title }} — {{ s.reason }}</li>
        </ul>
      </div>

      <div v-if="report.warnings?.length">
        <p class="font-medium text-foreground mb-1">Adjusted for the BCF server</p>
        <ul class="flex flex-col gap-0.5 text-foreground-2">
          <li v-for="(w, i) in report.warnings.slice(0, 20)" :key="i" class="break-words">
            {{ w }}
          </li>
        </ul>
      </div>

      <div v-if="report.failed?.length">
        <p class="font-medium text-danger mb-1">Failed (retried on the next sync)</p>
        <ul class="flex flex-col gap-0.5 text-foreground-2">
          <li v-for="(f, i) in report.failed.slice(0, 20)" :key="i" class="break-words">
            {{ f.kind }} {{ f.action }}: {{ f.error }}
          </li>
        </ul>
      </div>

      <LayoutDisclosure
        v-if="topicOps.length"
        :title="`Topics (${topicOps.length})`"
      >
        <ul class="flex flex-col gap-0.5 max-h-64 overflow-y-auto simple-scrollbar">
          <li v-for="op in topicOps.slice(0, 200)" :key="op.guid" class="flex gap-2">
            <span class="text-foreground-2 shrink-0 w-44">
              {{ bcfOperationLabel(`topic ${op.action}`).replace(/^Topics /, '') }}
            </span>
            <span class="truncate">
              {{ op.title || op.guid }}
              <span v-if="op.conflict" class="text-foreground-2">(conflict)</span>
              <span v-if="op.restore" class="text-foreground-2">(restored)</span>
            </span>
          </li>
        </ul>
      </LayoutDisclosure>

      <FormCheckbox
        v-if="report.dryRun && deletes > 5"
        v-model="allowMassDelete"
        name="bcfAllowMassDelete"
        label="Yes, delete these topics"
        description="Needed when a sync would delete more than half of the synced topics."
      />
    </div>
  </LayoutDialog>
</template>
<script setup lang="ts">
import { LayoutDialog, LayoutDisclosure, type LayoutDialogButton } from '@speckle/ui-components'
import {
  bcfOperationLabel,
  type BcfConnection,
  type BcfSyncReport
} from '~~/lib/projects/composables/bcfServers'

const props = defineProps<{
  report: BcfSyncReport | null
  connection: BcfConnection | null
  busy: boolean
}>()
const emit = defineEmits<{
  (e: 'apply', opts: { activate: boolean; allowMassDelete: boolean }): void
}>()

const isOpen = defineModel<boolean>('open', { required: true })
const allowMassDelete = ref(false)

watch(isOpen, (open) => {
  if (open) allowMassDelete.value = false
})

const countEntries = computed(() => Object.entries(props.report?.counts || {}))
const topicOps = computed(() => (props.report?.operations || []).filter((o) => o.kind === 'topic'))
const deletes = computed(
  () =>
    (props.report?.counts['topic delete-local'] || 0) +
    (props.report?.counts['topic delete-remote'] || 0)
)

const dialogButtons = computed((): LayoutDialogButton[] => {
  const close: LayoutDialogButton = {
    text: 'Close',
    props: { color: 'outline' },
    onClick: () => (isOpen.value = false)
  }
  if (!props.report?.dryRun) return [close]
  const active = props.connection?.status === 'active'
  return [
    close,
    {
      text: active ? 'Sync now' : 'Start syncing',
      props: { disabled: props.busy, loading: props.busy },
      onClick: () => {
        isOpen.value = false
        emit('apply', { activate: !active, allowMassDelete: allowMassDelete.value })
      }
    }
  ]
})
</script>
