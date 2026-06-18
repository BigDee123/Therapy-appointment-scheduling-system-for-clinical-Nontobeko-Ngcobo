/**
 * Supabase database client
 * Replaces the JSON file store — data now persists permanently.
 */
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('[db] WARNING: SUPABASE_URL or SUPABASE_SERVICE_KEY not set — database will not work');
}

const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

module.exports = supabase;
