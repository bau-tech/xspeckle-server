import gql from 'graphql-tag'

export const basicProjectTopicFragment = gql`
  fragment BasicProjectTopic on Topic {
    id
    rawText
    text {
      doc
    }
    authorId
    title
    topicType
    topicStatus
    priority
    stage
    labels
    dueDate
    assignedTo
    index
    serverAssignedId
  }
`

export const basicProjectCommentFragment = gql`
  fragment BasicProjectComment on Comment {
    id
    rawComment
    comment {
      doc
    }
    authorId
    topicId
  }
`

export const createProjectTopicMutation = gql`
  mutation CreateProjectTopic($input: CreateTopicInput!) {
    topicMutations {
      create(input: $input) {
        ...BasicProjectTopic
      }
    }
  }

  ${basicProjectTopicFragment}
`

export const createProjectCommentMutation = gql`
  mutation CreateProjectComment($input: CreateCommentInput!) {
    topicMutations {
      comment(input: $input) {
        ...BasicProjectComment
      }
    }
  }

  ${basicProjectCommentFragment}
`

export const updateProjectTopicMutation = gql`
  mutation UpdateProjectTopic($input: UpdateTopicInput!) {
    topicMutations {
      update(input: $input) {
        ...BasicProjectTopic
      }
    }
  }

  ${basicProjectTopicFragment}
`

export const updateProjectCommentMutation = gql`
  mutation UpdateProjectComment($input: UpdateCommentInput!) {
    topicMutations {
      updateComment(input: $input) {
        ...BasicProjectComment
      }
    }
  }

  ${basicProjectCommentFragment}
`
