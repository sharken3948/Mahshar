import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'node:test'
import { QualificationLabel } from '../../src/app/admin/worker/qualification-label'

function render(status: 'qualified' | 'review_candidate') {
  return renderToStaticMarkup(createElement(QualificationLabel, { status, reasonCodes: [] }))
}

test('empty qualification reasons preserve the actual qualified or review-candidate label', () => {
  const review = render('review_candidate')
  assert.match(review, /Review candidate/)
  assert.doesNotMatch(review, /Qualified/)

  const qualified = render('qualified')
  assert.match(qualified, /Qualified/)
  assert.doesNotMatch(qualified, /Review candidate/)
})
