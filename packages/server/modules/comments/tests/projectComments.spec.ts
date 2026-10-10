import { CommentEvents } from '@/modules/comments/domain/events'
import { commentTextToRawString } from '@/modules/comments/services/commentTextService'
import { getEventBus } from '@/modules/shared/services/eventBus'
import type { BasicTestUser } from '@/test/authHelper'
import { createTestUsers } from '@/test/authHelper'
import type {
  CreateCommentInput,
  CreateTopicInput,
  UpdateCommentInput,
  UpdateTopicInput
} from '@/modules/core/graph/generated/graphql'
import {
  CreateProjectCommentDocument,
  CreateProjectTopicDocument,
  UpdateProjectCommentDocument,
  UpdateProjectTopicDocument
} from '@/modules/core/graph/generated/graphql'
import type { ExecuteOperationOptions, TestApolloServer } from '@/test/graphqlHelper'
import { testApolloServer } from '@/test/graphqlHelper'
import { beforeEachContext } from '@/test/hooks'
import type { BasicTestBranch } from '@/test/speckle-helpers/branchHelper'
import { createTestBranches } from '@/test/speckle-helpers/branchHelper'
import type { BasicTestCommit } from '@/test/speckle-helpers/commitHelper'
import { createTestCommits } from '@/test/speckle-helpers/commitHelper'
import type { BasicTestStream } from '@/test/speckle-helpers/streamHelper'
import { createTestStreams } from '@/test/speckle-helpers/streamHelper'
import { SpeckleViewer, TIME_MS } from '@speckle/shared'
import { RichTextEditor } from '@speckle/shared'
import { expect } from 'chai'

const resourceUrlBuilder = SpeckleViewer.ViewerRoute.resourceBuilder

