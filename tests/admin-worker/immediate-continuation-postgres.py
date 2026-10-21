"""Runs after all 50 Production migrations in the disposable multi-source harness."""
timing_migration = ROOT / 'supabase/migrations/20261019000200_admin_worker_immediate_continuation.sql'
assert len([p for p in (ROOT / 'supabase/migrations').glob('*.sql') if p.name.split('_')[0] <= timing_migration.name.split('_')[0]]) == 51
before_timing = snapshots()
old_mail_recovery = sql("SELECT pg_get_functiondef('public.mahshar_worker_mail_recover(uuid,integer)'::regprocedure);")
old_source_update = sql("SELECT pg_get_functiondef('public.mahshar_worker_discovery_source_update(uuid,text,bigint,jsonb)'::regprocedure);")
failure('BEGIN;\n' + timing_migration.read_text() + "\nDO $$ BEGIN RAISE EXCEPTION 'rollback_timing'; END $$; COMMIT;", 'rollback_timing')
assert snapshots() == before_timing
sql('BEGIN;\n' + timing_migration.read_text() + '\nCOMMIT;')
assert snapshots() == before_timing
assert sql("SELECT pg_get_functiondef('public.mahshar_worker_mail_recover(uuid,integer)'::regprocedure);") == old_mail_recovery
assert sql("SELECT pg_get_functiondef('public.mahshar_worker_discovery_source_update(uuid,text,bigint,jsonb)'::regprocedure);") == old_source_update
assert sql("SELECT count(*) FROM worker_discovery_sources;") == '8'
for role in ['anon', 'authenticated']:
    assert sql(f"SELECT has_function_privilege('{role}','public.mahshar_worker_create_target_run(boolean)','EXECUTE');") == 'f'
    assert sql(f"SELECT has_function_privilege('{role}','public.mahshar_acquisition_create_next_run(uuid,uuid)','EXECUTE');") == 'f'

# The existing Resume path retains its original deadline; only a fresh run gets an hour.
timing_run = start_run()
assert 3500 <= float(sql(f"SELECT extract(epoch FROM deadline_at-clock_timestamp()) FROM worker_runs WHERE id='{timing_run}';")) <= 3600
stop_run(timing_run)
old_deadline = sql(f"SELECT deadline_at FROM worker_runs WHERE id='{timing_run}';")
assert snapshots() != before_timing  # Only the explicit test run changed history.

def timing_parent(processed=10, reason='source_exhausted'):
    return sql(f"""WITH identity AS (SELECT gen_random_uuid() AS id)
      INSERT INTO worker_runs(id,discovery_batch_id,deadline_at,status,batch_size,processed_count,
        source_cursor,checkpoint,completion_reason,created_at)
      SELECT id,id,clock_timestamp()+interval '15 minutes','completed',300,{processed},{processed},
        jsonb_build_object('version',1,'nextIndex',{processed},'batchSize',300),'{reason}',
        clock_timestamp()-interval '1 day' FROM identity RETURNING id;""")

# Earlier regression fixtures have intentionally created more than twenty runs today.
sql("UPDATE worker_runs SET created_at=date_trunc('day',clock_timestamp(),'UTC')-interval '1 day';")
parent = timing_parent()
sql("UPDATE admin_acquisition_control SET desired_state='running',operating_mode='continuous',epoch=gen_random_uuid(),continuation_run_id=NULL WHERE id=1;")
epoch = sql('SELECT epoch FROM admin_acquisition_control WHERE id=1;')
def continuation(run_id):
    return data(f"mahshar_acquisition_create_next_run('{epoch}','{run_id}')")

child = continuation(parent)
assert child and child['acquisition_parent_run_id'] == parent
assert 3500 <= float(sql(f"SELECT extract(epoch FROM deadline_at-clock_timestamp()) FROM worker_runs WHERE id='{child['id']}';")) <= 3600
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    replays = list(pool.map(lambda _: continuation(parent), range(2)))
assert all(value['id'] == child['id'] for value in replays)
assert sql(f"SELECT count(*) FROM worker_runs WHERE acquisition_parent_run_id='{parent}';") == '1'
assert sql(f"SELECT deadline_at FROM worker_runs WHERE id='{timing_run}';") == old_deadline

