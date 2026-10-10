<template>
  <div>
    <div v-if="project">
      <ProjectPageDiscussionsHeader :project="project" />
      <ProjectPageDiscussionsResults :project="project" />
    </div>
  </div>
</template>
<script setup lang="ts">
import { useQuery } from '@vue/apollo-composable'
import { projectDiscussionsPageQuery } from '~~/lib/projects/graphql/queries'

const route = useRoute()
const projectId = computed(() => route.params.id as string)
const { result } = useQuery(projectDiscussionsPageQuery, () => ({
  projectId: projectId.value
}))

const project = computed(() => result.value?.project)
</script>
