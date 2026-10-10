import type {
  CommentCreatedActivityInput,
  ReplyCreatedActivityInput
} from '@/modules/activitystream/domain/types'
import type { ViewerResourceItem } from '@/modules/viewer/domain/types/resources'
import type { CommentRecord } from '@/modules/comments/helpers/types'

export const commentEventsNamespace = 'comments' as const

export const CommentEvents = {
  Created: `${commentEventsNamespace}.created`,
  Updated: `${commentEventsNamespace}.updated`,
  /** A Topic (with all its comments) or a single Comment was deleted. */
  Deleted: `${commentEventsNamespace}.deleted`
} as const

export type CommentEventsPayloads = {
  [CommentEvents.Created]: {
    comment: CommentRecord
    isThread: boolean
    input: CommentCreatedActivityInput | ReplyCreatedActivityInput
    resourceItems: ViewerResourceItem[]
  }
  [CommentEvents.Updated]: {
    previousComment: CommentRecord
    newComment: CommentRecord
    /** Who made the change, when known (not necessarily the author). */
    userId?: string
  }
  [CommentEvents.Deleted]: {
    comment: CommentRecord
    userId?: string
  }
}
