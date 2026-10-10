<template>
  <div>
    <div class="flex justify-between items-center mb-8 mt-3">
      <h1 class="block text-heading-lg">BCF</h1>
    </div>
  </div>
</template>
<script setup lang="ts">
import { graphql } from '~~/lib/common/generated/gql'
import type { ProjectDiscussionsPageHeader_ProjectFragment } from '~~/lib/common/generated/gql/graphql'

graphql(`
  fragment ProjectDiscussionsPageHeader_Project on Project {
    id
    name
  }
`)

defineProps<{
  project: ProjectDiscussionsPageHeader_ProjectFragment
}>()
</script>