# An empty completed child closes the epoch in the same transaction, with no retry loop.
sql(f"""UPDATE worker_runs SET status='completed',completion_reason='source_exhausted',source_exhausted=true,
  checkpoint='{{"version":1,"nextIndex":0,"batchSize":300}}'::jsonb WHERE id='{child['id']}';
  UPDATE worker_control SET desired_state='stopped' WHERE id=1;""")
assert continuation(child['id']) is None
assert sql('SELECT desired_state FROM admin_acquisition_control WHERE id=1;') == 'stopped'
assert sql(f"SELECT count(*) FROM worker_runs WHERE acquisition_parent_run_id='{child['id']}';") == '0'

# An exhausted per-run budget with no progress is also a visible stop, not a tight retry.
sql("UPDATE admin_acquisition_control SET desired_state='running',epoch=gen_random_uuid(),continuation_run_id=NULL WHERE id=1;")
epoch = sql('SELECT epoch FROM admin_acquisition_control WHERE id=1;')
budget_parent = timing_parent(0, 'hard_limit_reached')
assert continuation(budget_parent) is None
assert sql('SELECT desired_state FROM admin_acquisition_control WHERE id=1;') == 'stopped'
assert sql(f"SELECT count(*) FROM worker_runs WHERE acquisition_parent_run_id='{budget_parent}';") == '0'

# Stop between runs is fenced by the epoch; Stop while a child is active blocks its successor.
sql("UPDATE admin_acquisition_control SET desired_state='running',epoch=gen_random_uuid(),continuation_run_id=NULL WHERE id=1;")
epoch = sql('SELECT epoch FROM admin_acquisition_control WHERE id=1;')
stopped_parent = timing_parent()
data('mahshar_acquisition_set_state(false)')
assert continuation(stopped_parent) is None
assert sql(f"SELECT count(*) FROM worker_runs WHERE acquisition_parent_run_id='{stopped_parent}';") == '0'

# The twentieth UTC run is retained, and the next attempt stops visibly without creating a run.
sql("UPDATE worker_runs SET created_at=date_trunc('day',clock_timestamp(),'UTC')-interval '1 day';")
quota_parent = timing_parent()
sql(f"UPDATE worker_runs SET created_at=clock_timestamp() WHERE id='{quota_parent}';")
sql("""WITH ids AS (SELECT gen_random_uuid() AS id FROM generate_series(1,19))
  INSERT INTO worker_runs(id,discovery_batch_id,deadline_at,status,batch_size,processed_count,
    checkpoint,completion_reason)
  SELECT id,id,clock_timestamp()+interval '15 minutes','completed',300,0,
    '{"version":1,"nextIndex":0,"batchSize":300}'::jsonb,'source_exhausted' FROM ids;""")
assert sql("SELECT count(*) FROM worker_runs WHERE created_at>=date_trunc('day',clock_timestamp(),'UTC');") == '20'
sql("UPDATE admin_acquisition_control SET desired_state='running',epoch=gen_random_uuid(),continuation_run_id=NULL WHERE id=1;")
epoch = sql('SELECT epoch FROM admin_acquisition_control WHERE id=1;')
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    capped = list(pool.map(lambda _: continuation(quota_parent), range(2)))
assert capped == [None, None]
assert sql('SELECT desired_state FROM admin_acquisition_control WHERE id=1;') == 'stopped'
assert sql("SELECT count(*) FROM worker_runs WHERE created_at>=date_trunc('day',clock_timestamp(),'UTC');") == '20'
assert sql("SELECT enabled FROM admin_acquisition_delivery_control WHERE id=1;") == 'f'
print('PASS: unique 51st migration, rollback/history preservation, 60-minute fresh deadlines, eight sources, mail RPCs, immediate atomic continuation, replay, Stop, empty-work, budget and daily-cap shutdown', flush=True)
