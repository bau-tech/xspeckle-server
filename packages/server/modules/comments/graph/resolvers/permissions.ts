import type { Resolvers } from '@/modules/core/graph/generated/graphql'
import { Authz } from '@speckle/shared'

export default {
  Topic: {
    permissions: async (parent) => ({
      commentId: parent.id,
      projectId: parent.streamId
    })
  },
  Comment: {
    permissions: async (parent) => ({
      commentId: parent.id,
      projectId: parent.streamId
    })
  },
  CommentPermissionChecks: {
    canEdit: async (parent, _args, ctx) => {
      const canEdit = await ctx.authPolicies.project.comment.canEdit({
        ...parent,
        userId: ctx.userId
      })
      return Authz.toGraphqlResult(canEdit)
    }
  },
  ProjectPermissionChecks: {
    canCreateComment: async (parent, _args, ctx) => {
      const canCreateComment = await ctx.authPolicies.project.comment.canCreate({
        ...parent,
        userId: ctx.userId
      })
      return Authz.toGraphqlResult(canCreateComment)
    },
    canBroadcastActivity: async (parent, _args, ctx) => {
      const canBroadcastActivity = await ctx.authPolicies.project.canBroadcastActivity({
        ...parent,
        userId: ctx.userId
      })
      return Authz.toGraphqlResult(canBroadcastActivity)
    }
  }
} as Resolvers
