import { expect } from 'chai'
import { safeReturnPath } from '@/modules/bcfsync/services/connections'

describe('BCF sync return path after signing in', () => {
  it('keeps paths on this site', () => {
    expect(safeReturnPath('/projects/p1/models/m1')).to.equal('/projects/p1/models/m1')
    expect(safeReturnPath('/projects/p1/models/m1?a=1#x')).to.equal('/projects/p1/models/m1?a=1#x')
  })

  for (const bad of [
    'https://evil.example/x',
    '//evil.example/x',
    '/\\evil.example',
    'projects/p1',
    '/projects/p1 x',
    '/x\n',
    '/' + 'a'.repeat(1000),
    undefined,
    42
  ])
    it(`rejects ${JSON.stringify(bad)?.slice(0, 30)}`, () => {
      expect(safeReturnPath(bad)).to.equal(null)
    })
})