describe('Project Comments', () => {
  const me: BasicTestUser = {
    name: 'hello itsa me',
    email: '',
    id: ''
  }
  const myStream: BasicTestStream = {
    name: 'this is my great stream #1',
    isPublic: true,
    ownerId: '',
    id: ''
  }
  const myBranch: BasicTestBranch = {
    name: 'nice branch!!',
    streamId: '',
    id: '',
    authorId: ''
  }
  const myCommit: BasicTestCommit = {
    id: '',
    objectId: '',
    streamId: '',
    authorId: '',
    branchId: '',
    message: 'this is my nice commit :)))',
    branchName: myBranch.name
  }

  before(async () => {
    await beforeEachContext()
    await createTestUsers([me])
    await createTestStreams([[myStream, me]])
    await createTestBranches([{ branch: myBranch, stream: myStream, owner: me }])
    await createTestCommits([myCommit], { stream: myStream, owner: me })
  })

  describe('in GraphQL API', () => {
    let apollo: TestApolloServer

    before(async () => {
      apollo = await testApolloServer({
        authUserId: me.id
      })
    })

    const createProjectTopic = async (
      input: CreateTopicInput,
      options?: ExecuteOperationOptions
    ) => await apollo.execute(CreateProjectTopicDocument, { input }, options)

    const createProjectComment = async (input: CreateCommentInput) =>
      await apollo.execute(CreateProjectCommentDocument, { input })

    const updateProjectTopic = async (input: UpdateTopicInput) =>
      await apollo.execute(UpdateProjectTopicDocument, { input })

    const updateProjectComment = async (input: UpdateCommentInput) =>
      await apollo.execute(UpdateProjectCommentDocument, { input })

    it('can be created with full BCF topic fields and commented on', async () => {
      const parentText = 'hello world111'

      let createEventFired = false
      getEventBus().listenOnce(
        CommentEvents.Created,
        ({ payload }) => {
          expect(commentTextToRawString(payload.comment.text)).to.equal(parentText)
          createEventFired = true
        },
        { timeout: TIME_MS.second }
      )

      const threadInput: CreateTopicInput = {
        projectId: myStream.id,
        resourceIdString: resourceUrlBuilder()
          .addModel(myBranch.id, myCommit.id)
          .toString(),
        content: {
          doc: RichTextEditor.convertBasicStringToDocument(parentText)
        },
        title: 'A real title',
        topicType: 'Issue',
        topicStatus: 'Open',
        priority: 'Normal',
        stage: 'Design',
        labels: ['clash', 'urgent'],
        assignedTo: 'someone@example.org'
      }

      const res1 = await createProjectTopic(threadInput)
      const topicId = res1.data?.topicMutations.create.id

      expect(res1).to.not.haveGraphQLErrors()
      expect(topicId).to.be.ok
      expect(res1.data?.topicMutations.create.rawText).to.equal(parentText)
      expect(res1.data?.topicMutations.create.text?.doc).to.be.ok
      expect(res1.data?.topicMutations.create.authorId).to.equal(me.id)
      expect(res1.data?.topicMutations.create.title).to.equal('A real title')
      expect(res1.data?.topicMutations.create.topicType).to.equal('Issue')
      expect(res1.data?.topicMutations.create.topicStatus).to.equal('Open')
      expect(res1.data?.topicMutations.create.priority).to.equal('Normal')
      expect(res1.data?.topicMutations.create.stage).to.equal('Design')
      expect(res1.data?.topicMutations.create.labels).to.deep.equal(['clash', 'urgent'])
      expect(res1.data?.topicMutations.create.assignedTo).to.equal(
        'someone@example.org'
      )
      expect(res1.data?.topicMutations.create.index).to.be.greaterThan(0)
      expect(res1.data?.topicMutations.create.serverAssignedId).to.equal(
        String(res1.data?.topicMutations.create.index)
      )
      expect(createEventFired).to.be.true
    })

    it('can be created with no BCF fields, resolving sensible empty defaults', async () => {
      const res = await createProjectTopic({
        projectId: myStream.id,
        resourceIdString: resourceUrlBuilder()
          .addModel(myBranch.id, myCommit.id)
          .toString(),
        content: {
          doc: RichTextEditor.convertBasicStringToDocument('bare topic')
        }
      })

      expect(res).to.not.haveGraphQLErrors()
      expect(res.data?.topicMutations.create.title).to.be.null
      expect(res.data?.topicMutations.create.topicStatus).to.be.null
      expect(res.data?.topicMutations.create.labels).to.deep.equal([])
    })

    describe('after creation', async () => {
      let topicId: string

      before(async () => {
        const res = await createProjectTopic(
          {
            projectId: myStream.id,
            resourceIdString: resourceUrlBuilder()
              .addModel(myBranch.id, myCommit.id)
              .toString(),
            content: {
              doc: RichTextEditor.convertBasicStringToDocument('some rando text lol')
            }
          },
          { assertNoErrors: true }
        )
        expect(res.data?.topicMutations.create.id).to.be.ok
        topicId = res.data!.topicMutations.create.id
      })

      it('can be commented on', async () => {
        const commentText = 'hello again bozo222'
        let commentEventFired = false
        getEventBus().listenOnce(
          CommentEvents.Created,
          ({ payload }) => {
            expect(commentTextToRawString(payload.comment.text)).to.equal(commentText)
            expect(payload.comment.parentComment).to.equal(topicId)
            commentEventFired = true
          },
          { timeout: TIME_MS.second }
        )

        const commentInput: CreateCommentInput = {
          projectId: myStream.id,
          topicId: topicId!,
          content: {
            doc: RichTextEditor.convertBasicStringToDocument(commentText)
          }
        }
        const res2 = await createProjectComment(commentInput)

        expect(res2).to.not.haveGraphQLErrors()
        expect(res2.data?.topicMutations.comment.rawComment).to.equal(commentText)
        expect(res2.data?.topicMutations.comment.comment?.doc).to.be.ok
        expect(res2.data?.topicMutations.comment.authorId).to.equal(me.id)
        expect(res2.data?.topicMutations.comment.topicId).to.equal(topicId)
        expect(commentEventFired).to.be.true
      })

      it('can be updated (topic content + BCF fields)', async () => {
        const newText = 'new text here!!!'
        let editEventFired = false

        getEventBus().listenOnce(
          CommentEvents.Updated,
          ({ payload }) => {
            expect(commentTextToRawString(payload.newComment.text)).to.equal(newText)
            expect(payload.newComment.id).to.equal(topicId)
            editEventFired = true
          },
          { timeout: TIME_MS.second }
        )

        const res = await updateProjectTopic({
          topicId,
          content: {
            doc: RichTextEditor.convertBasicStringToDocument(newText)
          },
          projectId: myStream.id,
          topicStatus: 'Closed',
          labels: ['resolved']
        })

        expect(res).to.not.haveGraphQLErrors()
        expect(res.data?.topicMutations.update.rawText).to.equal(newText)
        expect(res.data?.topicMutations.update.text?.doc).to.be.ok
        expect(res.data?.topicMutations.update.authorId).to.equal(me.id)
        expect(res.data?.topicMutations.update.topicStatus).to.equal('Closed')
        expect(res.data?.topicMutations.update.labels).to.deep.equal(['resolved'])
        expect(editEventFired).to.be.true
      })

      it('updateComment only ever touches comment content, never topic fields', async () => {
        const commentRes = await createProjectComment({
          projectId: myStream.id,
          topicId,
          content: {
            doc: RichTextEditor.convertBasicStringToDocument('a comment to edit')
          }
        })
        const commentId = commentRes.data!.topicMutations.comment.id

        const newCommentText = 'edited comment text'
        const res = await updateProjectComment({
          commentId,
          projectId: myStream.id,
          content: {
            doc: RichTextEditor.convertBasicStringToDocument(newCommentText)
          }
        })

        expect(res).to.not.haveGraphQLErrors()
        expect(res.data?.topicMutations.updateComment.rawComment).to.equal(
          newCommentText
        )
      })
    })
  })
})
