import { graphql } from '~/lib/common/generated/gql'

export const markUserNotificationsReadMutation = graphql(`
  mutation MarkUserNotificationsRead($ids: [String!]!) {
    activeUserMutations {
      notifications {
        markRead(ids: $ids)
      }
    }
  }
`)

export const markAllUserNotificationsReadMutation = graphql(`
  mutation MarkAllUserNotificationsRead {
    activeUserMutations {
      notifications {
        markAllRead
      }
    }
  }
`)

export const clearReadUserNotificationsMutation = graphql(`
  mutation ClearReadUserNotifications {
    activeUserMutations {
      notifications {
        clearRead
      }
    }
  }
`)
