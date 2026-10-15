"""Daily continuation quota change only; executed against disposable PostgreSQL."""
quota_tables = json.loads(sql("""SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public'
 AND (tablename LIKE 'worker_%' OR tablename LIKE 'admin_acquisition_%' OR tablename LIKE 'admin_outreach_%');"""))
quota_history = {t: sql(f"SELECT md5(coalesce(string_agg(to_jsonb(r)::text,'' ORDER BY to_jsonb(r)::text),'')) FROM {t} r;") for t in quota_tables}
quota_functions = json.loads(sql("""SELECT jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid))
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
 AND (p.proname LIKE 'mahshar_worker_%' OR p.proname LIKE 'mahshar_acquisition_%' OR p.proname LIKE 'mahshar_admin_outreach_%');"""))
sql('BEGIN;\n' + DAILY_RUN_LIMIT.read_text() + '\nCOMMIT;')
for table, snapshot in quota_history.items():
    assert sql(f"SELECT md5(coalesce(string_agg(to_jsonb(r)::text,'' ORDER BY to_jsonb(r)::text),'')) FROM {table} r;") == snapshot, table
for signature, definition in quota_functions.items():
    expected = definition.replace('>=6', '>=20').replace('>= 6', '>= 20') if signature == 'mahshar_acquisition_create_next_run(uuid,uuid)' else definition
    actual = sql(f"SELECT pg_get_functiondef('{signature}'::regprocedure);")
    assert actual == expected.strip(), signature
for role in ['anon', 'authenticated']:
    assert sql(f"SELECT has_function_privilege('{role}','public.mahshar_acquisition_create_next_run(uuid,uuid)','EXECUTE');") == 'f'
assert sql("SELECT has_function_privilege('service_role','public.mahshar_acquisition_create_next_run(uuid,uuid)','EXECUTE');") == 't'

# Keep old fixtures, outside today's usage. No applied migration updates data.
sql("""UPDATE worker_runs SET status='stopped',created_at=date_trunc('day',clock_timestamp(),'UTC')-interval '1 hour';
 UPDATE worker_control SET desired_state='stopped';
 UPDATE admin_acquisition_control SET desired_state='running',epoch=gen_random_uuid(),operating_mode='continuous',continuation_run_id=NULL;""")
quota_epoch = sql('SELECT epoch FROM admin_acquisition_control;')
def quota_parent():
    return sql("""WITH identity AS (SELECT gen_random_uuid() AS id)
      INSERT INTO worker_runs(id,discovery_batch_id,deadline_at,status,batch_size,processed_count,checkpoint,completion_reason)
      SELECT id,id,clock_timestamp()+interval '15 minutes','completed',50,50,'{"version":1,"nextIndex":50,"batchSize":50}'::jsonb,'source_exhausted'
      FROM identity RETURNING id;""")
def quota_count():
    return int(sql("SET ROLE service_role; SELECT (mahshar_acquisition_metrics()->>'daily_runs')::int;"))
def quota_complete(run_id):
    sql(f"""UPDATE worker_runs SET status='completed',processed_count=batch_size,source_cursor=batch_size,
      checkpoint=jsonb_build_object('version',1,'nextIndex',batch_size,'batchSize',batch_size),completion_reason='source_exhausted'
      WHERE id='{run_id}'; UPDATE worker_control SET desired_state='stopped'; UPDATE admin_acquisition_control SET continuation_run_id=NULL;""")
def quota_child(parent):
    value = sql(f"SET ROLE service_role; SELECT row_to_json(r) FROM mahshar_acquisition_create_next_run('{quota_epoch}','{parent}') r WHERE r.id IS NOT NULL;")
    return json.loads(value) if value and value != 'null' else None
quota_parents = [quota_parent() for _ in range(6)]
assert quota_count() == 6
quota_seventh = quota_child(quota_parents[0]); assert quota_seventh and quota_count() == 7
assert quota_child(quota_parents[0])['id'] == quota_seventh['id'] and quota_count() == 7
quota_complete(quota_seventh['id'])
quota_parents += [quota_parent() for _ in range(12)]
assert quota_count() == 19
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    quota_race = list(pool.map(quota_child, quota_parents[1:3]))
quota_created = [r for r in quota_race if r and r.get('id')]
assert len(quota_created) == 1 and quota_count() == 20
quota_twentieth = quota_created[0]
assert quota_child(quota_twentieth['acquisition_parent_run_id'])['id'] == quota_twentieth['id']
quota_complete(quota_twentieth['id'])
quota_controls = sql('SELECT row_to_json(c) FROM admin_acquisition_control c;')
assert not quota_child(quota_parents[3]) and quota_count() == 20
assert sql('SELECT row_to_json(c) FROM admin_acquisition_control c;') == quota_controls
for zone in ['Pacific/Honolulu', 'Pacific/Kiritimati']:
    assert sql(f"SET ROLE service_role; SET TIME ZONE '{zone}'; SELECT mahshar_acquisition_metrics()->>'daily_runs';") == '20'
# Old UTC-day runs remain in history and do not consume the new day's quota.
sql("UPDATE worker_runs SET created_at=date_trunc('day',clock_timestamp(),'UTC')-interval '1 millisecond';")
assert quota_count() == 0
assert quota_child(quota_parents[4]) and quota_count() == 1
print('PASS: daily run migration preserves all history, controls, other functions/budgets and ACLs; six-to-seven, nineteen-to-twenty, concurrent cap, quota wait, parent replay and UTC-day reset')
