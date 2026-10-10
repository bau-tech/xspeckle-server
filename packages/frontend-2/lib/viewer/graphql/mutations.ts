import { graphql } from '~~/lib/common/generated/gql'

export const broadcastViewerUserActivityMutation = graphql(`
  mutation BroadcastViewerUserActivity(
    $projectId: String!
    $resourceIdString: String!
    $message: ViewerUserActivityMessageInput!
  ) {
    broadcastViewerUserActivity(
      projectId: $projectId
      resourceIdString: $resourceIdString
      message: $message
    )
  }
`)

export const markCommentViewedMutation = graphql(`
  mutation MarkCommentViewed($input: MarkTopicViewedInput!) {
    topicMutations {
      markViewed(input: $input)
    }
  }
`)

export const createCommentThreadMutation = graphql(`
  mutation CreateCommentThread($input: CreateTopicInput!) {
    topicMutations {
      create(input: $input) {
        ...ViewerCommentThread
      }
    }
  }
`)

export const createCommentReplyMutation = graphql(`
  mutation CreateCommentReply($input: CreateCommentInput!) {
    topicMutations {
      comment(input: $input) {
        ...ViewerCommentsReplyItem
      }
    }
  }
`)

export const updateTopicMutation = graphql(`
  mutation UpdateTopic($input: UpdateTopicInput!) {
    topicMutations {
      update(input: $input) {
        ...ViewerCommentThread
      }
    }
  }
`)

export const createViewpointMutation = graphql(`
  mutation CreateViewpoint($input: CreateViewpointInput!) {
    topicMutations {
      createViewpoint(input: $input) {
        id
        guid
        snapshot
        viewerState
      }
    }
  }
`)
