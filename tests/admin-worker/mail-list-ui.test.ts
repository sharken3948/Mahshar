import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OperationsShell } from '../../src/app/admin/operations/operations-shell'
import { PendingEmailsClient, PendingEmailsResults } from '../../src/app/admin/operations/pending-emails/pending-emails-client'

test('Pending Emails uses Operations Automation navigation and identifies the mutation page as Admin only', () => {
  const html = renderToStaticMarkup(createElement(OperationsShell, { children: createElement(PendingEmailsClient) }))
  assert.match(html, /Automation/)
  assert.match(html, /<a[^>]*aria-current="page"[^>]*href="\/admin\/operations\/pending-emails"/)
  assert.match(html, /Admin \/ Pending Emails/)
  assert.match(html, /Admin-only actions/)
  assert.match(html, /Admin only/)
  assert.match(html, /Loading pending emails/)
  assert.doesNotMatch(html, />Read-only</)
})

test('pending table has exactly the three functional columns and escapes database content', () => {
  const html = renderToStaticMarkup(createElement(PendingEmailsResults, {
    data: { items: [{ id: 'one', apiName: '<script>example</script>', emailAddress: 'sales@example.com' }], nextCursor: null },
    loading: false, marking: null, onMark: () => {},
  }))
  assert.equal((html.match(/<th scope=/g) ?? []).length, 3)
  for (const label of ['API Name', 'Email Address', 'Action', 'Mark as Sent']) assert.ok(html.includes(label))
  assert.match(html, /&lt;script&gt;example&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>|<form|mailto:|Approve|Send email|Compose/)
  assert.match(html, /data-label="Email Address"/)
})

test('empty, unavailable, loading and saving states are distinct and safe', () => {
  const render = (data: Parameters<typeof PendingEmailsResults>[0]['data'], loading = false, marking: string | null = null) =>
    renderToStaticMarkup(createElement(PendingEmailsResults, { data, loading, marking, onMark: () => {} }))
  assert.match(render(null, true), /Loading pending emails/)
  assert.match(render(null), /unavailable/)
  assert.match(render({ items: [], nextCursor: null }), /No pending emails/)
  assert.match(render({ items: [{ id: 'one', apiName: 'Example', emailAddress: 'sales@example.com' }], nextCursor: null }, false, 'one'), /disabled=""[^>]*>Saving/)
})
