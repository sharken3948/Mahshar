# Safe listing parameter patterns

Listing `path_parameters` and `query_parameters` may use `pattern`, but Mahshar
does not execute seller-provided JavaScript regular expressions. Patterns use a
deterministic anchored subset supporting literals, `.`, character classes,
`\d`, `\w`, `\s` (and their uppercase negations), and the quantifiers `?`,
`*`, `+`, `{n}`, `{n,m}`, and `{n,}`. Optional leading `^` and trailing `$`
anchors are accepted for compatibility.

Groups, alternation, lookarounds, backreferences, Unicode property escapes,
and malformed or excessively large repetition bounds are rejected. Existing
listings containing unsupported patterns fail closed during authorization; they
must be edited to an equivalent supported pattern or an enum before dynamic
requests can execute. Pattern matching is full-value/anchored.

## Read-only legacy audit

Export only the listing contract fields (`id`, `dynamic_path_supported`,
`path_parameters`, and `query_parameters`) to a local JSON array, then run:

```sh
npx tsx scripts/audit-listing-contracts.mts listings-export.json
```

The command is read-only and never connects to Supabase. It reports listings
that need metadata conversion and exits non-zero when any are unsafe. It does
not modify production data. Legacy listings do not receive a compatibility
fallback: dynamic paths remain disabled unless explicitly enabled, and invalid
or unsafe declarative patterns fail closed at runtime.
