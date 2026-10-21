import {it,expect} from 'vitest';
import pg from 'pg';
import {freshSchema,testDatabaseUrl} from './test-db.js';
it.skipIf(!testDatabaseUrl)('concurrent fresh schemas preserve active same-prefix tables and rows',async()=>{
 const clients:pg.Client[]=[],schemas:string[]=[];
 const owner=new pg.Client({connectionString:testDatabaseUrl});await owner.connect();
 try {
  const urls=await Promise.all([freshSchema('t_schema_isolation'),freshSchema('t_schema_isolation')]);
  for(const url of urls){const c=new pg.Client({connectionString:url});await c.connect();clients.push(c);schemas.push((await c.query('SELECT current_schema() AS s')).rows[0].s);await c.query('CREATE TABLE marker(value text)');await c.query("INSERT INTO marker VALUES('original row')");}
  const third=await freshSchema('t_schema_isolation');const c=new pg.Client({connectionString:third});await c.connect();clients.push(c);schemas.push((await c.query('SELECT current_schema() AS s')).rows[0].s);
  expect(new Set(schemas).size).toBe(3);
  for(const active of clients.slice(0,2)) expect((await active.query('SELECT value FROM marker')).rows).toEqual([{value:'original row'}]);
  await expect(freshSchema('unsafe";DROP')).rejects.toThrow('Invalid test schema prefix');
 }finally{
  await Promise.all(clients.map(c=>c.end()));
  // Exact schema tokens from this test only, never a prefix census/drop.
  for(const schema of schemas)await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
  await owner.end();
 }
});
