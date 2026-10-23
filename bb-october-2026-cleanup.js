'use strict';
const KEY='migration_bb_remove_accidental_requests_2026_10_v1';
async function removeAccidentalOctoberRequests(pool){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7319,2026*12+10]);
  const marker=await db.query("INSERT INTO settings(key,value) VALUES($1,'done') ON CONFLICT(key) DO NOTHING RETURNING key",[KEY]);
  if(marker.rows.length){
   // Explicitly requested one-time removal: keep published BB, canonical shifts and all other months intact.
   await db.query("UPDATE bb_months SET requirements='{}'::jsonb,status='closed',revision=revision+1,updated_at=NOW() WHERE year=2026 AND month=10");
  }
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
module.exports={removeAccidentalOctoberRequests};
