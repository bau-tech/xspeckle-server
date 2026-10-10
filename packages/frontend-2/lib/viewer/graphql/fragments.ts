import { graphql } from '~~/lib/common/generated/gql'

export const viewerCommentThreadFragment = graphql(`
  fragment ViewerCommentThread on Topic {
    ...ViewerCommentsListItem
    ...ViewerCommentBubblesData
    ...ViewerCommentThreadData
    text {
      doc
      attachments {
        id
        fileName
        fileType
        fileSize
      }
    }
  }
`)

export const viewerReplyFragment = graphql(`
  fragment ViewerCommentsReplyItem on Comment {
    id
    rawComment
    comment {
      doc
    }
    author {
      ...LimitedUserAvatar
    }
    createdAt
    ...ThreadCommentAttachment
  }
`)
