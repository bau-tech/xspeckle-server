<template>
  <FormSelectBase
    :model-value="modelValue ?? undefined"
    :items="items"
    :label="label"
    :name="name"
    :placeholder="placeholder ?? label"
    :allow-unset="true"
    clearable
    :search="search"
    :filter-predicate="search ? matches : undefined"
    @update:model-value="(v) => emit('update:modelValue', (v as string) || null)"
  >
    <template #something-selected="{ value }">
      <span class="truncate">{{ value }}</span>
    </template>
    <template #option="{ item }">
      <span class="truncate">{{ item }}</span>
    </template>
  </FormSelectBase>
</template>
<script setup lang="ts">
import type { Nullable } from '@speckle/shared'

defineProps<{
  modelValue: Nullable<string>
  items: string[]
  label: string
  name: string
  placeholder?: string
  /** A search box, for long lists (e.g. users). */
  search?: boolean
}>()

const matches = (item: string, query: string) =>
  item.toLowerCase().includes(query.toLowerCase())

const emit = defineEmits<{
  (e: 'update:modelValue', v: Nullable<string>): void
}>()
</script>
