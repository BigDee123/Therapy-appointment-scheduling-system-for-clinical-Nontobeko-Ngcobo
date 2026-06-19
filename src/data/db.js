/**
 * Supabase database client
 * Supports both legacy service_role keys (eyJ...) and new secret keys (sb_secret_...)
 */
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('[db] WARNING: SUPABASE_URL or SUPABASE_SERVICE_KEY not set');
}

const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession:   false,
      },
      global: {
        headers: {
          // Required for new sb_secret_ style keys
          'apikey': supabaseKey,
        },
      },
    })
  : null;

module.exports = supabase;
