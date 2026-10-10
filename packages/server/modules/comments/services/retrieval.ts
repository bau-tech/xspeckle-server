import type { Optional } from '@speckle/shared'
import type {
  GetPaginatedBranchCommentsFactory,
  GetPaginatedBranchCommentsPage,
  GetPaginatedBranchCommentsTotalCount,
  GetPaginatedCommitComments,
  GetPaginatedCommitCommentsPage,
  GetPaginatedCommitCommentsTotalCount,
  GetPaginatedProjectComments,
  GetPaginatedProjectCommentsPage,
  GetPaginatedProjectCommentsTotalCount,
  PaginatedBranchCommentsParams,
  PaginatedCommitCommentsParams,
  PaginatedProjectCommentsParams,
  ResolvePaginatedProjectCommentsLatestModelResources
} from '@/modules/comments/domain/operations'
import type { BranchLatestCommit } from '@/modules/core/domain/commits/types'

export const getPaginatedCommitCommentsFactory =
  (deps: {
    getPaginatedCommitCommentsPage: GetPaginatedCommitCommentsPage
    getPaginatedCommitCommentsTotalCount: GetPaginatedCommitCommentsTotalCount
  }): GetPaginatedCommitComments =>
  async (params: PaginatedCommitCommentsParams) => {
    const [result, totalCount] = await Promise.all([
      deps.getPaginatedCommitCommentsPage(params),
      deps.getPaginatedCommitCommentsTotalCount(params)
    ])

    return {
      ...result,
      totalCount
    }
  }

export const getPaginatedBranchCommentsFactory =
  (deps: {
    getPaginatedBranchCommentsPage: GetPaginatedBranchCommentsPage
    getPaginatedBranchCommentsTotalCount: GetPaginatedBranchCommentsTotalCount
  }): GetPaginatedBranchCommentsFactory =>
  async (params: PaginatedBranchCommentsParams) => {
    const [result, totalCount] = await Promise.all([
      deps.getPaginatedBranchCommentsPage(params),
      deps.getPaginatedBranchCommentsTotalCount(params)
    ])

    return {
      ...result,
      totalCount
    }
  }

export const getPaginatedProjectCommentsFactory =
  (deps: {
    resolvePaginatedProjectCommentsLatestModelResources: ResolvePaginatedProjectCommentsLatestModelResources
    getPaginatedProjectCommentsPage: GetPaginatedProjectCommentsPage
    getPaginatedProjectCommentsTotalCount: GetPaginatedProjectCommentsTotalCount
  }): GetPaginatedProjectComments =>
  async (params: PaginatedProjectCommentsParams) => {
    let preloadedModelLatestVersions: Optional<BranchLatestCommit[]> = undefined
    // optimization to ensure we don't request this stuff twice
    if (!params.filter?.allModelVersions && params.filter?.resourceIdString) {
      preloadedModelLatestVersions =
        await deps.resolvePaginatedProjectCommentsLatestModelResources(
          params.filter.resourceIdString
        )
    }

    const [result, totalCount] = await Promise.all([
      deps.getPaginatedProjectCommentsPage(params, { preloadedModelLatestVersions }),
      deps.getPaginatedProjectCommentsTotalCount(params, {
        preloadedModelLatestVersions
      })
    ])

    return {
      ...result,
      totalCount
    }
  }
