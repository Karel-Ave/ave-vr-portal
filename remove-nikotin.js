'use strict';

function parseObject(value) {
  try { const parsed=typeof value==='string'?JSON.parse(value):value;return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:null; } catch { return null; }
}
function cleanPermissions(value) {
  const data=parseObject(value);if(!data)return null;let changed=false;
  if(Object.hasOwn(data,'nikotin')){delete data.nikotin;changed=true;}
  if(data.__defaultApp==='nikotin'){data.__defaultApp='raspis';changed=true;}
  return changed?JSON.stringify(data):null;
}
function cleanPreferences(row) {
  let order=null,views=null;
  try { const data=JSON.parse(row.app_order);if(Array.isArray(data)&&data.includes('nikotin'))order=JSON.stringify(data.filter(app=>app!=='nikotin')); } catch {}
  const data=parseObject(row.default_views);let changed=false;
  if(data)for(const view of Object.values(data))if(view&&typeof view==='object'&&view.app==='nikotin'){view.app='raspis';changed=true;}
  if(changed)views=JSON.stringify(data);
  return {order,views};
}
async function removeNikotin(pool) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    // Intentionally no CASCADE: never remove another module's dependent objects.
    await db.query('DROP TABLE IF EXISTS nikotin_days');
    await db.query('DROP TABLE IF EXISTS nikotin_plans');
    const users=await db.query("SELECT id,perm_overrides FROM users WHERE perm_overrides LIKE '%nikotin%' FOR UPDATE");
    for(const row of users.rows){const value=cleanPermissions(row.perm_overrides);if(value!==null)await db.query('UPDATE users SET perm_overrides=$1 WHERE id=$2',[value,row.id]);}
    const groups=await db.query("SELECT name,perms FROM permission_groups WHERE perms LIKE '%nikotin%' FOR UPDATE");
    for(const row of groups.rows){const value=cleanPermissions(row.perms);if(value!==null)await db.query('UPDATE permission_groups SET perms=$1 WHERE name=$2',[value,row.name]);}
    const prefs=await db.query("SELECT user_id,app_order,default_views FROM user_preferences WHERE app_order LIKE '%nikotin%' OR default_views LIKE '%nikotin%' FOR UPDATE");
    for(const row of prefs.rows){const {order,views}=cleanPreferences(row);if(order!==null)await db.query('UPDATE user_preferences SET app_order=$1 WHERE user_id=$2',[order,row.user_id]);if(views!==null)await db.query('UPDATE user_preferences SET default_views=$1 WHERE user_id=$2',[views,row.user_id]);}
    await db.query('COMMIT');
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
module.exports={removeNikotin,cleanPermissions,cleanPreferences};
