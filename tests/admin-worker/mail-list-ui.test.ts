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

test('pending table starts with No. and preserves the functional columns and escaped database content', () => {
  const html = renderToStaticMarkup(createElement(PendingEmailsResults, {
    data: { items: [{ id: 'one', apiName: '<script>example</script>', emailAddress: 'sales@example.com' }], nextCursor: null },
    page: 1, loading: false, marking: null, onMark: () => {},
  }))
  assert.equal((html.match(/<th scope=/g) ?? []).length, 4)
  assert.match(html, /<thead><tr><th scope="col">No\.<\/th><th scope="col">API Name/)
  for (const label of ['API Name', 'Email Address', 'Action', 'Mark as Sent']) assert.ok(html.includes(label))
  assert.match(html, /&lt;script&gt;example&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>|<form|mailto:|Approve|Send email|Compose/)
  assert.match(html, /data-label="Email Address"/)
  assert.match(html, /data-label="No\."><span>1<\/span>/)
})

test('row numbers continue across full and partial pages and refresh from the current row positions', () => {
  const items = Array.from({ length: 25 }, (_, index) => ({
    id: `entry-${index}`, apiName: `Example ${index}`, emailAddress: `sales${index}@example.com`,
  }))
  const numbers = (page: number, entries = items, loading = false) => {
    const html = renderToStaticMarkup(createElement(PendingEmailsResults, {
      data: { items: entries, nextCursor: 'next-page' }, page, loading, marking: null, onMark: () => {},
    }))
    return [...html.matchAll(/data-label="No\."><span>(\d+)<\/span>/g)].map(match => Number(match[1]))
  }
  for (const page of [1, 2, 3]) {
    assert.deepEqual(numbers(page), Array.from({ length: 25 }, (_, index) => (page - 1) * 25 + index + 1))
  }
  assert.deepEqual(numbers(3, items.slice(0, 3)), [51, 52, 53])
  assert.deepEqual(numbers(2, items, true), numbers(2))
  const refreshedItems = items.filter(item => item.id !== 'entry-2')
  assert.deepEqual(numbers(1, refreshedItems), Array.from({ length: 24 }, (_, index) => index + 1))
  assert.deepEqual(numbers(2, refreshedItems), Array.from({ length: 24 }, (_, index) => index + 26))
})

test('empty, unavailable, loading and saving states are distinct and safe', () => {
  const render = (data: Parameters<typeof PendingEmailsResults>[0]['data'], loading = false, marking: string | null = null) =>
    renderToStaticMarkup(createElement(PendingEmailsResults, { data, page: 1, loading, marking, onMark: () => {} }))
  assert.match(render(null, true), /Loading pending emails/)
  assert.match(render(null), /unavailable/)
  assert.match(render({ items: [], nextCursor: null }), /No pending emails/)
  assert.match(render({ items: [{ id: 'one', apiName: 'Example', emailAddress: 'sales@example.com' }], nextCursor: null }, false, 'one'), /disabled=""[^>]*>Saving/)
})
